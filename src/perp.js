/**
 * Nansen CLI — Hyperliquid perpetual trading commands.
 * Calls nansen-api /api/v1/perp/* endpoints.
 * Signing uses existing EIP-712 infrastructure (hashTypedData + signSecp256k1).
 */

import { CommandError } from './api.js';
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
    // Distinguish "no password configured" from "wrong password": without this,
    // exportWallet(name, null) fails with the misleading "Incorrect password"
    // even though nothing was entered. Mirror trade/limit-order's PASSWORD_REQUIRED.
    if (!password) {
      throw new CommandError('Wallet is encrypted and no password was found.', 'PASSWORD_REQUIRED', {
        error: 'PASSWORD_REQUIRED',
        message: 'Wallet is encrypted and no password was found.',
        resolution: [
          'Set NANSEN_WALLET_PASSWORD environment variable',
          'Or run: nansen wallet create (password is saved to OS keychain automatically)',
        ],
      });
    }
  }
  const name = walletName || config.defaultWallet;
  if (!name) throw new CommandError('No wallet found. Create one with: nansen wallet create', 'NO_WALLET');
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
//
// All guards throw a coded CommandError ('INVALID_INPUT') rather than a bare
// Error, so agents can branch on the error code instead of string-matching.

const ORDER_SIDES = new Set(['buy', 'long', 'sell', 'short']);
const CLOSE_SIDES = new Set(['buy', 'sell']);
const MARGIN_TYPES = new Set(['cross', 'isolated']);
// Case-insensitive input -> canonical value the backend expects. Hyperliquid
// is case-sensitive (Gtc not gtc, limit not LIMIT), so normalise here rather
// than forwarding the raw string and letting the backend reject it.
const TIF_VALUES = new Map([['gtc', 'Gtc'], ['ioc', 'Ioc'], ['alo', 'Alo']]);
const ORDER_TYPES = new Map([['limit', 'limit'], ['market', 'market']]);

function invalid(message) {
  return new CommandError(message, 'INVALID_INPUT');
}

// The arg parser collects a repeated flag into an array (to support genuinely
// repeatable flags elsewhere). Perp flags are never repeatable, so reject the
// array with a clear message instead of crashing in a string guard or silently
// using the first element.
function scalar(raw, name) {
  if (Array.isArray(raw)) {
    throw invalid(`--${name} was provided more than once. Pass --${name} exactly once.`);
  }
  return raw;
}

function assertSide(raw, allowed) {
  const side = String(scalar(raw, 'side') ?? '').toLowerCase();
  if (!allowed.has(side)) {
    throw invalid(`Invalid --side "${raw}". Must be one of: ${[...allowed].join(', ')}.`);
  }
  return side;
}

function assertMarginType(raw) {
  // --margin-type is optional and defaults to cross when omitted.
  if (raw === undefined) return 'cross';
  const marginType = String(scalar(raw, 'margin-type') ?? '').toLowerCase();
  if (!MARGIN_TYPES.has(marginType)) {
    throw invalid(`Invalid --margin-type "${raw}". Must be one of: ${[...MARGIN_TYPES].join(', ')}.`);
  }
  return marginType;
}

function parsePositiveNumber(raw, name) {
  // Strict numeric check before parseFloat — parseFloat("100abc") returns 100,
  // so trailing garbage would otherwise slip through and only fail at the backend.
  const s = String(scalar(raw, name) ?? '').trim();
  if (!/^\d*\.?\d+$/.test(s)) {
    throw invalid(`Invalid --${name} "${raw}". Must be a positive number.`);
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw invalid(`Invalid --${name} "${raw}". Must be a positive number.`);
  }
  return n;
}

function parsePositiveInt(raw, name) {
  // Digits-only check before parseInt — parseInt("2.5") floors to 2 and
  // parseInt("123abc") yields 123, so a fractional or garbage value would
  // otherwise be silently accepted.
  const s = String(scalar(raw, name) ?? '').trim();
  if (!/^\d+$/.test(s)) {
    throw invalid(`Invalid --${name} "${raw}". Must be a positive integer.`);
  }
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw invalid(`Invalid --${name} "${raw}". Must be a positive integer.`);
  }
  return n;
}

function parseSlippage(raw) {
  // Slippage is a decimal fraction in [0, 1] (0.03 = 3%). Reject trailing
  // garbage (parseFloat would accept "0.03abc") and percent-vs-decimal
  // mix-ups (e.g. "3" meaning 3% would otherwise be a 300% tolerance).
  const s = String(scalar(raw, 'slippage') ?? '').trim();
  const n = /^\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw invalid(`Invalid --slippage "${raw}". Use a decimal between 0 and 1 (e.g. 0.03 for 3%).`);
  }
  return n;
}

function assertTif(raw) {
  // --tif is optional and defaults to Gtc when omitted.
  if (raw === undefined) return 'Gtc';
  const tif = TIF_VALUES.get(String(scalar(raw, 'tif') ?? '').toLowerCase());
  if (!tif) {
    throw invalid(`Invalid --tif "${raw}". Must be one of: Gtc, Ioc, Alo.`);
  }
  return tif;
}

function assertOrderType(raw) {
  // --type is optional and defaults to limit when omitted.
  if (raw === undefined) return 'limit';
  const type = ORDER_TYPES.get(String(scalar(raw, 'type') ?? '').toLowerCase());
  if (!type) {
    throw invalid(`Invalid --type "${raw}". Must be one of: limit, market.`);
  }
  return type;
}

// Resolve the asset symbol from --coin (or its --symbol alias), rejecting a
// duplicated flag. Returns the upper-cased symbol, or '' when neither is set.
function resolveCoin(options) {
  const raw = scalar(options.coin, 'coin') ?? scalar(options.symbol, 'symbol');
  return String(raw ?? '').toUpperCase();
}

// ── Command builder ──────────────────────────────────────────────────

export function buildPerpCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'order': async (args, apiInstance, flags, options) => {
      const coin = resolveCoin(options);
      const walletName = scalar(options.wallet, 'wallet');

      if (!coin || !options.side || options.size === undefined || options.price === undefined) {
        throw new CommandError(
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
  --wallet        Wallet name`, 'MISSING_PARAM');
      }

      const side = assertSide(options.side, ORDER_SIDES);
      const orderType = assertOrderType(options.type);
      const tif = assertTif(options.tif);
      const size = parsePositiveNumber(options.size, 'size');
      const price = parsePositiveNumber(options.price, 'price');
      const slippage = options.slippage !== undefined ? parseSlippage(options.slippage) : 0.03;
      const tp = options['take-profit'] !== undefined ? parsePositiveNumber(options['take-profit'], 'take-profit') : undefined;
      const sl = options['stop-loss'] !== undefined ? parsePositiveNumber(options['stop-loss'], 'stop-loss') : undefined;
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
      const coin = resolveCoin(options);
      const walletName = scalar(options.wallet, 'wallet');

      if (!coin || options.oid === undefined) {
        throw new CommandError('Usage: nansen perp cancel --coin <symbol> --oid <orderId> [--wallet <name>]', 'MISSING_PARAM');
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
      const coin = resolveCoin(options);
      const walletName = scalar(options.wallet, 'wallet');

      if (!coin || options.size === undefined || options.price === undefined || !options.side) {
        throw new CommandError(
`Usage: nansen perp close --coin <symbol> --size <amount> --price <markPrice> --side <buy|sell> [options]

  --side    buy (closing a short) or sell (closing a long)
  --slippage  Slippage tolerance (default 0.03 = 3%)`, 'MISSING_PARAM');
      }

      const side = assertSide(options.side, CLOSE_SIDES);
      const size = parsePositiveNumber(options.size, 'size');
      const price = parsePositiveNumber(options.price, 'price');
      const slippage = options.slippage !== undefined ? parseSlippage(options.slippage) : 0.03;
      const isBuy = side === 'buy';
      const wallet = resolveWalletAddress(walletName);

      // Validate the close direction against the open position so a wrong --side
      // fails fast with a clear message instead of the backend's opaque "reduce
      // only order would increase position". sell closes a long, buy closes a
      // short. Fall open if positions can't be fetched — the backend still checks.
      let openPositions = null;
      try {
        const result = await perpRead(apiInstance, 'positions', { wallet_address: wallet.address });
        openPositions = result.positions || [];
      } catch {
        // positions lookup failed — skip the direction pre-check.
      }
      if (openPositions) {
        const pos = openPositions.find(p => String(p.coin).toUpperCase() === coin);
        const szi = pos ? parseFloat(pos.szi) : NaN;
        if (Number.isFinite(szi) && szi !== 0) {
          const requiredSide = szi > 0 ? 'sell' : 'buy';
          if (side !== requiredSide) {
            const posSide = szi > 0 ? 'long' : 'short';
            throw invalid(
              `Cannot close a ${posSide} ${coin} position with --side ${side}. Use --side ${requiredSide} (sell closes a long, buy closes a short).`,
            );
          }
        }
      }

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
      const coin = resolveCoin(options);
      const walletName = scalar(options.wallet, 'wallet');

      if (!coin || options.leverage === undefined) {
        throw new CommandError('Usage: nansen perp leverage --coin <symbol> --leverage <n> [--margin-type cross|isolated] [--wallet <name>]', 'MISSING_PARAM');
      }

      const marginType = assertMarginType(options['margin-type']);
      const leverage = parsePositiveInt(options.leverage, 'leverage');

      // Pre-validate against the asset's max leverage so an over-max value fails
      // fast with a clear message instead of an opaque backend rejection. Fall
      // open if meta is unavailable or the coin isn't listed (backend still checks).
      let maxLeverage = null;
      try {
        const meta = await perpRead(apiInstance, 'meta', {});
        const asset = (meta.assets || []).find(a => String(a.name).toUpperCase() === coin);
        if (asset && Number.isFinite(asset.max_leverage)) maxLeverage = asset.max_leverage;
      } catch {
        // meta lookup failed — skip the pre-check rather than block a valid request.
      }
      if (maxLeverage !== null && leverage > maxLeverage) {
        throw invalid(`Leverage ${leverage}x exceeds the ${maxLeverage}x maximum for ${coin}.`);
      }

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

    'transfer': async (args, apiInstance, flags, options) => {
      const direction = scalar(options.direction, 'direction');
      const walletName = scalar(options.wallet, 'wallet');

      if (!direction || options.amount === undefined) {
        throw new CommandError(
          'Usage: nansen perp transfer --direction <spot-to-perp|perp-to-spot> --amount <usdc> [--wallet <name>]',
          'MISSING_PARAM',
        );
      }

      // Move USDC between the wallet's Spot and Perps balances (usdClassTransfer).
      const DIRECTIONS = new Map([['spot-to-perp', true], ['perp-to-spot', false]]);
      const toPerp = DIRECTIONS.get(String(direction).toLowerCase());
      if (toPerp === undefined) {
        throw invalid(`Invalid --direction "${direction}". Must be one of: spot-to-perp, perp-to-spot.`);
      }
      const amount = parsePositiveNumber(options.amount, 'amount');

      const wallet = resolveWalletAddress(walletName);
      const privateKeyHex = wallet.provider !== 'privy' ? resolvePrivateKey(walletName) : null;

      log(`\n  Transfer: ${amount} USDC ${toPerp ? 'Spot → Perps' : 'Perps → Spot'}`);

      await prepareSignExecute(apiInstance, 'transfer', {
        wallet_address: wallet.address,
        amount,
        to_perp: toPerp,
      }, { privateKeyHex, log });
      log('');
      return undefined;
    },

    'positions': async (args, apiInstance, flags, options) => {
      const walletName = scalar(options.wallet, 'wallet');
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
      const walletName = scalar(options.wallet, 'wallet');
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
      const walletName = scalar(options.wallet, 'wallet');
      const wallet = resolveWalletAddress(walletName);

      const result = await perpRead(apiInstance, 'account', { wallet_address: wallet.address });
      const ms = result.marginSummary || {};

      // Sum per-position unrealized PnL. marginSummary.totalRawUsd is the account's
      // total raw USD (≈ collateral / account value), NOT profit-and-loss — labeling
      // it "Total PnL" made it read identical to account value (ECINT-6828).
      const unrealizedPnl = (result.assetPositions || []).reduce(
        (sum, p) => sum + (parseFloat(p.position?.unrealizedPnl) || 0),
        0,
      );

      log(`\n  Hyperliquid Account: ${wallet.address}`);
      log(`    Account Value:   $${ms.accountValue || '0'}`);
      log(`    Unrealized PnL:  $${unrealizedPnl.toFixed(2)}`);
      log(`    Margin Used:     $${ms.totalMarginUsed || '0'}`);
      log(`    Withdrawable:    $${result.withdrawable || '0'}`);
      // Spot balance is separate from Perps: USDC sent via Hyperliquid "Send"
      // lands here and can't be traded until moved with `perp transfer`.
      log(`    Spot USDC:       $${result.spotUsdc ?? 'n/a'}`);
      log('');
      return undefined;
    },

    'meta': async (args, apiInstance, flags, options) => {
      const result = await perpRead(apiInstance, 'meta', {});
      let assets = result.assets || [];

      const filter = String(scalar(options.filter, 'filter') ?? '').toUpperCase();
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
