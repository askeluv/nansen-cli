/**
 * Nansen CLI — Hyperliquid perpetual trading commands.
 * Calls nansen-api /api/v1/perp/* endpoints.
 * Signing uses existing EIP-712 infrastructure (hashTypedData + signSecp256k1).
 */

import { signSecp256k1 } from './crypto.js';
import { retrievePassword } from './keychain.js';
import { exportWallet, getWalletConfig, showWallet } from './wallet.js';
import { hashTypedData } from './x402-evm.js';

// ── EIP-712 signing ──────────────────────────────────────────────────

function signAgent(eip712, privateKeyHex) {
  const { domain, types, primaryType, message } = eip712;
  const fields = (types[primaryType] || []).map(f => ({ name: f.name, type: f.type }));
  const msgHash = hashTypedData(domain, primaryType, fields, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  return {
    r: '0x' + r.toString('hex'),
    s: '0x' + s.toString('hex'),
    v: 27 + v,
  };
}

// ── API helpers ──────────────────────────────────────────────────────

async function perpPrepare(apiInstance, endpoint, body) {
  return apiInstance.request(`/api/v1/perp/${endpoint}`, body);
}

async function perpExecute(apiInstance, { action, nonce, signature, vaultAddress }) {
  return apiInstance.request('/api/v1/perp/execute', {
    action,
    nonce,
    signature,
    vault_address: vaultAddress || null,
  });
}

async function perpRead(apiInstance, endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  return apiInstance.request(`/api/v1/perp/${endpoint}?${qs}`, {}, { method: 'GET' });
}

// ── Wallet helpers ───────────────────────────────────────────────────

function resolveWalletAddress(walletName) {
  let wallet;
  if (walletName) {
    wallet = showWallet(walletName);
  } else {
    const config = getWalletConfig();
    if (config.defaultWallet) wallet = showWallet(config.defaultWallet);
  }
  if (!wallet) throw new Error('No wallet found. Create one with: nansen wallet create');
  if (!wallet.evm || !/^0x[0-9a-fA-F]{40}$/.test(wallet.evm)) {
    throw new Error(
      `Wallet "${wallet.name || walletName || 'default'}" has no valid EVM address. Hyperliquid perp trading requires an EVM wallet.`,
    );
  }
  return {
    address: wallet.evm,
    provider: wallet.provider || 'local',
    privyWalletIds: wallet.privyWalletIds || null,
  };
}

function resolvePrivateKey(walletName) {
  const config = getWalletConfig();
  let password = null;
  if (config.passwordHash) {
    const { password: pw, source } = retrievePassword();
    if (source === 'file') {
      process.stderr.write('⚠️  Password loaded from ~/.nansen/wallets/.credentials (insecure).\n');
    }
    password = pw;
  }
  const name = walletName || config.defaultWallet;
  if (!name) throw new Error('No wallet found. Create one with: nansen wallet create');
  const exported = exportWallet(name, password);
  return exported.evm.privateKey;
}

// ── Prepare + sign + execute flow ────────────────────────────────────

async function prepareSignExecute(apiInstance, endpoint, body, { privateKeyHex, privyClient, privyWalletId, log }) {
  log(`  Preparing ${endpoint}...`);
  const prepared = await perpPrepare(apiInstance, endpoint, body);

  let signature;
  if (privyClient && privyWalletId) {
    log('  Signing via Privy...');
    const result = await privyClient.ethSignTypedDataV4(privyWalletId, prepared.eip712);
    const sig = result.data?.signature || result.signature || result;
    const rHex = sig.slice(2, 66);
    const sHex = sig.slice(66, 130);
    const vHex = sig.slice(130, 132);
    signature = { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) };
  } else {
    log('  Signing...');
    signature = signAgent(prepared.eip712, privateKeyHex);
  }

  log('  Executing...');
  const result = await perpExecute(apiInstance, {
    action: prepared.action,
    nonce: prepared.nonce,
    signature,
    vaultAddress: prepared.vault_address,
  });

  if (result.status === 'err') {
    throw new Error(`Hyperliquid error: ${result.response || 'unknown'}`);
  }

  log(`  Status: ${result.status}`);
  if (result.response) {
    const resp = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
    log(`  Response: ${resp}`);
  }
  return result;
}

// ── Input validation ─────────────────────────────────────────────────
//
// The perp path coerces strings to booleans (side -> is_buy, margin-type ->
// is_cross) before anything reaches the backend, so a typo can't be caught
// server-side — it silently flips to the false branch (short / isolated).
// Validate against explicit allowlists, and reject non-positive/non-finite
// numerics, before signing anything.

const ORDER_SIDES = new Set(['buy', 'long', 'sell', 'short']);
const CLOSE_SIDES = new Set(['buy', 'sell']);
const MARGIN_TYPES = new Set(['cross', 'isolated']);

function assertSide(raw, allowed) {
  const side = (raw || '').toLowerCase();
  if (!allowed.has(side)) {
    throw new Error(
      `Invalid --side "${raw}". Must be one of: ${[...allowed].join(', ')}.`,
    );
  }
  return side;
}

function assertMarginType(raw) {
  // --margin-type is optional and defaults to cross when omitted.
  if (raw === undefined) return 'cross';
  const marginType = String(raw).toLowerCase();
  if (!MARGIN_TYPES.has(marginType)) {
    throw new Error(
      `Invalid --margin-type "${raw}". Must be one of: ${[...MARGIN_TYPES].join(', ')}.`,
    );
  }
  return marginType;
}

function parsePositiveNumber(raw, name) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --${name} "${raw}". Must be a positive number.`);
  }
  return n;
}

function parsePositiveInt(raw, name) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --${name} "${raw}". Must be a positive integer.`);
  }
  return n;
}

// ── Command builder ──────────────────────────────────────────────────

export function buildPerpCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'order': async (args, apiInstance, flags, options) => {
      const coin = (options.coin || '').toUpperCase();
      const orderType = options.type || 'limit';
      const slippage = options.slippage ? parseFloat(options.slippage) : 0.03;
      const tp = options['take-profit'] ? parseFloat(options['take-profit']) : undefined;
      const sl = options['stop-loss'] ? parseFloat(options['stop-loss']) : undefined;
      const tif = options.tif || 'Gtc';
      const walletName = options.wallet;

      if (!coin || !options.side || options.size === undefined || options.price === undefined) {
        throw new Error(
`Usage: nansen perp order --coin <symbol> --side <buy|sell> --size <amount> --price <price> [options]

OPTIONS:
  --coin          Asset symbol (BTC, ETH, etc.)
  --side          buy (long) or sell (short)
  --size          Position size in base asset units
  --price         Limit price (or mark price for market orders)
  --type          Order type: limit (default) or market
  --tif           Time-in-force: Gtc (default), Ioc, Alo
  --slippage      Slippage for market orders (default 0.03 = 3%)
  --take-profit   Take-profit trigger price
  --stop-loss     Stop-loss trigger price
  --wallet        Wallet name`);
      }

      const side = assertSide(options.side, ORDER_SIDES);
      const size = parsePositiveNumber(options.size, 'size');
      const price = parsePositiveNumber(options.price, 'price');
      const isBuy = side === 'buy' || side === 'long';
      const wallet = resolveWalletAddress(walletName);
      const isPrivy = wallet.provider === 'privy';

      let privateKeyHex = null;
      let privyClient = null;
      let privyWalletId = null;

      if (isPrivy) {
        const { PrivyClient } = await import('./privy.js');
        privyClient = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
        privyWalletId = wallet.privyWalletIds?.evm;
      } else {
        privateKeyHex = resolvePrivateKey(walletName);
      }

      log(`\n  Perp Order: ${coin} ${isBuy ? 'LONG' : 'SHORT'} ${size} @ ${price} (${orderType})`);

      const body = {
        wallet_address: wallet.address,
        coin,
        is_buy: isBuy,
        size,
        price,
        order_type: orderType,
        tif,
        slippage,
        reduce_only: false,
        ...(tp !== undefined && { take_profit: tp }),
        ...(sl !== undefined && { stop_loss: sl }),
      };

      await prepareSignExecute(apiInstance, 'order', body, { privateKeyHex, privyClient, privyWalletId, log });
      log('');
      return undefined;
    },

    'cancel': async (args, apiInstance, flags, options) => {
      const coin = (options.coin || '').toUpperCase();
      const walletName = options.wallet;

      if (!coin || options.oid === undefined) {
        throw new Error('Usage: nansen perp cancel --coin <symbol> --oid <orderId> [--wallet <name>]');
      }

      const oid = parsePositiveInt(options.oid, 'oid');

      const wallet = resolveWalletAddress(walletName);
      const privateKeyHex = wallet.provider !== 'privy' ? resolvePrivateKey(walletName) : null;

      log(`\n  Cancel: ${coin} order #${oid}`);

      await prepareSignExecute(apiInstance, 'cancel', {
        wallet_address: wallet.address,
        coin,
        order_id: oid,
      }, { privateKeyHex, log });
      log('');
      return undefined;
    },

    'close': async (args, apiInstance, flags, options) => {
      const coin = (options.coin || '').toUpperCase();
      const slippage = options.slippage ? parseFloat(options.slippage) : 0.03;
      const walletName = options.wallet;

      if (!coin || options.size === undefined || options.price === undefined || !options.side) {
        throw new Error(
`Usage: nansen perp close --coin <symbol> --size <amount> --price <markPrice> --side <buy|sell> [options]

  --side    buy (closing a short) or sell (closing a long)
  --slippage  Slippage tolerance (default 0.03 = 3%)`);
      }

      const side = assertSide(options.side, CLOSE_SIDES);
      const size = parsePositiveNumber(options.size, 'size');
      const price = parsePositiveNumber(options.price, 'price');
      const isBuy = side === 'buy';
      const wallet = resolveWalletAddress(walletName);
      const privateKeyHex = wallet.provider !== 'privy' ? resolvePrivateKey(walletName) : null;

      log(`\n  Close: ${coin} ${isBuy ? 'buy-to-close' : 'sell-to-close'} ${size} @ ${price}`);

      await prepareSignExecute(apiInstance, 'close', {
        wallet_address: wallet.address,
        coin,
        size,
        price,
        is_buy: isBuy,
        slippage,
      }, { privateKeyHex, log });
      log('');
      return undefined;
    },

    'leverage': async (args, apiInstance, flags, options) => {
      const coin = (options.coin || '').toUpperCase();
      const walletName = options.wallet;

      if (!coin || options.leverage === undefined) {
        throw new Error('Usage: nansen perp leverage --coin <symbol> --leverage <n> [--margin-type cross|isolated] [--wallet <name>]');
      }

      const marginType = assertMarginType(options['margin-type']);
      const leverage = parsePositiveInt(options.leverage, 'leverage');
      const isCross = marginType === 'cross';
      const wallet = resolveWalletAddress(walletName);
      const privateKeyHex = wallet.provider !== 'privy' ? resolvePrivateKey(walletName) : null;

      log(`\n  Leverage: ${coin} ${leverage}x ${isCross ? 'cross' : 'isolated'}`);

      await prepareSignExecute(apiInstance, 'leverage', {
        wallet_address: wallet.address,
        coin,
        leverage,
        is_cross: isCross,
      }, { privateKeyHex, log });
      log('');
      return undefined;
    },

    'positions': async (args, apiInstance, flags, options) => {
      const walletName = options.wallet;
      const wallet = resolveWalletAddress(walletName);

      const result = await perpRead(apiInstance, 'positions', { wallet_address: wallet.address });
      const positions = result.positions || [];

      if (!positions.length) {
        log('\n  No open positions\n');
        return undefined;
      }

      log(`\n  Open Positions (${positions.length}):`);
      for (const p of positions) {
        const side = parseFloat(p.szi) >= 0 ? 'LONG' : 'SHORT';
        log(`    ${p.coin} ${side} size=${p.szi} entry=${p.entryPx} pnl=${p.unrealizedPnl} liq=${p.liquidationPx || 'n/a'}`);
      }
      log('');
      return undefined;
    },

    'orders': async (args, apiInstance, flags, options) => {
      const walletName = options.wallet;
      const wallet = resolveWalletAddress(walletName);

      const result = await perpRead(apiInstance, 'orders', { wallet_address: wallet.address });
      const orders = result.orders || [];

      if (!orders.length) {
        log('\n  No open orders\n');
        return undefined;
      }

      log(`\n  Open Orders (${orders.length}):`);
      for (const o of orders) {
        log(`    ${o.coin} ${o.side} size=${o.sz} price=${o.limitPx} oid=${o.oid}`);
      }
      log('');
      return undefined;
    },

    'account': async (args, apiInstance, flags, options) => {
      const walletName = options.wallet;
      const wallet = resolveWalletAddress(walletName);

      const result = await perpRead(apiInstance, 'account', { wallet_address: wallet.address });
      const ms = result.marginSummary || {};

      log(`\n  Hyperliquid Account: ${wallet.address}`);
      log(`    Account Value:  $${ms.accountValue || '0'}`);
      log(`    Total PnL:      $${ms.totalRawUsd || '0'}`);
      log(`    Margin Used:    $${ms.totalMarginUsed || '0'}`);
      log(`    Withdrawable:   $${result.withdrawable || '0'}`);
      log('');
      return undefined;
    },

    'meta': async (args, apiInstance, flags, options) => {
      const result = await perpRead(apiInstance, 'meta', {});
      let assets = result.assets || [];

      const filter = (options.filter || '').toUpperCase();
      if (filter) {
        assets = assets.filter(a => String(a.name).toUpperCase().includes(filter));
      }
      // Default to a preview; --all or --filter shows the full (matching) set so
      // assets past the first 20 (e.g. HYPE) are reachable from the CLI.
      const showAll = flags.all || !!filter;
      const shown = showAll ? assets : assets.slice(0, 20);

      const heading = filter ? ` matching "${options.filter}"` : '';
      log(`\n  Hyperliquid Perp Assets (${assets.length}${heading}):`);
      log('    ID   Name         Size Dec   Max Lev');
      for (const a of shown) {
        const id = String(a.asset_id).padStart(4);
        const name = a.name.padEnd(12);
        const szDec = String(a.sz_decimals).padStart(8);
        const maxLev = String(a.max_leverage).padStart(9);
        log(`    ${id} ${name} ${szDec} ${maxLev}`);
      }
      if (!showAll && assets.length > 20) {
        log(`    ... and ${assets.length - 20} more (use --all, or --filter <text>)`);
      }
      log('');
      return undefined;
    },
  };
}
