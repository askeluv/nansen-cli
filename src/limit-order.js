/**
 * Nansen CLI - Limit Order Commands (Jupiter Trigger V2)
 *
 * Supports create, list, cancel, and update of limit orders on Solana.
 * Uses challenge-response JWT auth with disk caching.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import fs from 'fs';
import path from 'path';
import { base58Encode, exportWallet, getWalletConfig, showWallet } from './wallet.js';
import { signEd25519, base58Decode, parseAmount, getTokenInfo } from './transfer.js';
import { signSolanaTransaction, resolveTokenAddress } from './trading.js';
import {
  assertSolanaInstructionsSafe,
  assertLimitOrderDepositOutcome,
  assertLimitOrderCancelOutcome,
  NATIVE_FEE_RENT_SLACK_LAMPORTS,
} from './trade-validation.js';
import {
  simulateSolanaAssetChanges,
  SolanaSimulationError,
  hasSolanaSimulationRpc,
} from './solana-simulation.js';
import { validateTokenAddress, telemetryHeaders, packageVersion } from './api.js';
import { getWalletConnectAddress, sendSolanaTransactionViaWalletConnect, signSolanaMessageViaWalletConnect } from './walletconnect-trading.js';
import { retrievePassword } from './keychain.js';
import { CHAIN_RPCS } from './rpc-urls.js';

// ============= Constants =============

const TRADING_API_URL = process.env.NANSEN_TRADING_API_URL || 'https://trading-api.nansen.ai';
const LO_PREFIX = '/limit-order/v2';
const SOLSCAN_TX_URL = 'https://solscan.io/tx/';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ============= JWT Auth & Caching (Local File) =============

function getAuthFilePath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.nansen', 'limit-order-auth.json');
}

/**
 * Save a JWT token to ~/.nansen/limit-order-auth.json.
 * Keyed by wallet pubkey so switching wallets invalidates correctly.
 */
export function saveCachedToken(walletPubkey, token) {
  try {
    const filePath = getAuthFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    }
    const data = JSON.stringify({
      walletPubkey,
      token,
      // 23-hour TTL provides 1-hour safety margin against server's 24-hour JWT
      expiresAt: Date.now() + 23 * 3600 * 1000,
    });
    fs.writeFileSync(filePath, data, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a cached JWT token from ~/.nansen/limit-order-auth.json.
 * Returns the token string if valid and not expired, null otherwise.
 */
export function loadCachedToken(walletPubkey) {
  try {
    const filePath = getAuthFilePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.walletPubkey !== walletPubkey) return null;
    // 5-minute buffer before expiry to avoid mid-request failures
    if (data.expiresAt <= Date.now() + 300_000) return null;
    return data.token;
  } catch {
    return null;
  }
}

// ============= API Client =============

/**
 * Make an authenticated request to the limit order V2 API.
 */
async function loFetch(method, endpoint, { token, body, query } = {}) {
  const url = new URL(`${LO_PREFIX}${endpoint}`, TRADING_API_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': `nansen-cli/${packageVersion}`,
    'X-Client-Type': 'nansen-cli',
    ...telemetryHeaders(),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (process.env.NANSEN_API_KEY) {
    headers['X-API-Key'] = process.env.NANSEN_API_KEY;
  }

  // Never follow a redirect on a request carrying the JWT / X-API-Key — undici
  // forwards the custom X-API-Key header across a cross-origin redirect, leaking
  // the key to the redirect target.
  const opts = { method, headers, redirect: 'error' };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url.toString(), opts);
  } catch (err) {
    // redirect: 'error' rejects with a bare TypeError on any server redirect;
    // convert it (and genuine network failures) into a coded, actionable error
    // rather than letting an undecorated crash reach the CLI.
    throw Object.assign(
      new Error(`Limit order API request failed (${method} ${url.pathname}): ${err.message}`, { cause: err }),
      { code: 'LIMIT_ORDER_NETWORK_ERROR' }
    );
  }
  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`Limit order API returned non-JSON response (status ${res.status})`),
      { code: 'NON_JSON_RESPONSE', status: res.status, details: text.slice(0, 200) }
    );
  }

  if (!res.ok) {
    const code = parsed.code || 'LIMIT_ORDER_ERROR';
    const msg = parsed.message || `Limit order request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: parsed.details });
  }

  return parsed;
}

// --- Auth endpoints (no JWT required) ---

export async function getChallenge(walletPubkey) {
  return loFetch('POST', '/auth/challenge', { body: { walletPubkey } });
}

export async function verifyChallenge(walletPubkey, signatureBase58) {
  return loFetch('POST', '/auth/verify', { body: { walletPubkey, signature: signatureBase58 } });
}

// --- Vault endpoints ---

export async function getVault(token, userPubkey) {
  return loFetch('GET', '/vault', { token, query: { userPubkey } });
}

export async function registerVault(token) {
  return loFetch('POST', '/vault/register', { token, body: {} });
}

// --- Order lifecycle endpoints ---

export async function craftDeposit(token, { inputMint, outputMint, userAddress, amount }) {
  return loFetch('POST', '/deposit/craft', {
    token,
    body: { inputMint, outputMint, userAddress, amount },
  });
}

export async function createOrder(token, params) {
  return loFetch('POST', '/create', { token, body: params });
}

export async function listOrders(token, userPubkey, filters = {}) {
  return loFetch('GET', '/orders', {
    token,
    query: { userPubkey, ...filters },
  });
}

export async function updateOrder(token, orderId, params) {
  return loFetch('PATCH', `/orders/${orderId}`, { token, body: params });
}

export async function cancelOrderRequest(token, orderId) {
  return loFetch('POST', `/cancel/${orderId}`, { token, body: {} });
}

export async function confirmCancelOrder(token, orderId, { signedTransaction, cancelRequestId }) {
  return loFetch('POST', `/cancel/${orderId}/confirm`, {
    token,
    body: { signedTransaction, cancelRequestId },
  });
}

// ============= Message Signing =============

/**
 * Sign a message with a Solana wallet.
 * Returns raw signature bytes as a Buffer.
 *
 * @param {Buffer} message - Raw message bytes
 * @param {'local'|'privy'|'walletconnect'} walletType
 * @param {object} walletInfo - Type-specific signing info
 * @returns {Promise<Buffer>} Raw Ed25519 signature (64 bytes)
 */
export async function signSolanaMessage(message, walletType, walletInfo) {
  if (walletType === 'local') {
    // Extract seed (first 32 bytes of the 64-byte keypair hex)
    const seed = Buffer.from(walletInfo.privateKeyHex.slice(0, 64), 'hex');
    return signEd25519(message, seed);
  }

  if (walletType === 'privy') {
    const result = await walletInfo.privyClient.signSolanaMessage(
      walletInfo.walletId,
      message,
    );
    const sigBase64 = result.data?.signature || result.signature;
    return Buffer.from(sigBase64, 'base64');
  }

  if (walletType === 'walletconnect') {
    const result = await signSolanaMessageViaWalletConnect(message);
    // WC returns base58-encoded signature
    return Buffer.from(base58Decode(result.signature));
  }

  throw new Error(`Unsupported wallet type: ${walletType}`);
}

// ============= Authentication Flow =============

/**
 * Authenticate with the limit order API and return a JWT.
 * Uses disk cache to avoid re-signing for every CLI invocation.
 *
 * @param {string} walletPubkey - Solana wallet address
 * @param {'local'|'privy'|'walletconnect'} walletType
 * @param {object} walletInfo - Signing info
 * @param {function} log - Logger
 * @returns {Promise<string>} JWT token
 */
export async function authenticate(walletPubkey, walletType, walletInfo, log = () => {}) {
  const cached = loadCachedToken(walletPubkey);
  if (cached) {
    return cached;
  }

  log('  Authenticating with limit order API...');
  const { challenge } = await getChallenge(walletPubkey);
  const messageBuffer = Buffer.from(challenge, 'utf8');

  log('  Signing challenge...');
  const signatureBytes = await signSolanaMessage(messageBuffer, walletType, walletInfo);
  const signatureBase58 = base58Encode(signatureBytes);

  const { token } = await verifyChallenge(walletPubkey, signatureBase58);
  saveCachedToken(walletPubkey, token);

  return token;
}

// ============= Wallet Resolution =============

/**
 * Resolve a Solana wallet for limit orders.
 * Follows the same 3-way dispatch as trading.js: WalletConnect / named / default.
 *
 * @returns {{ pubkey, walletType, walletInfo, privyWalletIds }}
 */
export async function resolveSolanaWallet(walletName, deps = {}) {
  const { log = console.log, exit = process.exit } = deps;

  const isWalletConnect = walletName === 'walletconnect' || walletName === 'wc';

  if (isWalletConnect) {
    const address = await getWalletConnectAddress('solana');
    if (!address) {
      log('No WalletConnect session active. Run: walletconnect connect');
      exit(1);
      return null;
    }
    return { pubkey: address, walletType: 'walletconnect', walletInfo: {}, privyWalletIds: null };
  }

  let wallet;
  if (walletName) {
    wallet = showWallet(walletName);
  } else {
    try {
      const config = getWalletConfig();
      if (config.defaultWallet) {
        wallet = showWallet(config.defaultWallet);
      }
    } catch {
      // No wallet configured
    }
  }

  if (!wallet || !wallet.solana) {
    log('No Solana wallet found. Create one with: nansen wallet create');
    exit(1);
    return null;
  }

  if (wallet.provider === 'privy') {
    const { PrivyClient } = await import('./privy.js');
    const privyClient = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
    return {
      pubkey: wallet.solana,
      walletType: 'privy',
      walletInfo: { privyClient, walletId: wallet.privyWalletIds?.solana },
      privyWalletIds: wallet.privyWalletIds,
    };
  }

  // Local wallet — need password for signing
  return {
    pubkey: wallet.solana,
    walletType: 'local',
    walletInfo: {}, // privateKeyHex populated lazily when signing is needed
    walletName: wallet.name,
    privyWalletIds: null,
  };
}

/**
 * Get the private key hex for a local wallet, prompting for password if needed.
 */
function getLocalWalletPrivateKey(walletName) {
  const config = getWalletConfig();
  let password = null;
  if (config.passwordHash) {
    const result = retrievePassword();
    password = result.password;
    if (!password) {
      throw new Error('Wallet is encrypted and no password was found. Set NANSEN_WALLET_PASSWORD env var.');
    }
  }
  const effectiveName = walletName || config.defaultWallet;
  const exported = exportWallet(effectiveName, password);
  return exported.solana.privateKey;
}

// ============= Transaction Signing =============

/**
 * Sign a Solana transaction (base64) using the appropriate wallet type.
 * Returns base64-encoded signed transaction.
 */
export async function signTransaction(txBase64, walletType, walletInfo) {
  if (walletType === 'local') {
    return signSolanaTransaction(txBase64, walletInfo.privateKeyHex);
  }

  if (walletType === 'privy') {
    const result = await walletInfo.privyClient.signSolanaTransaction(
      walletInfo.walletId,
      txBase64,
    );
    return result.data?.signed_transaction || result.signed_transaction;
  }

  if (walletType === 'walletconnect') {
    // WC expects base58 for Solana transactions
    const txBytes = Buffer.from(txBase64, 'base64');
    const txBase58 = base58Encode(txBytes);
    const result = await sendSolanaTransactionViaWalletConnect(txBase58);
    if (result.signedTransaction) {
      // WC returns base58; convert to base64
      const signedBytes = base58Decode(result.signedTransaction);
      return Buffer.from(signedBytes).toString('base64');
    }
    throw new Error('WalletConnect did not return a signed transaction');
  }

  throw new Error(`Unsupported wallet type: ${walletType}`);
}

/**
 * The limit-order sibling of verifySolanaSwapOutcome: simulates the deposit/
 * cancel transaction and checks the resulting balance deltas against the
 * requested operation, degrading (warn + proceed) on any RPC/sim outage so an
 * outage never blocks an order — only a real outcome mismatch or an
 * in-simulation revert refuses to sign.
 */
async function verifyLimitOrderOutcome({ kind, walletAddress, txBase64, inputMint, amount, log = () => {} }) {
  if (!hasSolanaSimulationRpc('solana')) {
    log('  ⚠ Outcome verification unavailable (no Solana simulation endpoint); proceeding without it.');
    return { proceed: true };
  }
  try {
    const sim = await simulateSolanaAssetChanges('solana', txBase64, { walletAddress });
    if (kind === 'deposit') {
      assertLimitOrderDepositOutcome(sim, { inputMint, amount });
    } else {
      assertLimitOrderCancelOutcome(sim, { inputMint, amount });
    }
    log(`  ✓ ${kind === 'deposit' ? 'Deposit' : 'Cancellation'} outcome verified (via ${sim.method}).`);
    return { proceed: true };
  } catch (e) {
    if (e instanceof SolanaSimulationError && ['NO_SIM_RPC', 'SIM_RPC_ERROR'].includes(e.code)) {
      log(`  ⚠ Outcome verification could not run (${e.message}); proceeding without it.`);
      return { proceed: true };
    }
    return { proceed: false, reason: e.message };
  }
}

// Page size and scan ceiling for the pre-cancel order lookup. The ceiling is a
// defensive bound: it stops an unbounded loop if the API never surfaces the order
// and never reports a total or a short page, at the cost of not finding a target
// buried beyond it (which then fails closed, same as any not-found order).
const ACTIVE_ORDER_PAGE = 100;
const MAX_ACTIVE_ORDERS_SCANNED = 5000;

/**
 * Find one active order by id, paginating state:'active' until the order is found or
 * the active set is exhausted, so a user with more than one page of active orders can
 * still cancel one that doesn't land on page 1. Returns the order object or undefined.
 */
async function findActiveOrder(token, userPubkey, orderId) {
  let offset = 0;
  while (offset < MAX_ACTIVE_ORDERS_SCANNED) {
    const page = await listOrders(token, userPubkey, { limit: ACTIVE_ORDER_PAGE, offset, state: 'active' });
    const orders = page.orders || [];
    const found = orders.find((o) => o.id === orderId);
    if (found) return found;
    offset += orders.length;
    if (orders.length < ACTIVE_ORDER_PAGE) break; // short/empty page — no more to fetch
    const total = page.pagination?.total;
    if (total != null && offset >= total) break; // consumed everything the API reports
  }
  return undefined;
}

/**
 * The base-unit amount a cancel should refund: the order's input less whatever has
 * already been filled (partial fills consume escrow). Returns undefined if the order's
 * amounts can't be parsed as integers, so the cancel verifier falls back to a bare
 * positive-inflow check rather than binding to a bogus figure.
 */
function remainingRefundAmount(order) {
  try {
    const total = BigInt(order.inputAmount);
    const filled = (order.fills || []).reduce((sum, f) => sum + BigInt(f.inputAmount ?? 0), 0n);
    const remaining = total - filled;
    return remaining > 0n ? remaining : undefined;
  } catch {
    return undefined;
  }
}

// ============= Expiry Parsing =============

/**
 * Parse an expiry duration string to epoch milliseconds.
 * Accepts: "24h", "7d", "30d", or raw epoch ms string.
 * Returns null for no expiry.
 */
export function parseExpiry(expiryStr) {
  if (!expiryStr || expiryStr === 'never') return null;

  const match = expiryStr.match(/^(\d+)(h|d)$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid expiry "${expiryStr}". Duration must be finite.`);
    }
    if (value <= 0) {
      throw new Error(`Invalid expiry "${expiryStr}". Duration must be greater than 0.`);
    }
    const unit = match[2].toLowerCase();
    const ms = unit === 'h' ? value * 3600 * 1000 : value * 24 * 3600 * 1000;
    const expiresAt = Date.now() + ms;
    if (!Number.isFinite(expiresAt)) {
      throw new Error(`Invalid expiry "${expiryStr}". Duration is too large.`);
    }
    return expiresAt;
  }

  // Try as raw epoch ms — must be in the future, or the order expires on arrival.
  const num = Number(expiryStr);
  if (Number.isFinite(num)) {
    if (num <= Date.now()) {
      throw new Error(`Expiry "${expiryStr}" is in the past. Provide a future time (e.g. "24h", "7d", or a future epoch in ms).`);
    }
    return num;
  }

  if (!Number.isNaN(num)) {
    throw new Error(`Invalid expiry "${expiryStr}". Provide a finite future epoch in milliseconds or a duration such as "24h" or "7d".`);
  }

  throw new Error(`Invalid expiry format: "${expiryStr}". Use "24h", "7d", "30d", or epoch ms.`);
}

// Whole integer bps in [0, 10000], matching bridge parseSlippageBps.
// Number() would accept "1.5", "1e2", "0x10", and boolean true.
function parseSlippageBps(raw) {
  const s = String(raw).trim();
  const bad = 'Error: --slippage-bps must be a whole integer between 0 and 10000 basis points.';
  if (!/^\d+$/.test(s)) throw new Error(bad);
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error(bad);
  return n;
}

// ============= Order Formatting =============

function formatOrderStatus(status) {
  const map = {
    pending: 'Pending',
    open: 'Open',
    executing: 'Executing',
    filled: 'Filled',
    pending_withdraw: 'Withdrawing',
    cancelled: 'Cancelled',
    expired: 'Expired',
    failed: 'Failed',
  };
  return map[status] || status;
}

// Reverse lookup: address → { symbol, decimals } for known Solana tokens
const KNOWN_SOLANA_TOKENS = {
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 },
};

function tokenLabel(address) {
  if (!address) return '?';
  const info = KNOWN_SOLANA_TOKENS[address];
  return info ? `${info.symbol} (${address})` : address;
}

/**
 * Format a base-unit amount to human-readable (e.g. 116000000 SOL → "0.116 SOL").
 * Falls back to raw amount for unknown tokens.
 */
function formatAmount(amount, mintAddress) {
  if (!amount) return '?';
  const info = KNOWN_SOLANA_TOKENS[mintAddress];
  if (!info) return `${amount} ${mintAddress || '?'}`;
  // amount is backend-controlled; a float or scientific-notation string makes
  // BigInt() throw. Fall back to the raw amount rather than aborting the whole
  // list render.
  let raw;
  try {
    raw = BigInt(amount);
  } catch {
    return `${amount} ${info.symbol}`;
  }
  const divisor = 10n ** BigInt(info.decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(info.decimals, '0').replace(/0+$/, '');
  const humanAmount = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return `${humanAmount} ${info.symbol} (${amount} base units)`;
}

function formatTimestamp(ts) {
  if (!ts) return '?';
  const num = Number(ts);
  if (isNaN(num)) return ts;
  const date = new Date(num);
  return `${date.toLocaleString()} (${date.toISOString()})`;
}

function formatOrder(order, index) {
  const lines = [];
  const label = index !== undefined ? `  Order #${index + 1}` : '  Order';
  lines.push(`${label} (${order.id})`);
  lines.push(`    Status:          ${formatOrderStatus(order.status)}`);
  lines.push(`    Sell:            ${formatAmount(order.inputAmount, order.inputMint)}`);
  lines.push(`    Buy:             ${tokenLabel(order.outputMint)}`);
  lines.push(`    Trigger:         ${order.triggerCondition} $${order.triggerPriceUsd} on ${tokenLabel(order.triggerMint)}`);
  lines.push(`    Slippage:        ${order.slippageBps != null ? `${order.slippageBps} bps` : 'auto'}`);
  lines.push(`    Created:         ${formatTimestamp(order.createdAt)}`);
  if (order.expiresAt) lines.push(`    Expires:         ${formatTimestamp(order.expiresAt)}`);
  if (order.fills?.length > 0) {
    lines.push(`    Fills:           ${order.fills.length}`);
    for (const fill of order.fills) {
      lines.push(`      ${fill.inputAmount} → ${fill.outputAmount} (${fill.txSignature?.slice(0, 12)}...)`);
    }
  }
  return lines.join('\n');
}

// ============= CLI Command Builder =============

/**
 * Build limit order command handlers for CLI integration.
 */
export function buildLimitOrderCommands(deps = {}) {
  const { log = console.log, exit = process.exit } = deps;

  return {
    'create': async (args, apiInstance, flags, options) => {
      const fromRaw = options.from || options['from-token'] || args[0];
      const toRaw = options.to || options['to-token'] || args[1];
      const from = resolveTokenAddress(fromRaw, 'solana');
      const to = resolveTokenAddress(toRaw, 'solana');
      const amount = options.amount || args[2];
      const triggerPrice = options['trigger-price'];
      const triggerCondition = options['trigger-condition'];
      const triggerMintRaw = options['trigger-mint'];
      const slippageBpsRaw = options['slippage-bps'];
      const expiresStr = options.expires || '30d';
      const walletName = options.wallet;

      if (!from || !to || !amount || triggerPrice == null || !triggerMintRaw || !triggerCondition) {
        log(`
Usage: nansen trade limit-order create --from <token> --to <token> --amount <amount> --trigger-mint <token> --trigger-condition <above|below> --trigger-price <usd>

OPTIONS:
  --from <symbol|address>        Token to sell (symbol like SOL, USDC or address)
  --to <symbol|address>          Token to buy (symbol like USDC, SOL or address)
  --amount <amount>              Amount to sell in token units (e.g. 1.5 for 1.5 SOL, 80 for 80 USDC)
  --trigger-mint <symbol|addr>   Token whose price triggers the order (e.g. SOL)
  --trigger-condition <cond>     "above" or "below"
  --trigger-price <usd>          Trigger price in USD (must be a positive number)
  --slippage-bps <bps>           Whole integer bps, 0-10000 (100 = 1%), omit for auto
  --expires <duration>           Expiry duration: "24h", "7d", "30d" (default: 30d)
  --wallet <name>                Wallet name (or "walletconnect"/"wc")

EXAMPLES:
  # Sell 1 SOL for USDC when SOL drops below $80
  nansen trade limit-order create --from SOL --to USDC --amount 1 --trigger-mint SOL --trigger-condition below --trigger-price 80
  # Buy SOL with 80 USDC when SOL goes above $100
  nansen trade limit-order create --from USDC --to SOL --amount 80 --trigger-mint SOL --trigger-condition above --trigger-price 100`);
        exit(1);
        return;
      }

      // Validate token addresses are valid Solana addresses (catches EVM addresses, typos, etc.)
      const fromValidation = validateTokenAddress(from, 'solana');
      if (!fromValidation.valid) {
        log(`Error: Invalid --from token address: ${fromValidation.error}`);
        exit(1);
        return;
      }
      const toValidation = validateTokenAddress(to, 'solana');
      if (!toValidation.valid) {
        log(`Error: Invalid --to token address: ${toValidation.error}`);
        exit(1);
        return;
      }

      const price = Number(triggerPrice);
      if (!Number.isFinite(price) || price <= 0) {
        log('Error: --trigger-price must be a finite positive number.');
        exit(1);
        return;
      }

      let expiresAt;
      try {
        expiresAt = parseExpiry(expiresStr);
      } catch (err) {
        log(`Error: ${err.message}`);
        exit(1);
        return;
      }

      // Amount is always in human-readable token units (e.g. 1.5 = 1.5 SOL)
      // Converted to base units (lamports) internally
      let amountBaseUnits;
      try {
        const num = Number(amount);
        if (isNaN(num) || num <= 0) {
          log('Error: --amount must be a positive number in token units (e.g. 1.5 for 1.5 SOL, 80 for 80 USDC).');
          exit(1);
          return;
        }
        const fromInfo = KNOWN_SOLANA_TOKENS[from];
        let decimals;
        if (fromInfo) {
          decimals = fromInfo.decimals;
        } else {
          const tokenInfo = await getTokenInfo(CHAIN_RPCS.solana, from);
          decimals = tokenInfo.decimals;
        }
        amountBaseUnits = String(parseAmount(String(amount), decimals));
      } catch (err) {
        log(`Error: Could not resolve decimals for ${from}: ${err.message}`);
        exit(1);
        return;
      }

      // Fail fast on a native-SOL amount too small for outcome verification to bound by
      // magnitude (see assertLimitOrderDepositOutcome's NATIVE_FEE_RENT_SLACK_LAMPORTS
      // floor) — otherwise this would only surface as a LIMIT_ORDER_OUTCOME_MISMATCH
      // after crafting and simulating the deposit transaction, well into the flow.
      if (from === WSOL_MINT && hasSolanaSimulationRpc('solana') && BigInt(amountBaseUnits) <= NATIVE_FEE_RENT_SLACK_LAMPORTS) {
        log(`Error: SOL deposit amount (${amountBaseUnits} lamports) is too small to verify against network fee/rent noise (${NATIVE_FEE_RENT_SLACK_LAMPORTS} lamports). Use a larger amount.`);
        exit(1);
        return;
      }

      if (triggerCondition !== 'above' && triggerCondition !== 'below') {
        log('Error: --trigger-condition must be "above" or "below".');
        exit(1);
        return;
      }

      // Same bounds as update / bridge: whole-integer bps in 0–10000.
      let slippageBps;
      if (slippageBpsRaw != null) {
        try {
          slippageBps = parseSlippageBps(slippageBpsRaw);
        } catch (err) {
          log(err.message);
          exit(1);
          return;
        }
      }

      const triggerMint = resolveTokenAddress(triggerMintRaw, 'solana');

      const tmValidation = validateTokenAddress(triggerMint, 'solana');
      if (!tmValidation.valid) {
        log(`Error: Invalid --trigger-mint address: ${tmValidation.error}`);
        exit(1);
        return;
      }

      try {
        // 1. Resolve wallet
        const resolved = await resolveSolanaWallet(walletName, deps);
        if (!resolved) return;

        let { pubkey, walletType, walletInfo } = resolved;

        // For local wallets, load private key now
        if (walletType === 'local') {
          const privateKeyHex = getLocalWalletPrivateKey(resolved.walletName);
          walletInfo = { privateKeyHex };
        }

        log(`\nCreating limit order on Solana...`);
        log(`  Wallet: ${pubkey}`);
        log(`  Sell: ${formatAmount(amountBaseUnits, from)}`);
        log(`  Buy: ${to}`);
        log(`  Trigger: $${price} (${triggerCondition})`);

        // 2. Authenticate
        const token = await authenticate(pubkey, walletType, walletInfo, log);

        // 3. Check vault, auto-register if needed
        // Backend returns { vaultPubkey: "..." } when vault exists, or throws/returns empty when not
        let hasVault = false;
        try {
          const vaultInfo = await getVault(token, pubkey);
          hasVault = !!(vaultInfo?.vaultPubkey || vaultInfo?.vaultAddress);
        } catch {
          // No vault found
        }
        if (!hasVault) {
          log('  Registering vault for first-time use...');
          try {
            await registerVault(token);
          } catch (regErr) {
            // Vault may already exist — ignore "already registered" errors
            if (!/already registered/i.test(regErr.message)) throw regErr;
          }
        }

        // 4. Craft deposit transaction
        log('  Crafting deposit transaction...');
        const deposit = await craftDeposit(token, {
          inputMint: from,
          outputMint: to,
          userAddress: pubkey,
          amount: amountBaseUnits,
        });

        // 5. Sign deposit transaction
        // Two layers of pre-signing defense, same as the swap path. First, the
        // static gate: the legitimate deposit moves the input token into the
        // already-registered vault (step 3) with an SPL Transfer/TransferChecked —
        // which this gate does not classify — plus, when selling native SOL, a
        // temp-WSOL CloseAccount whose rent returns to the wallet (permitted).
        // Neither trips the delegate/authority/close-to-stranger checks, so this
        // does not reject a well-formed deposit; it only fires if the crafted tx
        // additionally grants a delegate, reassigns authority, or closes to a
        // stranger. Second, balance-delta outcome verification below binds the
        // deposit's magnitude: the input token must leave the wallet by exactly
        // `amount` (± fee/rent slack for native SOL) and no other token may leave.
        // Verified live: a real SOL→USDC create round-trip clears both gates (the
        // API-crafted deposit is a SOL-wrap transfer into the vault plus a
        // temp-WSOL close-to-self).
        assertSolanaInstructionsSafe(deposit.transaction, { walletAddress: pubkey });
        const depositOutcome = await verifyLimitOrderOutcome({
          kind: 'deposit', walletAddress: pubkey, txBase64: deposit.transaction,
          inputMint: from, amount: amountBaseUnits, log,
        });
        if (!depositOutcome.proceed) throw new Error(`Refusing to sign deposit — ${depositOutcome.reason}`);
        log('  Signing deposit transaction...');
        const signedDepositTx = await signTransaction(deposit.transaction, walletType, walletInfo);

        // 6. Create order
        log('  Submitting order...');
        const orderParams = {
          orderType: 'single',
          depositRequestId: deposit.requestId,
          depositSignedTx: signedDepositTx,
          userPubkey: pubkey,
          inputMint: from,
          inputAmount: amountBaseUnits,
          outputMint: to,
          triggerMint,
          triggerCondition,
          triggerPriceUsd: price, // Must be Number, not string
          ...(slippageBps != null ? { slippageBps } : {}),
          ...(expiresAt != null ? { expiresAt } : {}),
        };

        const result = await createOrder(token, orderParams);

        log(`\n  ✓ Limit order created`);
        log(`    Order ID:     ${result.id}`);
        log(`    Tx:           ${result.txSignature}`);
        log(`    Explorer:     ${SOLSCAN_TX_URL}${result.txSignature}`);
        log('');

      } catch (err) {
        log(`Error: ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        if (err.cause) log(`  Cause: ${err.cause.message || err.cause}`);
        exit(1);
      }
    },

    'list': async (args, apiInstance, flags, options) => {
      const walletName = options.wallet;
      const state = options.state;
      const mint = options.mint ? resolveTokenAddress(options.mint, 'solana') : undefined;
      const limit = options.limit || 20;
      const offset = options.offset || 0;
      const sort = options.sort;
      const dir = options.dir || 'desc';

      if (mint) {
        const mintValidation = validateTokenAddress(mint, 'solana');
        if (!mintValidation.valid) {
          log(`Error: Invalid --mint address: ${mintValidation.error}`);
          exit(1);
          return;
        }
      }

      try {
        const resolved = await resolveSolanaWallet(walletName, deps);
        if (!resolved) return;

        let { pubkey, walletType, walletInfo } = resolved;

        // For local wallets, load private key for auth
        if (walletType === 'local') {
          const privateKeyHex = getLocalWalletPrivateKey(resolved.walletName);
          walletInfo = { privateKeyHex };
        }

        const token = await authenticate(pubkey, walletType, walletInfo, log);

        const result = await listOrders(token, pubkey, { state, mint, limit, offset, sort, dir });
        const orders = result.orders || [];

        if (orders.length === 0) {
          log('\nNo limit orders found.');
          if (state) log(`  (filtered by state: ${state})`);
          log('');
          return;
        }

        log(`\nLimit Orders (${result.pagination?.total || orders.length} total):\n`);
        orders.forEach((order, i) => {
          if (i > 0) log('');
          log(formatOrder(order, i));
        });
        if (result.pagination && result.pagination.total > offset + orders.length) {
          log(`\n  Showing ${offset + 1}-${offset + orders.length} of ${result.pagination.total}. Use --offset ${offset + orders.length} to see more.`);
        }
        log('');

      } catch (err) {
        log(`Error: ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },

    'cancel': async (args, apiInstance, flags, options) => {
      const orderId = options.order || options['order-id'] || args[0];
      const walletName = options.wallet;

      if (!orderId) {
        log(`
Usage: nansen trade limit-order cancel --order <orderId>

OPTIONS:
  --order <id>        Order ID to cancel
  --wallet <name>     Wallet name (or "walletconnect"/"wc")

EXAMPLES:
  nansen trade limit-order cancel --order abc123`);
        exit(1);
        return;
      }

      try {
        const resolved = await resolveSolanaWallet(walletName, deps);
        if (!resolved) return;

        let { pubkey, walletType, walletInfo } = resolved;

        if (walletType === 'local') {
          const privateKeyHex = getLocalWalletPrivateKey(resolved.walletName);
          walletInfo = { privateKeyHex };
        }

        log(`\nCancelling order ${orderId}...`);

        // 1. Authenticate
        const token = await authenticate(pubkey, walletType, walletInfo, log);

        // 2. Look up the order, but only when outcome verification will actually run —
        // cancel only receives an orderId, not order details, from the caller, and the
        // refund check below (see assertLimitOrderCancelOutcome) needs to know both which
        // asset the refund must land in AND how much of it is still owed (the unfilled
        // remainder). Skip the extra lookup entirely when there's no simulation RPC to
        // verify against, so a degraded environment doesn't gain a new API dependency for
        // a check it isn't going to run anyway. Done before requesting cancellation so a
        // lookup failure fails closed without first consuming a one-time withdrawal request
        // server-side. Filtered to state: 'active' (the only state a cancellable order can
        // be in) so filled/cancelled/expired history never crowds out the target — the API
        // only accepts 'active' or 'past' for this filter. Paginated until the order is
        // found or the active set is exhausted, so a user with more than one page of active
        // orders can still cancel one that doesn't land on page 1.
        let cancelInputMint;
        let cancelRefundAmount;
        if (hasSolanaSimulationRpc('solana')) {
          const order = await findActiveOrder(token, pubkey, orderId);
          if (!order) {
            throw new Error(`Could not find order ${orderId} among your active orders; refusing to verify the cancel's refund asset. It may already be filled/cancelled/expired — check with "nansen trade limit-order list --state active".`);
          }
          cancelInputMint = order.inputMint;
          cancelRefundAmount = remainingRefundAmount(order);
        }

        // 3. Request cancellation — get unsigned withdrawal tx
        log('  Requesting cancellation...');
        const cancelResult = await cancelOrderRequest(token, orderId);

        // 4. Sign the withdrawal transaction
        // Withdrawal moves the deposited token back out of the vault; that transfer
        // is authorized by the vault program's PDA, not our wallet, so it isn't a
        // wallet-authorized drain even if it were classified. Any temp-WSOL close
        // returns rent to the wallet. The static gate below is defense-in-depth
        // against a crafted withdrawal that instead grants a delegate, reassigns
        // authority, or closes to a stranger. Balance-delta outcome verification
        // then binds the withdrawal's effect: since a cancel should only return
        // funds to the wallet, no token may leave it at all (native-SOL fee/rent
        // dust tolerated), and the order's own input asset must return by the full
        // expected remaining amount (looked up in step 2) — not merely a positive
        // delta, so a redirect of most of the escrow paired with a dust or unrelated
        // inflow no longer counts. Verified live alongside the deposit path via a
        // real cancel round-trip.
        assertSolanaInstructionsSafe(cancelResult.transaction, { walletAddress: pubkey });
        const cancelOutcome = await verifyLimitOrderOutcome({
          kind: 'cancel', walletAddress: pubkey, txBase64: cancelResult.transaction,
          inputMint: cancelInputMint, amount: cancelRefundAmount, log,
        });
        if (!cancelOutcome.proceed) throw new Error(`Refusing to sign withdrawal — ${cancelOutcome.reason}`);
        log('  Signing withdrawal transaction...');
        const signedTx = await signTransaction(cancelResult.transaction, walletType, walletInfo);

        // 5. Confirm cancellation
        log('  Confirming cancellation...');
        const confirmed = await confirmCancelOrder(token, orderId, {
          signedTransaction: signedTx,
          cancelRequestId: cancelResult.requestId,
        });

        log(`\n  ✓ Order cancelled`);
        log(`    Order ID:     ${confirmed.id}`);
        log(`    Tx:           ${confirmed.txSignature}`);
        log(`    Explorer:     ${SOLSCAN_TX_URL}${confirmed.txSignature}`);
        log('');

      } catch (err) {
        log(`Error: ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },

    'update': async (args, apiInstance, flags, options) => {
      const orderId = options.order || options['order-id'] || args[0];
      const triggerPrice = options['trigger-price'];
      const slippageBps = options['slippage-bps'];
      const walletName = options.wallet;

      if (!orderId) {
        log(`
Usage: nansen trade limit-order update --order <orderId> [--trigger-price <usd>] [--slippage-bps <bps>]

OPTIONS:
  --order <id>            Order ID to update
  --trigger-price <usd>   New trigger price in USD
  --slippage-bps <bps>    Whole integer bps, 0-10000 (100 = 1%)
  --wallet <name>         Wallet name (or "walletconnect"/"wc")

NOTE: Only provided fields are updated. Auto slippage can only be set at creation time
      (by omitting --slippage-bps from the create command).

EXAMPLES:
  nansen trade limit-order update --order abc123 --trigger-price 85
  nansen trade limit-order update --order abc123 --slippage-bps 100`);
        exit(1);
        return;
      }

      if (triggerPrice == null && slippageBps == null) {
        log('Error: Provide at least one of --trigger-price or --slippage-bps to update.');
        exit(1);
        return;
      }

      const updateBody = { orderType: 'single' };
      if (triggerPrice != null) {
        const price = Number(triggerPrice);
        if (!Number.isFinite(price) || price <= 0) {
          log('Error: --trigger-price must be a finite positive number.');
          exit(1);
          return;
        }
        updateBody.triggerPriceUsd = price;
      }
      if (slippageBps != null) {
        try {
          updateBody.slippageBps = parseSlippageBps(slippageBps);
        } catch (err) {
          log(err.message);
          exit(1);
          return;
        }
      }

      try {
        const resolved = await resolveSolanaWallet(walletName, deps);
        if (!resolved) return;

        let { pubkey, walletType, walletInfo } = resolved;

        if (walletType === 'local') {
          const privateKeyHex = getLocalWalletPrivateKey(resolved.walletName);
          walletInfo = { privateKeyHex };
        }

        log(`\nUpdating order ${orderId}...`);

        const token = await authenticate(pubkey, walletType, walletInfo, log);
        await updateOrder(token, orderId, updateBody);

        log(`\n  ✓ Order updated`);
        if (updateBody.triggerPriceUsd != null) log(`    Trigger price: $${updateBody.triggerPriceUsd}`);
        if (updateBody.slippageBps != null) log(`    Slippage:      ${updateBody.slippageBps} bps`);
        log('');

      } catch (err) {
        log(`Error: ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },
  };
}
