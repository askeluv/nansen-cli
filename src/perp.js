/**
 * Nansen CLI — Hyperliquid perpetual trading commands.
 *
 * Mutating commands (order/cancel/close/leverage/transfer) build the HL action
 * locally (hl-action.js), screen the signing wallet against the live SDN list,
 * sign with existing EIP-712 infrastructure, and submit straight to
 * api.hyperliquid.xyz (hl-client.js) — the Nansen API is out of the order path.
 * Reads (positions/orders/account/meta) and the builder-fee status still go
 * through the proxy /api/v1/perp/* endpoints (Decision D4).
 */

import { CommandError } from './api.js';
import { signSecp256k1 } from './crypto.js';
import {
  buildApproveBuilderFeeAction,
  buildCancelAction,
  buildCloseAction,
  buildLeverageAction,
  buildOrderAction,
  buildUsdClassTransferAction,
  l1Eip712,
  userSignedEip712,
} from './hl-action.js';
import { submitExchange } from './hl-client.js';
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

// ── Proxy read helpers (Decision D4: reads stay on the API) ───────────

async function perpRead(apiInstance, endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  return apiInstance.request(`/api/v1/perp/${endpoint}?${qs}`, {}, { method: 'GET' });
}

// Resolve an asset's id + szDecimals (+ maxLeverage) from the proxy /perp/meta.
// Fail OPEN to null: a meta outage must not preempt a clearer earlier error
// (missing wallet, wrong password) — callers that need it to build an action
// re-check for null and abort at that point (see requireAsset).
async function fetchAssetMeta(apiInstance, coin) {
  try {
    const meta = await perpRead(apiInstance, 'meta', {});
    const asset = (meta.assets || []).find(a => String(a.name).toUpperCase() === coin);
    if (asset && Number.isInteger(asset.asset_id) && Number.isInteger(asset.sz_decimals)) {
      return { assetId: asset.asset_id, szDecimals: asset.sz_decimals, maxLeverage: asset.max_leverage };
    }
  } catch {
    // meta lookup failed — treat as unavailable; caller decides whether to abort.
  }
  return null;
}

// An action builder needs the asset metadata; without it we cannot construct a
// correct wire, so abort (fail closed) rather than guessing. The message
// deliberately omits any upstream error text so it can't be confused with the
// advisory pre-checks that fall open on the same outage.
function requireAsset(assetMeta, coin) {
  if (!assetMeta) {
    throw new CommandError(
      `Could not load Hyperliquid asset metadata for ${coin}; not trading.`,
      'META_UNAVAILABLE',
    );
  }
  return assetMeta;
}

// Fetch the builder-fee status + code from the proxy (single source of truth,
// Decision D1): { approved, max_fee_rate, required_fee, builder_address }. One
// call yields both the {b,f} attached to every order/close and the approval
// gate. Fail closed — this endpoint shares availability with screening, so if
// it's down we abort rather than trade without the builder code.
async function fetchBuilderFee(apiInstance, walletAddress) {
  const qs = new URLSearchParams({ wallet_address: walletAddress }).toString();
  let status;
  try {
    status = await apiInstance.request(`/api/v1/perp/builder-fee?${qs}`, {}, { method: 'GET' });
  } catch (err) {
    throw new CommandError(
      `Could not resolve the Hyperliquid builder fee, so the trade was not submitted: ${err.message}`,
      'BUILDER_FEE_UNAVAILABLE',
    );
  }
  if (!status || !status.builder_address || !Number.isInteger(status.required_fee)) {
    throw new CommandError(
      'Builder-fee status response was malformed, so the trade was not submitted.',
      'BUILDER_FEE_UNAVAILABLE',
    );
  }
  return status;
}

// The {b,f} builder code attached to order/close actions. `b` is lowercased (HL
// requirement); `f` is the fee in tenths of a basis point.
function builderCode(status) {
  return { b: String(status.builder_address).toLowerCase(), f: status.required_fee };
}

// maxFeeRate string signed in approveBuilderFee, derived from the per-order fee
// so the two can't drift — mirrors the API's config.hl_builder_max_fee_rate
// (80 tenths-of-a-bp -> "0.08%").
function builderMaxFeeRate(requiredFee) {
  const percent = requiredFee / 1000;
  return percent.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%';
}

// HL nonce: current time in milliseconds. Must be recent and strictly
// increasing per account; Date.now() satisfies both for a single command.
function hlNonce() {
  return Date.now();
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

// The size/price a perp order will actually execute at, post-rounding. The
// backend echoes them as explicit `size`/`price`; fall back to the signed order
// wire ("s"/"p") for an older backend that omits them. Returns undefined for
// actions with no order (cancel/leverage/transfer), so callers can skip the line.
export function effectiveOrderValues(prepared) {
  const order0 = prepared?.action?.orders?.[0];
  const size = prepared?.size ?? (order0?.s !== undefined ? Number(order0.s) : undefined);
  const price = prepared?.price ?? (order0?.p !== undefined ? Number(order0.p) : undefined);
  return { size, price };
}

// ── Screening (Chunk 4) ──────────────────────────────────────────────
//
// Per-trade OFAC screening against the live SDN list. This is the compliance
// checkpoint that lets the CLI submit directly to HL: every mutating action
// re-screens the signing wallet before it is signed. Fail CLOSED — a sanctioned
// hit, a non-200 (503 = SDN snapshot unavailable), a network error, or a
// response that doesn't cover every requested address all abort the trade
// before signing, never trade through.

async function screenOrThrow(apiInstance, addresses) {
  let result;
  try {
    result = await apiInstance.request('/api/v1/sanctions/screen', { addresses });
  } catch (err) {
    throw new CommandError(
      `Compliance screening is unavailable, so the trade was not submitted: ${err.message}`,
      'SCREENING_UNAVAILABLE',
    );
  }

  const results = Array.isArray(result?.results) ? result.results : [];
  const sanctioned = results.filter(r => r && r.sanctioned).map(r => r.address);
  if (sanctioned.length > 0) {
    throw new CommandError(
      `Wallet address is on the compliance blocklist and cannot trade: ${sanctioned.join(', ')}`,
      'SANCTIONED',
    );
  }

  // A 200 that omitted a requested address is unverifiable — fail closed rather
  // than assume the missing address is clean.
  const screened = new Set(results.map(r => String(r.address).toLowerCase()));
  const missing = addresses.filter(a => !screened.has(String(a).toLowerCase()));
  if (missing.length > 0) {
    throw new CommandError(
      `Compliance screening did not cover all addresses, so the trade was not submitted: ${missing.join(', ')}`,
      'SCREENING_UNAVAILABLE',
    );
  }
}

// ── Sign + direct submit ─────────────────────────────────────────────

// Sign an EIP-712 payload with the local wallet key or via Privy. Returns the
// {r,s,v} object submitExchange expects. Works for both L1 (phantom-agent) and
// user-signed payloads — the field list comes from the payload's own types.
async function signHlAction(eip712, { privateKeyHex, privyClient, privyWalletId, log }) {
  if (privyClient && privyWalletId) {
    log('  Signing via Privy...');
    const result = await privyClient.ethSignTypedDataV4(privyWalletId, eip712);
    const sig = result.data?.signature || result.signature || result;
    return {
      r: '0x' + sig.slice(2, 66),
      s: '0x' + sig.slice(66, 130),
      v: parseInt(sig.slice(130, 132), 16),
    };
  }
  log('  Signing...');
  return signAgent(eip712, privateKeyHex);
}

// The direct-to-HL flow that replaces prepareSignExecute: screen the signing
// wallet against the live SDN list (Chunk 4), sign the locally-built action,
// and submit straight to api.hyperliquid.xyz (Chunk 2). `prepared` is
// { action, nonce, eip712, size?, price? } from an hl-action.js builder; the
// vault is always null for a normal wallet (the CLI signs L1 actions with the
// wallet key directly). submitExchange throws on any HL rejection.
async function buildScreenSignSubmit(apiInstance, prepared, ctx) {
  const { action, nonce, eip712, size, price } = prepared;
  const { walletAddress, log } = ctx;

  log('  Screening...');
  await screenOrThrow(apiInstance, [walletAddress]);

  // Report the values actually encoded in the signed action (rounded size,
  // slippage-adjusted market price), not the raw input, so we don't misreport
  // the fill.
  if (size !== undefined && price !== undefined) {
    log(`  Submitting: ${size} @ ${price}`);
  }

  const signature = await signHlAction(eip712, ctx);

  log('  Submitting to Hyperliquid...');
  const result = await submitExchange({ action, nonce, signature, vaultAddress: null });

  const status = result.status ?? 'ok';
  log(`  Status: ${status}`);
  if (result.response) {
    const resp = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
    log(`  Response: ${resp}`);
  }
  return result;
}

// ── Builder-fee onboarding (Chunk 5) ─────────────────────────────────
//
// HL silently rejects orders carrying our builder code until the master wallet
// has approved a matching maxFeeRate. Auto-fire the one-time approval before the
// first order/close; skip when already approved. The approval is a user-signed
// action signed by the same wallet key, and is screened like any other.
async function ensureBuilderApproved(apiInstance, status, ctx) {
  if (status.approved) return;
  ctx.log('  Approving Nansen builder fee (one-time)...');
  const nonce = hlNonce();
  const { action, primaryType, signTypes } = buildApproveBuilderFeeAction({
    maxFeeRate: builderMaxFeeRate(status.required_fee),
    builder: String(status.builder_address).toLowerCase(),
    nonce,
  });
  const eip712 = userSignedEip712(primaryType, signTypes, action);
  await buildScreenSignSubmit(apiInstance, { action, nonce, eip712 }, ctx);
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

// Count the decimal places in a validated numeric string. The numeric guards
// above reject scientific notation and trailing garbage, so a plain split on
// "." is exact (no float-repr drift from parseFloat).
function countDecimals(numStr) {
  const s = String(numStr).trim();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Hyperliquid rounds an over-precise size/price to the asset's precision rather
// than rejecting it (size -> szDecimals; price -> 6 - szDecimals decimals for
// perps), so the order still fills — but silently at a different value than the
// user typed. Warn up front (the post-prepare "Submitting" line then shows the
// exact rounded value). Fail open: with no szDecimals (meta unavailable) skip.
function warnImpreciseValue(coin, szDecimals, { sizeRaw, priceRaw }, warn) {
  if (!Number.isInteger(szDecimals)) return;
  if (sizeRaw !== undefined && countDecimals(sizeRaw) > szDecimals) {
    warn(`⚠️  --size ${sizeRaw} is more precise than ${coin} allows (max ${szDecimals} decimals); Hyperliquid will round it.`);
  }
  const maxPriceDecimals = Math.max(0, 6 - szDecimals);
  if (priceRaw !== undefined && countDecimals(priceRaw) > maxPriceDecimals) {
    warn(`⚠️  --price ${priceRaw} is more precise than ${coin} allows (max ${maxPriceDecimals} decimals); Hyperliquid will round it.`);
  }
}

// Resolve the signing half of a mutating command's context for an
// already-resolved wallet: a local private key, or a Privy client + wallet id.
// Returns the ctx object buildScreenSignSubmit consumes (walletAddress + one of
// the two signing paths + log). Kept separate from resolveWalletAddress so a
// command that needs the address earlier (e.g. close's direction pre-check) can
// resolve the key afterwards, matching the previous ordering.
async function resolveSigningCtx(wallet, walletName, log) {
  const ctx = {
    walletAddress: wallet.address,
    privateKeyHex: null,
    privyClient: null,
    privyWalletId: null,
    log,
  };
  if (wallet.provider === 'privy') {
    const { PrivyClient } = await import('./privy.js');
    ctx.privyClient = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
    ctx.privyWalletId = wallet.privyWalletIds?.evm;
  } else {
    ctx.privateKeyHex = resolvePrivateKey(walletName);
  }
  return ctx;
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
  const { log = console.log, warn = (m) => process.stderr.write(`${m}\n`) } = deps;

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

      // One meta read serves both the advisory precision warning and the
      // required build metadata. Fetched fail-open so a meta outage doesn't
      // preempt a clearer error below (missing wallet, wrong password); we
      // re-require it just before building the action.
      const assetMeta = await fetchAssetMeta(apiInstance, coin);
      warnImpreciseValue(coin, assetMeta?.szDecimals, { sizeRaw: options.size, priceRaw: options.price }, warn);

      const wallet = resolveWalletAddress(walletName);
      const ctx = await resolveSigningCtx(wallet, walletName, log);

      const { assetId, szDecimals } = requireAsset(assetMeta, coin);

      log(`\n  Perp Order: ${coin} ${isBuy ? 'LONG' : 'SHORT'} ${size} @ ${price} (${orderType})`);

      // Single source of truth for the builder code + approval gate (D1).
      const builderStatus = await fetchBuilderFee(apiInstance, wallet.address);
      await ensureBuilderApproved(apiInstance, builderStatus, ctx);

      const { action, size: effSize, price: effPrice } = buildOrderAction(
        {
          isBuy,
          size,
          price,
          orderType,
          reduceOnly: false,
          tif,
          slippage,
          takeProfit: tp ?? null,
          stopLoss: sl ?? null,
          builder: builderCode(builderStatus),
        },
        { assetId, szDecimals },
      );
      const nonce = hlNonce();
      const eip712 = l1Eip712(action, null, nonce);

      await buildScreenSignSubmit(apiInstance, { action, nonce, eip712, size: effSize, price: effPrice }, ctx);
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

      const assetMeta = await fetchAssetMeta(apiInstance, coin);
      const wallet = resolveWalletAddress(walletName);
      const ctx = await resolveSigningCtx(wallet, walletName, log);
      const { assetId } = requireAsset(assetMeta, coin);

      log(`\n  Cancel: ${coin} order #${oid}`);

      const { action } = buildCancelAction({ orderId: oid }, { assetId });
      const nonce = hlNonce();
      const eip712 = l1Eip712(action, null, nonce);

      await buildScreenSignSubmit(apiInstance, { action, nonce, eip712 }, ctx);
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

      // Advisory: warn before signing if the close size is finer than the asset
      // allows (Hyperliquid rounds rather than rejects). --price here is only a
      // reference mark for the slippage calc, so its precision is not flagged.
      const assetMeta = await fetchAssetMeta(apiInstance, coin);
      warnImpreciseValue(coin, assetMeta?.szDecimals, { sizeRaw: options.size }, warn);

      const wallet = resolveWalletAddress(walletName);

      // Validate the close direction against the open position so a wrong --side
      // fails fast with a clear message instead of the backend's opaque "reduce
      // only order would increase position". sell closes a long, buy closes a
      // short. Fall open if positions can't be fetched — HL still checks.
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

      const ctx = await resolveSigningCtx(wallet, walletName, log);
      const { assetId, szDecimals } = requireAsset(assetMeta, coin);

      log(`\n  Close: ${coin} ${isBuy ? 'buy-to-close' : 'sell-to-close'} ${size} @ ${price}`);

      const builderStatus = await fetchBuilderFee(apiInstance, wallet.address);
      await ensureBuilderApproved(apiInstance, builderStatus, ctx);

      const { action, size: effSize, price: effPrice } = buildCloseAction(
        { size, price, isBuy, slippage, builder: builderCode(builderStatus) },
        { assetId, szDecimals },
      );
      const nonce = hlNonce();
      const eip712 = l1Eip712(action, null, nonce);

      await buildScreenSignSubmit(apiInstance, { action, nonce, eip712, size: effSize, price: effPrice }, ctx);
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
      // fast with a clear message instead of an opaque HL rejection. Falls open
      // if meta is unavailable or the coin isn't listed (HL still checks); the
      // build below re-requires meta since it needs the asset id.
      const assetMeta = await fetchAssetMeta(apiInstance, coin);
      if (assetMeta && Number.isFinite(assetMeta.maxLeverage) && leverage > assetMeta.maxLeverage) {
        throw invalid(`Leverage ${leverage}x exceeds the ${assetMeta.maxLeverage}x maximum for ${coin}.`);
      }

      const isCross = marginType === 'cross';
      const wallet = resolveWalletAddress(walletName);
      const ctx = await resolveSigningCtx(wallet, walletName, log);
      const { assetId } = requireAsset(assetMeta, coin);

      log(`\n  Leverage: ${coin} ${leverage}x ${isCross ? 'cross' : 'isolated'}`);

      const { action } = buildLeverageAction({ leverage, isCross }, { assetId });
      const nonce = hlNonce();
      const eip712 = l1Eip712(action, null, nonce);

      await buildScreenSignSubmit(apiInstance, { action, nonce, eip712 }, ctx);
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
      const ctx = await resolveSigningCtx(wallet, walletName, log);

      log(`\n  Transfer: ${amount} USDC ${toPerp ? 'Spot → Perps' : 'Perps → Spot'}`);

      // usdClassTransfer is user-signed: the nonce is embedded in the action.
      const nonce = hlNonce();
      const { action, primaryType, signTypes } = buildUsdClassTransferAction({ amount, toPerp, nonce });
      const eip712 = userSignedEip712(primaryType, signTypes, action);

      await buildScreenSignSubmit(apiInstance, { action, nonce, eip712 }, ctx);
      log('');
      return undefined;
    },

    'approve-builder-fee': async (args, apiInstance, flags, options) => {
      // One-time onboarding: authorize Nansen's builder fee so orders route with
      // the builder code. order/close auto-fire this on the first trade; this
      // command lets a client approve up front. No-op when already approved.
      const walletName = scalar(options.wallet, 'wallet');
      const wallet = resolveWalletAddress(walletName);
      const ctx = await resolveSigningCtx(wallet, walletName, log);

      const builderStatus = await fetchBuilderFee(apiInstance, wallet.address);
      if (builderStatus.approved) {
        log(`\n  Builder fee already approved for ${wallet.address}\n`);
        return undefined;
      }

      log(`\n  Approve builder fee: ${wallet.address}`);
      await ensureBuilderApproved(apiInstance, builderStatus, ctx);
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
