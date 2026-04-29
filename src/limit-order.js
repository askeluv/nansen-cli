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
import { validateTokenAddress } from './api.js';
import { getWalletConnectAddress, sendSolanaTransactionViaWalletConnect, signSolanaMessageViaWalletConnect } from './walletconnect-trading.js';
import { retrievePassword } from './keychain.js';
import { CHAIN_RPCS } from './rpc-urls.js';

// ============= Constants =============

const TRADING_API_URL = process.env.NANSEN_TRADING_API_URL || 'https://trading-api.nansen.ai';
const LO_PREFIX = '/limit-order/v2';
const SOLSCAN_TX_URL = 'https://solscan.io/tx/';

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
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (process.env.NANSEN_API_KEY) {
    headers['X-API-Key'] = process.env.NANSEN_API_KEY;
  }

  const opts = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), opts);
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
    const unit = match[2].toLowerCase();
    const ms = unit === 'h' ? value * 3600 * 1000 : value * 24 * 3600 * 1000;
    return Date.now() + ms;
  }

  // Try as raw epoch ms
  const num = Number(expiryStr);
  if (!isNaN(num) && num > Date.now() - 86400000) {
    return num;
  }

  throw new Error(`Invalid expiry format: "${expiryStr}". Use "24h", "7d", "30d", or epoch ms.`);
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
  const raw = BigInt(amount);
  const divisor = BigInt(10 ** info.decimals);
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
      const slippageBps = options['slippage-bps'] != null ? Number(options['slippage-bps']) : undefined;
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
  --slippage-bps <bps>               Slippage in basis points (100 = 1%), omit for auto
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

      const price = Number(triggerPrice);
      if (isNaN(price) || price <= 0) {
        log('Error: --trigger-price must be a positive number (USD price).');
        exit(1);
        return;
      }

      if (triggerCondition !== 'above' && triggerCondition !== 'below') {
        log('Error: --trigger-condition must be "above" or "below".');
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

        // 2. Request cancellation — get unsigned withdrawal tx
        log('  Requesting cancellation...');
        const cancelResult = await cancelOrderRequest(token, orderId);

        // 3. Sign the withdrawal transaction
        log('  Signing withdrawal transaction...');
        const signedTx = await signTransaction(cancelResult.transaction, walletType, walletInfo);

        // 4. Confirm cancellation
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
  --slippage-bps <bps>    Slippage in basis points (100 = 1%)
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
        if (isNaN(price) || price <= 0) {
          log('Error: --trigger-price must be a positive number.');
          exit(1);
          return;
        }
        updateBody.triggerPriceUsd = price;
      }
      if (slippageBps != null) {
        const bps = Number(slippageBps);
        if (isNaN(bps) || bps < 0 || bps > 10000) {
          log('Error: --slippage-bps must be between 0 and 10000 basis points.');
          exit(1);
          return;
        }
        updateBody.slippageBps = bps;
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
