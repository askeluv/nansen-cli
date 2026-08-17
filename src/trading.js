/**
 * Nansen CLI - Trading Commands
 * Quote and execute DEX swaps via the Nansen Trading API.
 * Supports Solana and Base.
 * Zero external dependencies — uses Node.js built-in crypto only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { base58Encode, exportWallet, getWalletConfig, showWallet, listWallets } from './wallet.js';
import { base58Decode } from './transfer.js';
import { keccak256, signSecp256k1, rlpEncode } from './crypto.js';
import { getWalletConnectAddress, sendTransactionViaWalletConnect, sendSolanaTransactionViaWalletConnect, sendApprovalViaWalletConnect } from './walletconnect-trading.js';
import { retrievePassword } from './keychain.js';
import { validateQuoteInput, validateBalance, resolvePercentAmount, validateGasBalance } from './trade-validation.js';
import { CHAIN_RPCS } from './rpc-urls.js';
import { packageVersion, CommandError, telemetryHeaders } from './api.js';

// ============= Constants =============

const TRADING_API_URL = process.env.NANSEN_TRADING_API_URL || 'https://trading-api.nansen.ai';
const CLIENT_USER_AGENT = `nansen-cli/${packageVersion}`;

const CHAIN_MAP = {
  solana:   { index: '501', type: 'solana', chainId: 501,  name: 'Solana',   explorer: 'https://solscan.io/tx/', lifiChainId: '1151111081099710' },
  base:     { index: '8453', type: 'evm',   chainId: 8453, name: 'Base',     explorer: 'https://basescan.org/tx/', lifiChainId: '8453' },
};

// Extend when adding new EVM chains (e.g. arbitrum WETH, polygon WMATIC)
const WRAPPED_NATIVE_TOKENS = {
  base:     { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', nativeSymbol: 'ETH' },
};

// Common token symbol → address lookup per chain.
// Native sentinels: Solana uses native mint, EVM uses 0xeee…eee.
// Wrapped-native addresses (WETH) are derived from WRAPPED_NATIVE_TOKENS
// to avoid duplication — keep that map as the single source of truth.
const EVM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// Relay returns the Solana System Program mint as the sentinel for native SOL.
// Recognise it as native so approval/value validation behaves correctly when
// cross-chain quotes route through Relay. (LiFi/Jupiter still use WSOL.)
const NATIVE_SOL_SYSTEM_MINT = '11111111111111111111111111111111';
const TOKEN_SYMBOLS = {
  solana: {
    SOL:  'So11111111111111111111111111111111111111112',
    WSOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
  base: {
    ETH:  EVM_NATIVE,
    WETH: WRAPPED_NATIVE_TOKENS.base.address,
    USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    // NOTE: Legacy L2-bridged USDT on Base. If Tether deploys natively on Base
    // (like Circle did with USDC), this address will need updating.
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
};

/**
 * Resolve a token symbol (e.g. "SOL", "USDC") to its canonical address
 * for the given chain. Returns the input unchanged if no match is found
 * (assumes it's already a raw address).
 */
export function resolveTokenAddress(symbolOrAddress, chainName) {
  if (!symbolOrAddress || !chainName) return symbolOrAddress;
  const chainTokens = TOKEN_SYMBOLS[chainName.toLowerCase()];
  if (!chainTokens) return symbolOrAddress;
  const resolved = chainTokens[symbolOrAddress.toUpperCase()];
  return resolved || symbolOrAddress;
}

/**
 * Make a JSON-RPC call to an EVM RPC endpoint.
 * RPC URLs come from the shared CHAIN_RPCS registry in rpc-urls.js.
 * @param {string} chain - Chain name (key into CHAIN_RPCS)
 * @param {string} method - JSON-RPC method name
 * @param {Array} params - Method parameters
 * @returns {Promise<*>} Parsed result value
 * @throws {Error} If chain has no configured RPC or the RPC returns an error
 */
export async function evmRpcCall(chain, method, params = []) {
  const rpcUrl = CHAIN_RPCS[chain];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`RPC endpoint returned non-JSON response (HTTP ${res.status}) for ${method}: ${text.slice(0, 100)}`);
  }
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

export function getQuotesDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'quotes');
}

// Resolve a filename inside the quotes dir, rejecting path traversal.
export function safeQuotesPath(filename) {
  const base = path.resolve(getQuotesDir());
  const target = path.resolve(base, filename);
  if (path.relative(base, target).startsWith('..')) return null;
  return target;
}

// ============= Trading API Client =============

/**
 * Get a trading quote from the Nansen Trading API.
 * Returns quotes with transaction data ready for signing.
 *
 * @param {object} params - Query parameters for GET /quote
 * @returns {Promise<object>} Quote response with quotes[].transaction
 */
export async function getQuote(params) {
  const url = new URL('/quote', TRADING_API_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { 'Accept': 'application/json', 'User-Agent': CLIENT_USER_AGENT, 'X-Client-Type': 'nansen-cli', ...telemetryHeaders() };

  const res = await fetch(url.toString(), { headers });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`Quote API returned non-JSON response (status ${res.status}). This may be a Cloudflare challenge or server error.`),
      { code: 'NON_JSON_RESPONSE', status: res.status, details: text.slice(0, 200) }
    );
  }

  if (!res.ok) {
    const code = body.code || 'QUOTE_ERROR';
    const msg = body.message || `Quote request failed with status ${res.status}`;
    throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
  }

  return body;
}

/**
 * Broadcast a signed transaction via the Nansen Trading API.
 *
 * @param {object} params
 * @param {string} params.signedTransaction - Base64 (Solana) or 0x hex (EVM)
 * @param {string} [params.chain] - Target chain name
 * @param {string} [params.quoteId] - Backend quote ID for BI correlation
 * @param {string} [params.requestId] - Optional Jupiter request ID (Solana only)
 * @param {boolean} [params.simulate] - Run pre-broadcast simulation
 * @returns {Promise<object>} Execution result
 */
export async function executeTransaction(params, { retries = 2, retryDelayMs = 1500 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': CLIENT_USER_AGENT,
    'X-Client-Type': 'nansen-cli',
    ...telemetryHeaders(),
  };
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }

    const res = await fetch(`${TRADING_API_URL}/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const chainType = params.chain && CHAIN_MAP[params.chain]?.type;
      const feeHint = res.status === 502
        ? chainType === 'solana'
          ? ' This often means the transaction failed simulation — check that you have enough SOL for fees (~0.005 SOL minimum).'
          : chainType === 'evm'
            ? ' This often means the transaction failed simulation — check that you have enough ETH for gas fees.'
            : ''
        : '';
      lastError = Object.assign(
        new Error(`Execute API returned non-JSON response (status ${res.status}).${feeHint || ' This may be a Cloudflare challenge or server error.'}`),
        { code: 'BROADCAST_FAILED', status: res.status, details: text.slice(0, 200) }
      );
      // Retry on 502/503 (likely transient Cloudflare issues)
      if ((res.status === 502 || res.status === 503) && attempt < retries) continue;
      throw lastError;
    }

    if (!res.ok) {
      const code = body.code || 'EXECUTE_ERROR';
      const msg = body.message || `Execute request failed with status ${res.status}`;
      throw Object.assign(new Error(msg), { code, status: res.status, details: body.details });
    }

    return body;
  }
  throw lastError;
}

// ============= Bridge Status =============

/**
 * Check the status of a cross-chain bridge transaction.
 * Retries on 502/503 (Cloudflare/upstream gateway hiccups) like executeTransaction.
 * @param {string} txHash - Source chain transaction hash
 * @param {string} fromChain - Source chain name (e.g. 'base')
 * @param {string} toChain - Destination chain name (e.g. 'solana')
 * @param {object} [opts]
 * @param {string} [opts.aggregator] - 'lifi' (default) or 'relay'. Relay txHashes
 *   return NOT_FOUND when polled with the LiFi default, so this must be set.
 * @param {number} [opts.retries=2] - Retry count for 502/503.
 * @param {number} [opts.retryDelayMs=1500] - Delay between retries.
 * @returns {Promise<object>} Bridge status
 */
export async function getBridgeStatus(txHash, fromChain, toChain, { aggregator, retries = 2, retryDelayMs = 1500 } = {}) {
  const fromConfig = resolveChain(fromChain);
  const toConfig = resolveChain(toChain);
  const url = new URL('/bridge/status', TRADING_API_URL);
  url.searchParams.set('txHash', txHash);
  url.searchParams.set('fromChain', fromConfig.lifiChainId || fromConfig.index);
  url.searchParams.set('toChain', toConfig.lifiChainId || toConfig.index);
  if (aggregator) url.searchParams.set('aggregator', aggregator);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, retryDelayMs));

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': CLIENT_USER_AGENT,
        'X-Client-Type': 'nansen-cli',
        ...telemetryHeaders(),
      },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON response (typically Cloudflare HTML on 502/503). Don't leak the
      // HTML body to the user — surface a clean status hint and a retry tip.
      const hint = res.status === 502 || res.status === 503
        ? ' Upstream bridge service is temporarily unavailable. Retry in a moment, or check the source-chain explorer to confirm the tx landed.'
        : '';
      lastError = Object.assign(
        new Error(`Bridge status API returned non-JSON response (status ${res.status}).${hint}`),
        { code: 'BRIDGE_STATUS_ERROR', status: res.status }
      );
      if ((res.status === 502 || res.status === 503) && attempt < retries) continue;
      throw lastError;
    }
    if (!res.ok) {
      const isTransient = res.status === 502 || res.status === 503;
      lastError = Object.assign(
        new Error(body.message || `Bridge status check failed with status ${res.status}`),
        { code: body.code || 'BRIDGE_STATUS_ERROR', status: res.status, details: body.details }
      );
      if (isTransient && attempt < retries) continue;
      throw lastError;
    }
    return body;
  }
  throw lastError;
}

/**
 * Poll bridge status until completion or timeout.
 * @param {string} txHash - Source chain transaction hash
 * @param {string} fromChain - Source chain name
 * @param {string} toChain - Destination chain name
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=600000] - Timeout (default 10 min)
 * @param {number} [opts.pollMs=10000] - Poll interval (default 10s)
 * @param {Function} [opts.log=console.log] - Logger
 * @param {string} [opts.aggregator] - 'lifi' or 'relay'; forwarded to bridge-status query.
 * @returns {Promise<object>} Final bridge status
 */
export async function pollBridgeStatus(txHash, fromChain, toChain, { timeoutMs = 600000, pollMs = 10000, log = console.log, aggregator } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let status;
    try {
      status = await getBridgeStatus(txHash, fromChain, toChain, { aggregator });
    } catch (err) {
      // Transient errors (502, 503, network failures) — retry after poll interval.
      log(`  Bridge: poll error (${err.status || err.code || 'unknown'}) — retrying...`);
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    const sending = status.sending?.status || status.status || 'pending';
    const receiving = status.receiving?.status || 'pending';
    log(`  Bridge: ${sending} → ${receiving}`);

    const isTerminal = status.status === 'DONE' || status.receiving?.status === 'DONE';
    if (isTerminal) {
      if (status.substatus === 'REFUNDED') {
        log(`  Bridge: REFUNDED — funds returned on source chain`);
      }
      return status;
    }
    if (status.status === 'FAILED') {
      throw Object.assign(
        new Error(`Bridge failed: ${status.substatusMessage || 'unknown error'}`),
        { code: 'BRIDGE_FAILED', details: status }
      );
    }

    await new Promise(r => setTimeout(r, pollMs));
  }
  throw Object.assign(
    new Error(`Bridge status polling timed out after ${timeoutMs / 1000}s. Check manually with: nansen trade bridge-status --tx-hash ${txHash} --from-chain ${fromChain} --to-chain ${toChain}`),
    { code: 'BRIDGE_TIMEOUT' }
  );
}

// Tx records keep aggregator metadata for `bridge-status`. They're not stale-able
// the way quotes are (a finished tx doesn't expire), but cap them to bound disk use.
const TX_RECORD_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

/**
 * Persist a tx → aggregator mapping for cross-chain swaps so `bridge-status`
 * can pass the right `aggregator` query param without a new CLI flag.
 * Lives next to saved quotes; uses a 30-day TTL (longer than quotes) so users
 * can still resolve the aggregator hours/days after the swap.
 */
export function saveTxRecord(txHash, { aggregator, requestId, fromChain, toChain }) {
  if (!txHash) return;
  const filePath = safeQuotesPath(`tx-${txHash}.json`);
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = { txHash, aggregator, requestId, fromChain, toChain, timestamp: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Load a previously saved tx record. Returns null if not found or older than 30 days.
 */
export function loadTxRecord(txHash) {
  if (!txHash) return null;
  const filePath = safeQuotesPath(`tx-${txHash}.json`);
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Date.now() - data.timestamp > TX_RECORD_TTL_MS) {
      fs.unlinkSync(filePath);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ============= Quote Storage =============

/**
 * Save a quote response to disk for later execution.
 * @returns {string} Quote ID
 */
export function saveQuote(quoteResponse, chain, signerType = 'local', privyWalletIds = null, toChain = null, meta = {}) {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const timestamp = Date.now();
  const hash = crypto.randomBytes(4).toString('hex');
  const quoteId = `${timestamp}-${hash}`;

  const data = { quoteId, type: 'swap', chain, timestamp, signerType, response: quoteResponse };
  if (toChain) data.toChain = toChain;
  if (privyWalletIds) data.privyWalletIds = privyWalletIds;
  // Persisted so the execute path can scope ERC-20 approvals to the trade
  // (exactOut is buffered by the slippage that was actually used).
  if (meta.swapMode) data.swapMode = meta.swapMode;
  if (meta.slippage != null) data.slippage = meta.slippage;

  fs.writeFileSync(path.join(dir, `${quoteId}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
  cleanupQuotes();
  return quoteId;
}

/**
 * Load a saved quote by ID.
 */
export function loadQuote(quoteId) {
  const filePath = safeQuotesPath(`${quoteId}.json`);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Quote "${quoteId}" not found. Quotes expire after 1 hour.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Date.now() - data.timestamp > 3600000) {
    fs.unlinkSync(filePath);
    throw new Error('Quote has expired. Please request a new quote.');
  }
  // Guard against running a bridge quote through the swap path. Older swap
  // quotes predate the `type` field, so only reject a known-mismatched type.
  if (data.type && data.type !== 'swap') {
    throw new Error(`Quote "${quoteId}" is a ${data.type} quote. Use the matching command (e.g. "nansen bridge execute" for a bridge quote).`);
  }
  return data;
}

/**
 * Remove stale files from the quotes dir. Quote files use a 1-hour TTL because
 * the price is stale; tx records use a 30-day TTL because a finalized tx hash
 * is permanent and `bridge-status` needs the aggregator hint long after execute.
 */
export function cleanupQuotes() {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const ttl = file.startsWith('tx-') ? TX_RECORD_TTL_MS : 3600000;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (now - data.timestamp > ttl) fs.unlinkSync(path.join(dir, file));
    } catch { /* ignore */ }
  }
}

// ============= Transaction Signing =============

// ----------------------------------------------------------------
// TODO: SECURITY REVIEW REQUIRED
// The signing functions below construct and sign raw transactions.
// They MUST be audited before any production/mainnet use.
// ----------------------------------------------------------------

/**
 * Sign a Solana transaction from quote data.
 *
 * The trading API returns a base64-encoded serialized VersionedTransaction
 * in quote.transaction. We deserialize, sign with Ed25519, re-serialize.
 *
 * Based on the e2e test pattern:
 *   const serializedTx = Buffer.from(quote.transaction, 'base64')
 *   const tx = VersionedTransaction.deserialize(serializedTx)
 *   tx.sign([signer])
 *
 * We replicate this without @solana/web3.js using raw crypto.
 *
 * @param {string} transactionBase64 - Base64-encoded serialized VersionedTransaction
 * @param {string} privateKeyHex - 128-char hex (64 bytes: seed + pubkey)
 * @returns {string} Base64-encoded signed transaction
 */
// ⚠️ SECURITY: Solana transaction signing - requires thorough review before production use
export function signSolanaTransaction(transactionBase64, privateKeyHex) {
  const txBytes = Buffer.from(transactionBase64, 'base64');

  // Extract Ed25519 seed (first 32 bytes of the 64-byte keypair)
  const seed = Buffer.from(privateKeyHex.slice(0, 64), 'hex');

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  // VersionedTransaction wire format:
  // [signatures_count (compact-u16)] [signatures (64 bytes each)...] [message_bytes...]
  const { value: sigCount, size: sigCountSize } = readCompactU16(txBytes, 0);
  const messageOffset = sigCountSize + (sigCount * 64);
  const messageBytes = txBytes.subarray(messageOffset);

  // Sign the message bytes
  const signature = crypto.sign(null, messageBytes, privateKey);

  // Write signature into the first slot (fee payer = our wallet)
  const signedTx = Buffer.from(txBytes);
  signature.copy(signedTx, sigCountSize);

  return signedTx.toString('base64');
}

/**
 * Sign an EVM transaction from quote data.
 *
 * The trading API returns transaction fields in quote.transaction:
 *   { to, data, value?, gas?, gasPrice? }
 *
 * The nonce must be fetched from the chain RPC.
 *
 * Emits an EIP-1559 (type 2) transaction when the quote supplies fee-cap
 * fields, and a legacy (type 0) one otherwise. Quotes from the trading API and
 * from Relay both carry maxFeePerGas/maxPriorityFeePerGas, so type 2 is the
 * normal path; flattening those into a single legacy gasPrice — as this used to
 * do — discards the fee cap the aggregator computed and leaves the transaction
 * unincludable the moment the base fee rises past it.
 *
 * @param {object} txData - Transaction fields from a quote { to, data, value, gas, gasPrice | maxFeePerGas + maxPriorityFeePerGas }
 * @param {string} privateKeyHex - 64-char hex (32-byte secp256k1 private key)
 * @param {string} chain - Chain name
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed transaction hex
 */
// ⚠️ SECURITY: EVM transaction signing - requires thorough review before production use
export function signEvmTransaction(txData, privateKeyHex, chain, nonce) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig || chainConfig.type !== 'evm') {
    throw new Error(`Unsupported EVM chain: ${chain}`);
  }

  const common = {
    nonce,
    gasLimit: toHex(txData.gas || txData.gasLimit || '210000'),
    to: txData.to,
    value: toHex(txData.value || '0'),
    data: txData.data || '0x',
    chainId: chainConfig.chainId,
  };

  if (txData.maxFeePerGas) {
    return signEip1559Transaction({
      ...common,
      maxFeePerGas: toHex(txData.maxFeePerGas),
      // A zero priority fee is a valid choice but not a sane default, so fall
      // back to the fee cap rather than to nothing when the quote omits it.
      maxPriorityFeePerGas: toHex(txData.maxPriorityFeePerGas || txData.maxFeePerGas),
    }, privateKeyHex);
  }

  // Previously this fell back to a gasPrice of 1 wei, which signs a transaction
  // that can never be mined and burns the nonce. Refuse instead: a quote with no
  // fee information at all is a bug upstream, not something to sign through.
  if (!txData.gasPrice) {
    throw new Error(
      'Quote supplied no gas price (expected gasPrice or maxFeePerGas), so any signed transaction would be unmineable. Refusing to sign.',
    );
  }

  return signLegacyTransaction({ ...common, gasPrice: toHex(txData.gasPrice) }, privateKeyHex);
}

// How many queued-but-unmined transactions we are willing to sign past.
//
// `pending` counts mempool-queued transactions as well as mined ones, and that is
// what callers want: the bridge signs its approve and deposit steps back to back,
// so the second has to be numbered after the first while the first is still
// pending. But a transaction that *cannot* be mined — priced below what the chain
// is currently including — keeps the count elevated for as long as it sits there,
// and every later signature is numbered behind it, unexecutable until it clears.
//
// One or two in flight is normal for a multi-step run. Beyond that, something is
// wedged, and adding another transaction to the queue cannot help.
const MAX_PENDING_NONCE_GAP = 2;

/**
 * Fetch the next nonce for an EVM address, reconciled against the mined count.
 *
 * Returns a DECIMAL number, not a hex string — callers must not decode it again.
 * (bridge.js did, and `parseInt(20, 16)` is 32: a wallet at nonce 20 signed at
 * 32, which no node can execute. It only showed up past nonce 9, where decimal
 * and hex digits diverge.)
 *
 * @param {string} chain - Chain name
 * @param {string} address - 0x address
 * @returns {Promise<number>} Next nonce, decimal
 */
export async function getEvmNonce(chain, address) {
  const [pendingHex, latestHex] = await Promise.all([
    evmRpcCall(chain, 'eth_getTransactionCount', [address, 'pending']),
    evmRpcCall(chain, 'eth_getTransactionCount', [address, 'latest']),
  ]);
  const pending = parseInt(pendingHex, 16);
  const latest = parseInt(latestHex, 16);
  if (!Number.isInteger(pending) || !Number.isInteger(latest)) {
    throw new Error(
      `Could not read the nonce for ${address} on ${chain} (pending: ${pendingHex}, latest: ${latestHex}).`,
    );
  }

  const gap = pending - latest;
  if (gap > MAX_PENDING_NONCE_GAP) {
    // Refuse rather than pile on. Signing at `pending` here produces a
    // transaction that cannot execute until everything ahead of it does, and the
    // symptom the operator sees is only "no receipt" — no indication that the
    // real problem is a transaction from an earlier run.
    throw new Error(
      `${address} has ${gap} unmined transactions queued on ${chain} (next mined nonce ${latest}, next pending ${pending}). `
      + `Signing another would queue behind them and stay unexecutable until they clear. `
      + `Replace the transaction at nonce ${latest} with a higher fee first: request a fresh quote and run `
      + `"nansen bridge execute --quote <id> --nonce ${latest} --priority-fee <gwei>". `
      + `Note that a load-balanced public RPC may deny holding a transaction it does in fact hold, so do not diagnose from one endpoint.`,
    );
  }

  return pending;
}

/**
 * Wait for an EVM transaction to be confirmed on-chain.
 * Polls eth_getTransactionReceipt until receipt is available or timeout.
 *
 * @param {string} chain - Chain name
 * @param {string} txHash - Transaction hash (0x...)
 * The default window is deliberately generous: by the time this is called the
 * transaction is already broadcast, so giving up early converts "still
 * confirming" into a hard failure the caller has to interpret, without undoing
 * anything. A tight 30s window did exactly that during a real Base deposit.
 *
 * @param {string} chain - Chain name
 * @param {string} txHash - Transaction hash (0x...)
 * @param {number} [timeoutMs=180000] - Max wait time
 * @param {number} [pollMs=2000] - Poll interval
 * @returns {Promise<object>} Transaction receipt
 */
export async function waitForReceipt(chain, txHash, timeoutMs = 180000, pollMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await evmRpcCall(chain, 'eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        const status = parseInt(receipt.status, 16);
        if (status !== 1) {
          throw new Error(`Transaction reverted on-chain (status: ${receipt.status}). Tx: ${txHash}`);
        }
        return receipt;
      }
    } catch (e) {
      // Re-throw confirmed on-chain reverts immediately; swallow transient RPC/network errors
      if (e.message?.startsWith('Transaction reverted')) throw e;
      // else: continue polling (pending tx, transient network error, etc.)
    }
    // Receipt not yet available — wait and retry
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Transaction receipt not found after ${timeoutMs}ms. Tx: ${txHash}`);
}

/**
 * Simulate an EVM transaction via eth_call before broadcasting.
 * Returns { success: true } or { success: false, reason: string }.
 */
export async function simulateEvmCall(chain, { from, to, data, value, gas }) {
  if (!CHAIN_RPCS[chain]) return { success: true }; // Can't simulate, skip

  try {
    const callObj = { from, to, data, value: value || '0x0' };
    if (gas) callObj.gas = gas; // Pass gas limit to catch under-gassed quotes
    await evmRpcCall(chain, 'eth_call', [callObj, 'latest']);
    return { success: true };
  } catch (e) {
    const msg = e.message || 'unknown';
    // Only block on actual contract-level revert errors from the RPC
    if (msg.startsWith('RPC error (eth_call):')) {
      const rawReason = msg.replace(/^RPC error \(eth_call\): /, '');
      // Convert raw "insufficient funds" RPC errors (amounts in wei) into a human-readable message.
      // EVM nodes emit: "insufficient funds for gas * price + value: address 0x... have X want Y (supplied gas Z)"
      // TODO: full fix would be a pre-flight eth_getBalance check at quote-fetch time so the error
      //       surfaces before simulation with an estimated ETH requirement — see PR for this fix.
      const m = rawReason.match(/insufficient funds[\s\S]*?\bhave (\d+)\s+want (\d+)/i);
      if (m) {
        const haveWei = BigInt(m[1]);
        const wantWei = BigInt(m[2]);
        const haveEth = (Number(haveWei) / 1e18).toFixed(6);
        const wantEth = (Number(wantWei) / 1e18).toFixed(6);
        const fundHint = from ? ` Send ETH to ${from} before trading.` : '';
        return {
          success: false,
          reason: `Insufficient ETH: wallet has ${haveEth} ETH but this trade needs ~${wantEth} ETH (amount + gas).${fundHint}`,
        };
      }
      return { success: false, reason: rawReason };
    }
    // Network/infrastructure errors (fetch failure, rate limit, non-JSON response) → non-blocking
    return { success: true };
  }
}

/**
 * Estimate gas for an EVM transaction. Returns the gas estimate or null on failure.
 * Used to fix under-gassed quotes from aggregators.
 */
export async function estimateEvmGas(chain, { from, to, data, value }) {
  if (!CHAIN_RPCS[chain]) return null;

  try {
    const result = await evmRpcCall(chain, 'eth_estimateGas', [{ from, to, data, value: value || '0x0' }]);
    return parseInt(result, 16);
  } catch {
    return null;
  }
}

/**
 * Check ERC-20 allowance for a given owner/spender pair.
 * Returns the allowance as a BigInt, or 0n on failure.
 */
export async function checkErc20Allowance(chain, tokenAddress, ownerAddress, spenderAddress) {
  if (!CHAIN_RPCS[chain]) return 0n;

  try {
    // allowance(address,address) selector = 0xdd62ed3e
    const data = '0xdd62ed3e'
      + ownerAddress.slice(2).toLowerCase().padStart(64, '0')
      + spenderAddress.slice(2).toLowerCase().padStart(64, '0');
    const result = await evmRpcCall(chain, 'eth_call', [{ to: tokenAddress, data }, 'latest']);
    if (!result) return 0n;
    return BigInt(result);
  } catch {
    return 0n;
  }
}

/**
 * Compute the ERC-20 allowance to grant for a swap.
 *
 * Scoping the approval to the trade amount (instead of an unlimited MAX approval)
 * means a malicious or buggy quote can consume at most this one swap's input,
 * never the wallet's full token balance. exactIn pulls exactly the input amount;
 * exactOut can pull up to a slippage-bounded maximum, so that mode is buffered.
 *
 * @param {object} p
 * @param {bigint|string|number} p.inputAmount - The swap's input amount (base units)
 * @param {string} [p.swapMode] - 'exactIn' (default) or 'exactOut'
 * @param {number} [p.slippage] - Slippage fraction for the exactOut buffer (default 0.03)
 * @returns {bigint} Allowance to approve, in base units
 */
export function approvalAmountForSwap({ inputAmount, swapMode, slippage }) {
  const amt = BigInt(inputAmount ?? 0);
  if (amt <= 0n) return amt;
  if (swapMode === 'exactOut') {
    // Honour an explicit slippage of 0 (tightest approval); only fall back to the
    // 3% default when slippage wasn't provided (undefined/NaN) or is negative.
    const slip = Number.isFinite(slippage) && slippage >= 0 ? slippage : 0.03;
    // Buffer by slippage using basis-point integer math to stay in BigInt.
    const bps = BigInt(Math.ceil((1 + slip) * 10000));
    return (amt * bps + 9999n) / 10000n; // ceil division
  }
  return amt;
}

/**
 * Sanity-check the target of a swap transaction before signing it.
 *
 * This is a defensive gate, not a router allowlist. It rejects the crude cases
 * where the transaction clearly isn't a swap routed through an aggregator: a
 * null/zero target, or a call straight at the token being sold (which would
 * encode a transfer/approve of that token rather than a swap — the one
 * full-balance drain that needs no prior approval). It also confirms the target
 * carries contract code. The code check is best-effort: if the RPC is
 * unreachable we warn and proceed rather than block a real trade on a flaky
 * endpoint.
 *
 * Throws on a definitive rejection; returns nothing on pass. Callers run this
 * inside the per-quote try so a rejected quote falls through to the next one.
 *
 * @param {string} chain - Chain name
 * @param {string} to - Transaction target (quote.transaction.to)
 * @param {string} inputMint - The token being sold (quote.inputMint)
 */
export async function validateSwapTarget(chain, to, inputMint) {
  if (!to || /^0x0+$/i.test(to)) {
    throw new Error(`Swap target address is empty or zero (${to ?? 'undefined'}). Refusing to sign.`);
  }
  // A legit swap routes through an aggregator/router, never the sold token
  // itself. (A WETH-style direct unwrap can trip this; re-quote or use the
  // native sentinel 0xeee…eee if so — the drain protection is worth the edge.)
  if (inputMint && to.toLowerCase() === inputMint.toLowerCase()) {
    throw new Error(
      `Swap target equals the token being sold (${to}). A swap routes through an aggregator, not the token itself. Refusing to sign.`,
    );
  }
  let code;
  try {
    code = await evmRpcCall(chain, 'eth_getCode', [to, 'latest']);
  } catch {
    process.stderr.write(`  ⚠ Could not verify swap target ${to} is a contract (RPC unavailable); proceeding.\n`);
    return;
  }
  if (!code || code === '0x' || code === '0x0') {
    throw new Error(`Swap target ${to} is not a contract (no code). Refusing to sign.`);
  }
}

/**
 * Reject an approval whose spender is empty or the zero address. A real
 * aggregator spender is always a contract; a zero spender means the quote is
 * malformed or tampered, so we refuse rather than sign an approval to nowhere.
 */
function assertUsableSpender(spenderAddress) {
  if (!spenderAddress || /^0x0+$/i.test(spenderAddress)) {
    throw new Error(`Approval spender is empty or the zero address (${spenderAddress ?? 'undefined'}). Refusing to sign an approval.`);
  }
}

/**
 * Send an ERC-20 approval transaction.
 * Required before swapping non-native EVM tokens.
 *
 * @param {string} tokenAddress - ERC-20 token contract
 * @param {string} spenderAddress - Approval target (from quote.approvalAddress)
 * @param {string} privateKeyHex - Wallet private key
 * @param {string} chain - Chain name
 * @param {number} nonce - Account nonce
 * @param {string|number} gasPrice - Legacy gas price
 * @param {bigint|string|number} amount - Allowance to grant, in base units (see approvalAmountForSwap)
 * @returns {string} 0x-prefixed signed approval tx hex
 */
// ⚠️ SECURITY: ERC-20 approval signing - requires thorough review
export function buildApprovalTransaction(tokenAddress, spenderAddress, privateKeyHex, chain, nonce, gasPrice, amount) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig) throw new Error(`Unsupported chain: ${chain}`);

  // ERC-20 approve(address spender, uint256 amount) selector = 0x095ea7b3.
  // Scope the approval to the swap's input amount so a malicious or buggy quote
  // can drain at most this one trade, never the wallet's full token balance.
  const amountHex = BigInt(amount).toString(16).padStart(64, '0');
  const data = '0x095ea7b3'
    + spenderAddress.slice(2).toLowerCase().padStart(64, '0')
    + amountHex;

  const tx = {
    nonce,
    gasPrice: toHex(gasPrice || '1000000'),
    gasLimit: '0x186a0', // 100000
    to: tokenAddress,
    value: '0x0',
    data,
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}

// ============= Legacy (Type 0) EVM Transaction Signing =============
// ⚠️ SECURITY: Legacy EVM transaction signing - requires thorough review before production use

/**
 * Strip all leading zero bytes from a buffer.
 * RLP requires minimal encoding, so signature r/s values must not have leading zeros.
 */
export function stripLeadingZeros(buf) {
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  return buf.subarray(i);
}

/**
 * Sign a legacy (type 0) EVM transaction.
 *
 * @param {object} tx - { nonce, gasPrice, gasLimit, to, value, data, chainId }
 * @param {string} privateKeyHex - 32-byte private key as hex
 * @returns {string} 0x-prefixed signed transaction hex
 */
export function signLegacyTransaction(tx, privateKeyHex) {
  // EIP-155 unsigned: RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
  const unsignedFields = [
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.gasPrice),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    rlpNormalize(tx.chainId),
    Buffer.alloc(0), // EIP-155: empty for signing
    Buffer.alloc(0), // EIP-155: empty for signing
  ];

  const unsignedPayload = rlpEncode(unsignedFields);
  const msgHash = keccak256(unsignedPayload);

  // Sign with secp256k1
  const { r, s, v: recoveryBit } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));

  // EIP-155 v = chainId * 2 + 35 + recoveryBit
  const v = tx.chainId * 2 + 35 + recoveryBit;

  // Signed: RLP([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
  const signedFields = [
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.gasPrice),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    rlpNormalize(v),
    stripLeadingZeros(r),
    stripLeadingZeros(s),
  ];

  return '0x' + rlpEncode(signedFields).toString('hex');
}

/**
 * Sign an EIP-1559 (type 2) transaction.
 *
 * Envelope: 0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 * gasLimit, to, value, data, accessList, yParity, r, s]).
 *
 * Type 2 exists here because a legacy transaction pays exactly `gasPrice`: once
 * the base fee rises above it the transaction is not slow, it is permanently
 * unincludable at that nonce. A type-2 transaction pays baseFee + priority
 * capped at maxFeePerGas, so it rides fee movement instead of dying.
 *
 * Note yParity is the raw recovery bit (0/1), not EIP-155's chainId*2+35+bit —
 * the chain id is already a first-class field in the payload.
 */
export function signEip1559Transaction(tx, privateKeyHex) {
  const payloadFields = [
    rlpNormalize(tx.chainId),
    rlpNormalize(tx.nonce),
    rlpNormalize(tx.maxPriorityFeePerGas),
    rlpNormalize(tx.maxFeePerGas),
    rlpNormalize(tx.gasLimit),
    toBuffer(tx.to),
    rlpNormalize(tx.value),
    toBuffer(tx.data || '0x'),
    [], // accessList — always empty; we never build access-listed transactions
  ];

  const msgHash = keccak256(Buffer.concat([Buffer.from([0x02]), rlpEncode(payloadFields)]));
  const { r, s, v: recoveryBit } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));

  const signed = Buffer.concat([
    Buffer.from([0x02]),
    rlpEncode([
      ...payloadFields,
      rlpNormalize(recoveryBit),
      stripLeadingZeros(r),
      stripLeadingZeros(s),
    ]),
  ]);

  return '0x' + signed.toString('hex');
}

export function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') {
    if (v.startsWith('0x')) {
      const hex = v.slice(2);
      if (hex.length === 0) return Buffer.alloc(0);
      return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
    }
    return Buffer.from(v);
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    if (v === 0 || v === 0n) return Buffer.alloc(0);
    const hex = BigInt(v).toString(16);
    return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex');
  }
  return Buffer.alloc(0);
}

/**
 * Convert a value to 0x hex string. Handles decimal strings, hex strings, and numbers.
 */
function toHex(val) {
  if (val === undefined || val === null || val === '' || val === '0' || val === 0) return '0x0';
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  // Decimal string or number → hex
  return '0x' + BigInt(val).toString(16);
}

function rlpNormalize(val) {
  if (val === undefined || val === null || val === '0x0' || val === '0x' || val === 0 || val === '0') {
    return Buffer.alloc(0);
  }
  return toBuffer(val);
}

// ============= Compact-u16 (Solana) =============

/**
 * Read a compact-u16 from a buffer (Solana transaction format).
 */
export function readCompactU16(buf, offset) {
  let value = 0;
  let size = 0;
  for (let i = 0; i < 3; i++) {
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    size++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, size };
}

// ============= Chain Utilities =============

/**
 * Resolve chain name to config.
 */
export function resolveChain(chainName) {
  const chain = CHAIN_MAP[chainName?.toLowerCase()];
  if (!chain) {
    throw new Error(`Unsupported chain "${chainName}". Supported: ${Object.keys(CHAIN_MAP).join(', ')}`);
  }
  return chain;
}

/**
 * Get wallet chain type for address lookup.
 */
export function getWalletChainType(chainName) {
  return resolveChain(chainName).type;
}

// ============= CLI Helpers =============

function resolveTradePassword() {
  const { password, source } = retrievePassword();
  if (source === 'file') {
    process.stderr.write(
      '⚠️  Password loaded from ~/.nansen/wallets/.credentials (insecure — plaintext on disk).\n' +
      '   For better security, migrate to OS keychain: nansen wallet secure\n'
    );
  }
  return password;
}

function isNativeToken(mintAddress) {
  if (!mintAddress) return false;
  if (mintAddress.startsWith('0x')) return /^0x[eE]{40}$/.test(mintAddress);
  // Solana: WSOL mint (Jupiter/LiFi) and System Program (Relay) both denote native SOL.
  return mintAddress === 'So11111111111111111111111111111111111111112'
      || mintAddress === NATIVE_SOL_SYSTEM_MINT;
}

/**
 * Check if --from is a wrapped native token or native sentinel and return
 * a warning string, or null if no warning is needed. Pure function.
 */
export function getWrappedNativeFromWarning(tokenAddress, chain) {
  if (!tokenAddress || !chain) return null;
  const wrapped = WRAPPED_NATIVE_TOKENS[chain.toLowerCase()];
  if (!wrapped) return null;

  const addr = tokenAddress.toLowerCase();

  // Case 1: --from is wrapped token (e.g. WETH) — suggest native sentinel
  if (addr === wrapped.address.toLowerCase()) {
    return `Warning: --from is ${wrapped.symbol} (wrapped ${wrapped.nativeSymbol}). ` +
      `If you hold native ${wrapped.nativeSymbol}, use: 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`;
  }

  // Case 2: --from is native sentinel — mention the wrapped alternative
  if (isNativeToken(tokenAddress)) {
    return `Warning: --from is native ${wrapped.nativeSymbol}. ` +
      `If you hold ${wrapped.symbol} instead, use: ${wrapped.address}`;
  }

  return null;
}

// ============= Token Decimal Resolution =============

// Hardcoded decimals for well-known tokens — avoids RPC calls in the common case.
const KNOWN_DECIMALS = {
  // Solana
  'So11111111111111111111111111111111111111112': 9,   // SOL/WSOL
  '11111111111111111111111111111111': 9,              // Native SOL (Relay system-mint sentinel)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,  // USDT
  // Base (EVM) — lowercase for case-insensitive matching
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 18, // ETH native
  '0x4200000000000000000000000000000000000006': 18, // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6, // USDT
};

/**
 * Resolve the number of decimals for a token.
 * Checks a hardcoded map first, then falls back to an RPC call.
 * Solana: getAccountInfo with jsonParsed encoding.
 * EVM: eth_call to decimals() selector 0x313ce567.
 */
export async function resolveTokenDecimals(tokenAddress, chainName) {
  // Normalise for map lookup (EVM addresses are case-insensitive)
  const key = tokenAddress.startsWith('0x') ? tokenAddress.toLowerCase() : tokenAddress;
  if (KNOWN_DECIMALS[key] !== undefined) return KNOWN_DECIMALS[key];

  const chain = chainName.toLowerCase();
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig) throw new Error(`Unknown chain: ${chain}`);

  // Validate address format before making RPC calls.
  // A bare symbol like "SOL" that didn't resolve means it's not recognized on this chain.
  if (chainConfig.type === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) {
      throw new Error(`"${tokenAddress}" is not a recognized token on ${chainName}. Use a valid Solana address (base58, 32-44 chars).`);
    }
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
      throw new Error(`"${tokenAddress}" is not a recognized token on ${chainName}. Use a valid EVM address (0x + 40 hex chars).`);
    }
  }

  if (chainConfig.type === 'solana') {
    const rpcUrl = CHAIN_RPCS.solana;
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [tokenAddress, { encoding: 'jsonParsed' }] }),
    });
    const body = await res.json();
    const decimals = body.result?.value?.data?.parsed?.info?.decimals;
    if (decimals === undefined) throw new Error(`Could not resolve decimals for Solana token ${tokenAddress}`);
    return decimals;
  }

  // EVM — eth_call to decimals()
  const result = await evmRpcCall(chain, 'eth_call', [{ to: tokenAddress, data: '0x313ce567' }, 'latest']);
  const decimals = parseInt(result, 16);
  if (isNaN(decimals) || decimals > 255) throw new Error(`Could not resolve decimals for EVM token ${tokenAddress}`);
  return decimals;
}

/**
 * Convert a human-readable token amount to base units using string math.
 * Avoids floating-point precision issues by operating on digit strings.
 * Example: convertToBaseUnits('0.5', 9) => '500000000'
 */
export function convertToBaseUnits(amount, decimals) {
  const str = String(amount);
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid amount: "${str}". Must be a non-negative number (e.g. "0.5", "100").`);
  }
  const dotIndex = str.indexOf('.');
  if (dotIndex === -1) {
    // Whole number — append zeros and strip leading zeros
    const raw = str + '0'.repeat(decimals);
    return raw.replace(/^0+/, '') || '0';
  }
  const whole = str.slice(0, dotIndex);
  let frac = str.slice(dotIndex + 1);
  if (frac.length > decimals) {
    // Reject if meaningful (non-zero) digits would be lost
    const excess = frac.slice(decimals);
    if (/[1-9]/.test(excess)) {
      throw new Error(`Amount "${str}" has more fractional digits than the token supports (${decimals} decimals). The smallest unit is ${decimals === 0 ? '1 token' : '0.' + '0'.repeat(decimals - 1) + '1'}.`);
    }
    frac = frac.slice(0, decimals);
  } else {
    frac = frac.padEnd(decimals, '0');
  }
  // Strip leading zeros from the combined result
  const raw = (whole + frac).replace(/^0+/, '') || '0';
  return raw;
}

/**
 * Fetch the current USD price for a token via the Nansen search API.
 * Used by --amount-unit usd to convert dollar amounts to token amounts.
 */
export async function resolveUsdPrice(apiInstance, tokenAddress, chain) {
  const result = await apiInstance.generalSearch({
    query: tokenAddress,
    resultType: 'token',
    chain,
    limit: 1,
  });
  const isEvm = tokenAddress.startsWith('0x');
  const token = result.tokens?.find(t =>
    isEvm ? t.address?.toLowerCase() === tokenAddress.toLowerCase() : t.address === tokenAddress
  );
  if (!token?.price) {
    throw new Error(`Could not resolve USD price for ${tokenAddress} on ${chain}. The token may not have pricing data.`);
  }
  return token.price;
}

/**
 * Check if amount contains a decimal point (i.e. not in base units).
 * Returns an error string if invalid, or null if OK. Pure function.
 */
export function validateBaseUnitAmount(amount) {
  if (!amount) return null;
  const str = String(amount);
  if (str.startsWith('-')) {
    return 'Amount cannot be negative. Got: ' + str;
  }
  if (str.includes('.')) {
    return 'Amount must be in base units (integer). ' +
      'Use --amount-unit token to specify token amounts (e.g. --amount 0.5 --amount-unit token). ' +
      'Examples: 1000000000 lamports = 1 SOL, 1000000000000000000 wei = 1 ETH, ' +
      '1000000 = 1 USDC. Got: ' + str;
  }
  return null;
}

export function formatQuote(quote, index) {
  const lines = [];
  const label = index !== undefined ? `  Quote #${index + 1}` : '  Best Quote';
  lines.push(`${label} (${quote.aggregator || 'unknown'})`);
  lines.push(`    Input:        ${quote.inAmount} → ${quote.inputMint?.slice(0, 12)}...`);
  lines.push(`    Output:       ${quote.outAmount} → ${quote.outputMint?.slice(0, 12)}...`);
  if (quote.inUsdValue)  lines.push(`    In USD:       $${quote.inUsdValue}`);
  if (quote.outUsdValue) lines.push(`    Out USD:      $${quote.outUsdValue}`);
  if (quote.priceImpactPct) {
    const impactAbs = Math.abs(parseFloat(quote.priceImpactPct));
    if (impactAbs <= 5) {
      lines.push(`    Price Impact: ${impactAbs}%`);
    }
  }
  if (quote.tradingFeeInUsd) lines.push(`    Trading Fee:  $${quote.tradingFeeInUsd}`);
  if (quote.networkFeeInUsd) lines.push(`    Network Fee:  $${quote.networkFeeInUsd}`);
  // Empty string is Relay's "no approval needed" sentinel — gate on truthy + non-empty.
  if (quote.approvalAddress && quote.approvalAddress !== '' && !isNativeToken(quote.inputMint)) {
    lines.push(`    ⚠ Requires token approval to: ${quote.approvalAddress}`);
  }
  const meta = quote.metadata || {};
  if (meta.isCrossChain) {
    if (meta.bridgeTool) lines.push(`    Bridge:       ${meta.bridgeTool}`);
    // LiFi uses executionDuration; Relay uses estimatedTimeSeconds.
    const durationSec = meta.executionDuration ?? meta.estimatedTimeSeconds;
    if (durationSec) {
      const mins = Math.round(durationSec / 60);
      lines.push(`    Est. Time:    ${mins < 1 ? '< 1 min' : `~${mins} min`}`);
    }
    if (meta.feeCosts?.length) {
      const totalFees = meta.feeCosts.reduce((sum, f) => sum + parseFloat(f.amountUSD || 0), 0);
      if (totalFees > 0) {
        const feeStr = totalFees < 0.01 ? totalFees.toPrecision(1) : totalFees.toFixed(2);
        lines.push(`    Bridge Fees:  $${feeStr}`);
      }
    }
  }
  if (quote.priceImpactPct) {
    const impactAbs = Math.abs(parseFloat(quote.priceImpactPct));
    if (impactAbs > 5) {
      lines.push(`    ⚠ Price impact is ${impactAbs}%! You may lose significant value.`);
    }
  }
  return lines.join('\n');
}

// ============= CLI Command Builder =============

/**
 * Build trading command handlers for CLI integration.
 */
export function buildTradingCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'quote': async (args, apiInstance, flags, options) => {
      const chain = options.chain || args[0];
      const toChainRaw = options['to-chain'];
      const fromRaw = options.from || options['from-token'] || args[1];
      const toRaw = options.to || options['to-token'] || args[2];
      const effectiveToChain = toChainRaw || chain;
      const from = resolveTokenAddress(fromRaw, chain);
      const to = resolveTokenAddress(toRaw, effectiveToChain);
      const amount = options.amount || args[3];
      const walletName = options.wallet;
      const toWallet = options['to-wallet'];
      const slippage = options.slippage;
      const autoSlippage = flags['auto-slippage'];
      const maxAutoSlippage = options['max-auto-slippage'];
      const swapMode = options['swap-mode'] || 'exactIn';
      const amountUnit = options['amount-unit'];
      const aggregatorFilter = options.aggregator;
      if (aggregatorFilter && !['lifi', 'relay', 'jupiter', 'okx'].includes(aggregatorFilter)) {
        throw new CommandError(
          `Invalid --aggregator: "${aggregatorFilter}". Use one of: lifi, relay, jupiter, okx.`,
          'INVALID_AGGREGATOR'
        );
      }
      // Slippage is a decimal fraction (0.03 = 3%). Reject non-numeric or
      // out-of-range values so a percent-vs-decimal mix-up (e.g. "3" meaning 3%)
      // can't become a 300% slippage tolerance.
      for (const [optName, optVal] of [['slippage', slippage], ['max-auto-slippage', maxAutoSlippage]]) {
        if (optVal == null) continue;
        const n = Number(optVal);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new CommandError(
            `Invalid --${optName} "${optVal}". Use a decimal between 0 and 1 (e.g. 0.03 for 3%).`,
            'INVALID_SLIPPAGE'
          );
        }
      }

      if (!chain || !from || !to || !amount) {
        throw new CommandError(`
Usage: nansen trade quote --chain <chain> --from <token> --to <token> --amount <baseUnits>

PREREQUISITE:
  A wallet must be configured before using this command (the trading API builds
  a transaction specific to your sender address).
  Set one up with: nansen wallet create

OPTIONS:
  --chain <chain>           Source chain: solana, base
  --to-chain <chain>        Destination chain for cross-chain swap (e.g. solana, base)
  --from <symbol|address>   Input token (symbol like SOL, USDC or address)
  --to <symbol|address>     Output token (symbol like USDC, ETH or address)
  --amount <units>          Amount in BASE UNITS (e.g. lamports, wei)
  --amount-unit <unit>      "token" for token units, "usd" for USD, "percent" for % of balance
  --wallet <name>           Wallet name (default: default wallet). Use "walletconnect" or "wc" for WalletConnect.
  --to-wallet <address>     Destination wallet address (auto-derived for cross-chain if omitted)
  --slippage <pct>          Slippage as decimal (e.g. 0.03 for 3%). Default: 0.03
  --auto-slippage           Enable auto slippage calculation
  --max-auto-slippage <pct> Max auto slippage when auto-slippage enabled
  --swap-mode <mode>        exactIn (default) or exactOut
  --aggregator <name>       Force a specific aggregator (lifi, relay, jupiter, okx).
                            Filters the quote list client-side; errors if none match.

EXAMPLES:
  nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
  nansen trade quote --chain solana --from SOL --to USDC --amount 0.5 --amount-unit token
  nansen trade quote --chain solana --from SOL --to USDC --amount 50 --amount-unit usd
  nansen trade quote --chain solana --from SOL --to USDC --amount 100 --amount-unit percent
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000
  nansen trade quote --chain base --to-chain solana --from USDC --to USDC --amount 1000000
  nansen trade quote --chain solana --to-chain base --from SOL --to ETH --amount 1000000000

CROSS-CHAIN NOTES (when using --to-chain):
  Supported combos:
    native → native (ETH <-> SOL)
    USDC → USDC (both directions)
    USDC → native (USDC → ETH or SOL)
    native → USDC (ETH/SOL → USDC)
    non-native → non-native — not supported (use USDC as intermediate)
  Bridge providers: Li.Fi or Relay (selected automatically based on best price)
  Typical bridge time: seconds to a few minutes (Relay is usually faster)
`, 'MISSING_ARGS');
      }

      // Validate --amount-unit if provided
      if (amountUnit && amountUnit !== 'token' && amountUnit !== 'base' && amountUnit !== 'usd' && amountUnit !== 'percent') {
        throw new CommandError(`Error: Unknown --amount-unit "${amountUnit}". Supported values: token, base, usd, percent`, 'INVALID_INPUT');
      }

      // --amount-unit percent is only valid for exactIn (sell-side)
      if (amountUnit === 'percent' && swapMode === 'exactOut') {
        throw new CommandError('Error: --amount-unit percent is not supported with --swap-mode exactOut. Percentage is relative to your sell-token balance.', 'INVALID_INPUT');
      }

      // Static input validation — catches common agent errors (wrong addresses,
      // same-token swaps, bad amounts) before any network or wallet call.
      try {
        validateQuoteInput({ chain, toChain: toChainRaw || null, from, to, amount });
      } catch (validationErr) {
        throw new CommandError(`Error: ${validationErr.message}`, 'INVALID_INPUT');
      }

      // When --amount-unit token is used, resolve decimals and convert to base units.
      // Otherwise, validate that the amount is already in base units (integer).
      let resolvedAmount = amount;
      let resolvedDecimals;
      let usdTokenAmount; // token-unit amount after USD conversion (for balance pre-check)
      if (amountUnit === 'usd') {
        try {
          const tokenForPrice = swapMode === 'exactOut' ? to : from;
          const price = await resolveUsdPrice(apiInstance, tokenForPrice, chain);
          resolvedDecimals = await resolveTokenDecimals(tokenForPrice, chain);
          // Convert USD to token amount, then to base units via string math.
          // Use toFixed() instead of String() to avoid scientific notation for small values.
          const tokenAmount = parseFloat(amount) / price;
          usdTokenAmount = tokenAmount.toFixed(resolvedDecimals);
          resolvedAmount = convertToBaseUnits(usdTokenAmount, resolvedDecimals);
        } catch (err) {
          throw new CommandError(`Error converting USD amount: ${err.message}`, 'INVALID_INPUT');
        }
      } else if (amountUnit === 'token') {
        try {
          const tokenForDecimals = swapMode === 'exactOut' ? to : from;
          resolvedDecimals = await resolveTokenDecimals(tokenForDecimals, chain);
          resolvedAmount = convertToBaseUnits(amount, resolvedDecimals);
        } catch (err) {
          throw new CommandError(`Error resolving token decimals: ${err.message}`, 'INVALID_INPUT');
        }
      } else if (amountUnit === 'percent') {
        // Resolved after wallet address is available — see percent resolution block below.
      } else {
        const amountError = validateBaseUnitAmount(amount);
        if (amountError) {
          throw new CommandError(`Error: ${amountError}`, 'INVALID_INPUT');
        }
      }

      try {
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type === 'evm' ? 'evm' : 'solana';

        const isWalletConnect = walletName === 'walletconnect' || walletName === 'wc';

        let walletAddress;
        let walletProvider = 'local';
        let privyWalletIds = null;
        if (isWalletConnect) {
          walletAddress = await getWalletConnectAddress(chainType);
          if (!walletAddress) {
            throw new CommandError('No WalletConnect session active. Run: walletconnect connect', 'NO_WALLET');
          }
        } else if (walletName) {
          const wallet = showWallet(walletName);
          walletAddress = chainType === 'solana' ? wallet.solana : wallet.evm;
          if (wallet.provider === 'privy') {
            walletProvider = 'privy';
            privyWalletIds = wallet.privyWalletIds;
          }
        } else {
          try {
            const config = getWalletConfig();
            if (config.defaultWallet) {
              const wallet = showWallet(config.defaultWallet);
              walletAddress = chainType === 'solana' ? wallet.solana : wallet.evm;
              if (wallet.provider === 'privy') {
                walletProvider = 'privy';
                privyWalletIds = wallet.privyWalletIds;
              }
            }
          } catch {
            // No wallet configured — fall through to the check below
          }
        }

        if (!walletAddress) {
          throw new CommandError('No wallet found. A wallet address is required for quotes because the trading API builds a transaction specific to the sender.\nCreate one with: nansen wallet create', 'NO_WALLET');
        }

        // --amount-unit percent: fetch balance, calculate percentage, convert to base units.
        // Placed after wallet resolution because we need the wallet address to fetch balance.
        if (amountUnit === 'percent') {
          try {
            resolvedDecimals = await resolveTokenDecimals(from, chain);
            const tokenAmount = await resolvePercentAmount({
              chain,
              from,
              walletAddress,
              percentage: parseFloat(amount),
              decimals: resolvedDecimals,
            });
            resolvedAmount = convertToBaseUnits(tokenAmount, resolvedDecimals);
          } catch (err) {
            throw new CommandError(`Error: ${err.message}`, 'INVALID_INPUT');
          }
        }

        // Balance pre-check — catches zero balances and insufficient funds
        // before wasting a quote API call. Runs for --amount-unit token and
        // usd (after USD→token conversion) in exactIn mode. In exactOut the
        // amount is the buy amount so comparing against sell balance is meaningless.
        if ((amountUnit === 'token' || amountUnit === 'usd') && swapMode !== 'exactOut') {
          try {
            // For USD, pass the converted token-unit amount so validateBalance
            // can compare against the wallet balance in token units.
            const tokenUnitAmount = amountUnit === 'usd' ? usdTokenAmount : amount;
            const { adjustedAmount: balanceAdjusted } = await validateBalance({
              chain,
              from,
              amount: tokenUnitAmount,
              amountUnit: 'token',
              walletAddress,
              decimals: resolvedDecimals,
              symbol: fromRaw,
            });
            if (balanceAdjusted !== tokenUnitAmount) {
              resolvedAmount = convertToBaseUnits(balanceAdjusted, resolvedDecimals);
            }
          } catch (balanceErr) {
            throw new CommandError(`Error: ${balanceErr.message}`, 'INSUFFICIENT_BALANCE');
          }
        }

        const toChainConfig = toChainRaw ? resolveChain(toChainRaw) : null;
        const isCrossChain = toChainConfig && toChainConfig.index !== chainConfig.index;

        if (isCrossChain) {
          log(`\nFetching cross-chain quote: ${chainConfig.name} → ${toChainConfig.name}...`);
        } else {
          log(`\nFetching quote on ${chainConfig.name}...`);
        }
        log(`  Wallet: ${walletAddress}`);

        const fromWarning = getWrappedNativeFromWarning(from, chain);
        if (fromWarning) log(`  ${fromWarning}`);

        const params = {
          chainIndex: chainConfig.index,
          fromTokenAddress: from,
          toTokenAddress: to,
          amount: resolvedAmount,
          userWalletAddress: walletAddress,
        };
        if (isCrossChain) {
          params.toChainIndex = toChainConfig.index;
          // Relay and LiFi are both first-class cross-chain aggregators; backend picks per quote.
          // bridge-status auto-detects which aggregator produced a tx via the local tx record.
          if (toWallet) {
            params.toWalletAddress = toWallet;
            log(`  Destination wallet: ${toWallet}`);
          } else if (chainConfig.type !== toChainConfig.type) {
            // Solana↔Base: auto-derive the destination address from the same wallet
            const effectiveWalletName = walletName || getWalletConfig()?.defaultWallet;
            if (effectiveWalletName) {
              const walletData = showWallet(effectiveWalletName);
              params.toWalletAddress = toChainConfig.type === 'solana' ? walletData.solana : walletData.evm;
              log(`  Destination wallet: ${params.toWalletAddress}`);
            }
          }
        }
        if (slippage) params.slippagePercent = slippage;
        if (autoSlippage) params.autoSlippage = true;
        if (maxAutoSlippage) params.maxAutoSlippagePercent = maxAutoSlippage;
        if (swapMode !== 'exactIn') params.swapMode = swapMode;

        const response = await getQuote(params);

        if (!response.success || !response.quotes?.length) {
          let msg = 'No quotes available';
          if (response.warnings?.length) {
            msg += '\n' + response.warnings.map(w => `  Warning: ${w}`).join('\n');
          }
          throw new CommandError(msg, 'NO_QUOTES');
        }

        // Client-side filter: if --aggregator is passed, drop everything else.
        // Done client-side because the backend's aggregator-selection knob
        // (disabledAggregators) silently accepts unknown values, so a server
        // filter would mask typos. This way we own the validation.
        if (aggregatorFilter) {
          const matching = response.quotes.filter(q => q.aggregator === aggregatorFilter);
          if (!matching.length) {
            const seen = [...new Set(response.quotes.map(q => q.aggregator))].join(', ') || 'none';
            throw new CommandError(
              `No quotes from aggregator "${aggregatorFilter}" for this pair. Backend returned: ${seen}.`,
              'AGGREGATOR_NOT_AVAILABLE'
            );
          }
          response.quotes = matching;
        }

        log('');
        response.quotes.forEach((q, i) => log(formatQuote(q, i)));

        // Gas balance validation — check that the wallet has enough native token for gas.
        // High-value trades (>= $10) can use gasless/solver-paid routes and bypass this check.
        try {
          const tradeValueUsd = response.quotes[0]?.inUsdValue;
          await validateGasBalance({ chain, walletAddress, tradeValueUsd });
        } catch (gasErr) {
          throw new CommandError(`Error: ${gasErr.message}`, 'INSUFFICIENT_GAS');
        }

        const signerType = isWalletConnect ? 'walletconnect' : walletProvider;
        // Slippage actually in effect (for scoping exactOut approvals at execute time).
        const effectiveSlippage = slippage != null ? Number(slippage)
          : autoSlippage ? (maxAutoSlippage != null ? Number(maxAutoSlippage) : 0.05)
          : 0.03;
        const quoteId = saveQuote(response, chain, signerType, privyWalletIds, isCrossChain ? toChainRaw : null, {
          swapMode,
          slippage: effectiveSlippage,
        });
        log(`\n  Quote ID: ${quoteId}`);
        log(`  Execute:  nansen trade execute --quote ${quoteId}`);
        if (response.quotes.length > 1) {
          log(`  Pin #1:  nansen trade execute --quote ${quoteId} --quote-index 0`);
        }

        const firstQuote = response.quotes[0];
        if (firstQuote?.approvalAddress && firstQuote.approvalAddress !== '' && !isNativeToken(firstQuote.inputMint)) {
          log(`\n  Warning: This token swap requires an ERC-20 approval step.`);
          log(`    The execute command will handle this automatically.`);
        }

        log('');
        return undefined; // Output already printed above

      } catch (err) {
        if (err instanceof CommandError) throw err;
        let message = err.message;
        if (err.code === 'INVALID_AMOUNT' || /amount/i.test(err.message)) {
          message += '. Amounts must be in base units (e.g., 1000000000 lamports for 1 SOL, 1000000000000000000 wei for 1 ETH)';
        }
        let msg = `Error: ${message}`;
        if (err.details) msg += `\n  Details: ${JSON.stringify(err.details)}`;
        throw new CommandError(msg, err.code || 'QUOTE_ERROR');
      }
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || options['quote-id'] || args[0];
      const walletName = options.wallet;
      const noSimulate = flags['no-simulate'];
      const gasless = Boolean(flags.gasless);

      if (!quoteId) {
        throw new CommandError(`Usage: nansen trade execute --quote <quoteId> [options]

OPTIONS:
  --quote <id>              Quote ID from 'nansen quote'
  --wallet <name>           Wallet name (default: default wallet)
  --no-simulate             Skip pre-broadcast simulation
  --gasless                 Relay-only: have Relay's solver pay gas (no WalletConnect)

EXAMPLES:
  nansen trade execute --quote 1708900000000-abc123`, 'MISSING_ARGS');
      }

      try {
        const quoteData = loadQuote(quoteId);
        const chain = quoteData.chain;
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type;

        const allQuotes = quoteData.response.quotes || [];
        if (!allQuotes.length) {
          throw new CommandError('❌ No quote data found', 'NO_QUOTES');
        }

        // --quote-index pins a specific quote (no fallback)
        let pinIndex = null;
        if (options['quote-index'] != null) {
          pinIndex = parseInt(options['quote-index'], 10);
          if (!Number.isInteger(pinIndex) || pinIndex < 0 || pinIndex >= allQuotes.length) {
            throw new CommandError(
              `❌ Invalid --quote-index "${options['quote-index']}". Must be an integer between 0 and ${allQuotes.length - 1}.`,
              'INVALID_QUOTE_INDEX',
            );
          }
        }
        const startIndex = pinIndex ?? 0;
        const endIndex = pinIndex != null ? startIndex + 1 : allQuotes.length;

        // Check if any quote in range has transaction data before prompting for password
        const hasAnyTransaction = allQuotes.slice(startIndex, endIndex).some(q => q?.transaction);
        if (!hasAnyTransaction) {
          throw new CommandError('❌ No quotes contain transaction data.\n  Ensure userWalletAddress was provided when fetching the quote.', 'NO_TRANSACTION');
        }

        // Determine if this is a WalletConnect or Privy-signed quote
        const isWalletConnect = quoteData.signerType === 'walletconnect'
          || walletName === 'walletconnect' || walletName === 'wc';
        const isPrivy = quoteData.signerType === 'privy';

        let exported = null;
        let privyClient = null;
        if (isPrivy) {
          // Privy signing -- import + instantiate once for all quotes
          const { PrivyClient } = await import('./privy.js');
          privyClient = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
        } else if (!isWalletConnect) {
          // Get wallet credentials once (before the loop)
          const walletConfig = getWalletConfig();
          let password = null;
          if (walletConfig.passwordHash) {
            password = resolveTradePassword();
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

          let effectiveWalletName = walletName;
          if (!effectiveWalletName) {
            const list = listWallets();
            effectiveWalletName = list.defaultWallet;
          }
          if (!effectiveWalletName) {
            throw new CommandError('No wallet found. Create one with: nansen wallet create', 'NO_WALLET');
          }

          exported = exportWallet(effectiveWalletName, password);
        } else {
          // Verify WalletConnect session is still active and address matches quote
          const wcAddress = await getWalletConnectAddress(chainType);
          if (!wcAddress) {
            throw new CommandError('No WalletConnect session active. Run: walletconnect connect', 'NO_WALLET');
          }
          // Check address matches the one used during quoting
          const quoteWallet = quoteData.response?.quotes?.[0]?.transaction?.from
            || quoteData.response?.metadata?.userWalletAddress;
          if (quoteWallet && (chainType === 'solana'
            ? wcAddress.trim() !== quoteWallet.trim()
            : wcAddress.toLowerCase().trim() !== quoteWallet.toLowerCase().trim())) {
            throw new CommandError(`Connected wallet (${wcAddress}) doesn't match quote. Get a new quote with --wallet walletconnect`, 'WALLET_MISMATCH');
          }
        }

        let lastQuoteError = null;

        for (let qi = startIndex; qi < endIndex; qi++) {
          const currentQuote = allQuotes[qi];
          if (!currentQuote) continue;

          const quoteName = currentQuote.source || currentQuote.metadata?.source || `#${qi + 1}`;

          // Verify transaction data exists
          if (!currentQuote.transaction) {
            log(`  ⚠ Quote ${quoteName}: no transaction data, skipping...`);
            lastQuoteError = `Quote ${quoteName} has no transaction data`;
            continue;
          }

          const isRelay = currentQuote.aggregator === 'relay';
          if (gasless) {
            if (!isRelay) {
              throw new CommandError(
                `--gasless is only supported for Relay quotes. Selected quote ${quoteName} is from "${currentQuote.aggregator}". Re-run with --quote-index to pin a Relay quote, or omit --gasless.`,
                'GASLESS_UNSUPPORTED_AGGREGATOR'
              );
            }
            if (isWalletConnect) {
              throw new CommandError(
                'Gasless swaps are not supported via WalletConnect (mobile wallets typically auto-broadcast, breaking the gasless flow). Use a local or Privy wallet.',
                'GASLESS_UNSUPPORTED_WALLET'
              );
            }
          }

          log(`\nExecuting trade on ${chainConfig.name}...`);
          if (endIndex - startIndex > 1) {
            log(`  Trying quote ${qi + 1}/${allQuotes.length} (${quoteName})...`);
          }
          log(formatQuote(currentQuote));
          log('');

          try {
            let signedTransaction;
            let requestId;

            if (chainType === 'solana' && isPrivy) {
              // Solana via Privy: sign the serialized transaction
              let txBase64 = currentQuote.transaction;
              if (typeof txBase64 === 'object' && txBase64.data) {
                txBase64 = base58Decode(txBase64.data).toString('base64');
              }
              log('  Signing Solana transaction via Privy...');
              const solWalletId = quoteData.privyWalletIds?.solana;
              if (!solWalletId) throw new Error('No Solana Privy wallet ID in quote');
              const signResult = await privyClient.signSolanaTransaction(solWalletId, txBase64);
              signedTransaction = signResult.data?.signed_transaction || signResult.signed_transaction;
              requestId = currentQuote.metadata?.requestId;

            } else if (chainType === 'evm' && isPrivy) {
              // EVM via Privy: sign-only, then broadcast via Trading API
              const evmWalletId = quoteData.privyWalletIds?.evm;
              if (!evmWalletId) throw new Error('No EVM Privy wallet ID in quote');

              const walletResult = await privyClient.getWallet(evmWalletId);
              const walletAddress = walletResult.address;

              // Validate transaction.value (same checks as local wallet)
              const isNative = isNativeToken(currentQuote.inputMint);
              const txValue = BigInt(currentQuote.transaction.value || '0');
              if (isNative) {
                const expectedValue = BigInt(currentQuote.inAmount || currentQuote.inputAmount || '0');
                if (txValue !== expectedValue) {
                  log(`  ❌ Transaction value mismatch for ${quoteName}: tx.value=${txValue}, expected=${expectedValue}`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} transaction value mismatch`;
                  continue;
                }
              } else {
                if (txValue > 0n) {
                  log(`  ❌ ERC-20 swap has non-zero tx.value (${txValue}) for ${quoteName} — aborting`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} unexpected tx.value`;
                  continue;
                }
              }

              // Handle approval if needed
              // Empty-string approvalAddress is Relay's "no approval needed" sentinel — skip.
              if (currentQuote.approvalAddress && currentQuote.approvalAddress !== '' && !isNative) {
                assertUsableSpender(currentQuote.approvalAddress);
                const inputAmount = BigInt(currentQuote.inputAmount || currentQuote.inAmount || '0');
                const approveAmt = approvalAmountForSwap({ inputAmount, swapMode: quoteData.swapMode, slippage: quoteData.slippage });
                const existingAllowance = await checkErc20Allowance(
                  chain, currentQuote.inputMint, walletAddress, currentQuote.approvalAddress
                );

                if (existingAllowance >= approveAmt && existingAllowance > 0n) {
                  log(`  ✓ Sufficient allowance exists for ${quoteName}, skipping approval`);
                } else {
                  log(`  ⚠ Approval required → ${currentQuote.approvalAddress}`);
                  const approvalNonce = await getEvmNonce(chain, walletAddress);
                  // Scope the approval to this trade's input (see approvalAmountForSwap).
                  const approvalData = '0x095ea7b3'
                    + currentQuote.approvalAddress.slice(2).toLowerCase().padStart(64, '0')
                    + approveAmt.toString(16).padStart(64, '0');
                  const approvalMaxFee = currentQuote.transaction?.maxFeePerGas || currentQuote.transaction?.gasPrice || '1000000';
                  const approvalPriorityFee = currentQuote.transaction?.maxPriorityFeePerGas || '1000000';
                  const approvalSignResult = await privyClient.signEvmTransaction(evmWalletId, {
                    to: currentQuote.inputMint,
                    data: approvalData,
                    value: '0x0',
                    chain_id: chainConfig.chainId,
                    nonce: toHex(approvalNonce),
                    gas_limit: toHex(100000),
                    max_fee_per_gas: toHex(approvalMaxFee),
                    max_priority_fee_per_gas: toHex(approvalPriorityFee),
                  });
                  const signedApproval = approvalSignResult.data?.signed_transaction || approvalSignResult.signed_transaction;
                  const approvalResult = await executeTransaction({ signedTransaction: signedApproval, chain, simulate: !noSimulate });
                  if (approvalResult.status !== 'Success') {
                    log(`  ❌ Approval failed for ${quoteName}: ${approvalResult.error || 'unknown'}`);
                    if (qi + 1 < endIndex) log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} approval failed`;
                    continue;
                  }
                  log(`  Waiting for approval confirmation...`);
                  try {
                    const receipt = await waitForReceipt(chain, approvalResult.txHash);
                    log(`  ✓ Approval confirmed in block ${parseInt(receipt.blockNumber, 16)}: ${approvalResult.txHash}`);
                  } catch (receiptErr) {
                    log(`  ❌ Approval may not have confirmed: ${receiptErr.message}`);
                    if (qi + 1 < endIndex) log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} approval unconfirmed`;
                    continue;
                  }
                  await new Promise(r => setTimeout(r, 2000));
                }
              }

              // Pre-flight simulation
              if (!noSimulate && !gasless) {
                const sim = await simulateEvmCall(chain, {
                  from: walletAddress,
                  to: currentQuote.transaction.to,
                  data: currentQuote.transaction.data,
                  value: currentQuote.transaction.value ? '0x' + BigInt(currentQuote.transaction.value).toString(16) : '0x0',
                });
                if (!sim.success) {
                  log(`  ⚠ Simulation failed for ${quoteName}: ${sim.reason}`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} simulation failed: ${sim.reason}`;
                  continue;
                }
              }

              // Gas resolution — fall back to eth_estimateGas if quote has no gas
              const txData = currentQuote.transaction;
              const apiGas = parseInt(currentQuote.gas || '0');
              const txGas = parseInt(txData.gas || txData.gasLimit || '0');
              let finalGas = apiGas > 0 ? apiGas : txGas;
              if (finalGas === 0) {
                try {
                  const rpcUrl = CHAIN_RPCS[chain];
                  const estRes = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0', id: 1, method: 'eth_estimateGas',
                      params: [{
                        from: walletAddress, to: txData.to, data: txData.data || '0x',
                        value: txData.value ? '0x' + BigInt(txData.value).toString(16) : '0x0',
                      }],
                    }),
                  });
                  const estBody = await estRes.json();
                  if (estBody.result) finalGas = Math.ceil(parseInt(estBody.result, 16) * 1.5);
                } catch { /* ignore */ }
                if (finalGas === 0) finalGas = 210000;
              }

              // Guard the target before signing (see validateSwapTarget).
              await validateSwapTarget(chain, txData.to, currentQuote.inputMint);

              log('  Fetching nonce...');
              const nonce = await getEvmNonce(chain, walletAddress);

              // Privy signs EIP-1559 (type 2) transactions, so convert gasPrice to EIP-1559 fields
              const maxFee = txData.maxFeePerGas || txData.gasPrice || '1000000';
              const priorityFee = txData.maxPriorityFeePerGas || '1000000';

              log('  Signing EVM transaction via Privy...');
              const signResult = await privyClient.signEvmTransaction(evmWalletId, {
                to: txData.to,
                data: txData.data || '0x',
                value: txData.value ? '0x' + BigInt(txData.value).toString(16) : '0x0',
                chain_id: chainConfig.chainId,
                nonce: toHex(nonce),
                gas_limit: toHex(finalGas),
                max_fee_per_gas: toHex(maxFee),
                max_priority_fee_per_gas: toHex(priorityFee),
              });
              signedTransaction = signResult.data?.signed_transaction || signResult.signed_transaction;

            } else if (chainType === 'solana') {
              // Solana: transaction is either a base64 string (Jupiter) or an object
              // with a base58-encoded `data` field (OKX). Normalize to base64.
              let txBase64 = currentQuote.transaction;
              if (typeof txBase64 === 'object' && txBase64.data) {
                txBase64 = base58Decode(txBase64.data).toString('base64');
              }

              if (isWalletConnect) {
                // Solana via WalletConnect: convert base64 → base58 for WC protocol
                log('  Signing Solana transaction via WalletConnect...');
                let txBase58;
                try {
                  txBase58 = base58Encode(Buffer.from(txBase64, 'base64'));
                } catch (err) {
                  throw new Error(`Failed to encode transaction for WalletConnect: ${err.message}`, { cause: err });
                }
                const wcResult = await sendSolanaTransactionViaWalletConnect(txBase58);

                if (wcResult.signedTransaction) {
                  signedTransaction = base58Decode(wcResult.signedTransaction).toString('base64');
                } else if (wcResult.signature) {
                  // Wallet returned raw Ed25519 sig → inject into unsigned tx
                  let sigBytes;
                  try {
                    sigBytes = base58Decode(wcResult.signature);
                  } catch (err) {
                    throw new Error(`Invalid base58 signature from WalletConnect: ${err.message}`, { cause: err });
                  }
                  if (sigBytes.length !== 64) {
                    throw new Error(`Invalid Ed25519 signature length: expected 64 bytes, got ${sigBytes.length}`);
                  }
                  // Buffer.from() creates a new buffer — safe to mutate in-place
                  const txBytes = Buffer.from(txBase64, 'base64');
                  const { value: sigCount, size: sigCountSize } = readCompactU16(txBytes, 0);
                  if (sigCount < 1) {
                    throw new Error('Transaction has no signature slots');
                  }
                  if (txBytes.length < sigCountSize + 64) {
                    throw new Error(`Transaction buffer too small for signature: need ${sigCountSize + 64}, got ${txBytes.length}`);
                  }
                  // Inject into the first signature slot (feePayer)
                  sigBytes.copy(txBytes, sigCountSize);
                  signedTransaction = txBytes.toString('base64');
                } else {
                  throw new Error('WalletConnect returned neither signedTransaction nor signature');
                }
              } else {
                log('  Signing Solana transaction...');
                signedTransaction = signSolanaTransaction(txBase64, exported.solana.privateKey);
              }
              requestId = currentQuote.metadata?.requestId;

            } else if (isWalletConnect) {
              // EVM via WalletConnect: wallet signs and may broadcast
              const wcAddress = await getWalletConnectAddress(chainType);
              const isNative = isNativeToken(currentQuote.inputMint);

              // Validate transaction.value (same checks as local wallet)
              const txValue = BigInt(currentQuote.transaction.value || '0');
              if (isNative) {
                const expectedValue = BigInt(currentQuote.inAmount || currentQuote.inputAmount || '0');
                if (txValue !== expectedValue) {
                  log(`  ❌ Transaction value mismatch for ${quoteName}: tx.value=${txValue}, expected=${expectedValue}`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} transaction value mismatch`;
                  continue;
                }
              } else {
                if (txValue > 0n) {
                  log(`  ❌ ERC-20 swap has non-zero tx.value (${txValue}) for ${quoteName} — aborting`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} unexpected tx.value`;
                  continue;
                }
              }

              // Handle approval via WalletConnect if needed
              // Empty-string approvalAddress is Relay's "no approval needed" sentinel — skip.
              if (currentQuote.approvalAddress && currentQuote.approvalAddress !== '' && !isNative) {
                assertUsableSpender(currentQuote.approvalAddress);
                const inputAmount = BigInt(currentQuote.inputAmount || currentQuote.inAmount || '0');
                const approveAmt = approvalAmountForSwap({ inputAmount, swapMode: quoteData.swapMode, slippage: quoteData.slippage });
                const existingAllowance = await checkErc20Allowance(
                  chain, currentQuote.inputMint, wcAddress, currentQuote.approvalAddress
                );

                if (existingAllowance >= approveAmt && existingAllowance > 0n) {
                  log(`  ✓ Sufficient allowance exists for ${quoteName}, skipping approval`);
                } else {
                  log(`  ⚠ Approval required → ${currentQuote.approvalAddress}`);
                  log(`  Sending approval via WalletConnect...`);
                  try {
                    const approvalResult = await sendApprovalViaWalletConnect(
                      currentQuote.inputMint,
                      currentQuote.approvalAddress,
                      chainConfig.chainId,
                      approveAmt,
                    );
                    let approvalTxHash = approvalResult.txHash;
                    if (!approvalTxHash && approvalResult.signedTransaction) {
                      // Wallet returned a signed tx instead of broadcasting — broadcast via Trading API
                      log(`  Broadcasting approval via Trading API...`);
                      const broadcastResult = await executeTransaction({
                        signedTransaction: approvalResult.signedTransaction,
                        chain,
                        simulate: !noSimulate,
                      });
                      if (broadcastResult.status !== 'Success') {
                        throw new Error(broadcastResult.error || 'broadcast failed');
                      }
                      approvalTxHash = broadcastResult.txHash;
                    }
                    if (approvalTxHash) {
                      log(`  Waiting for approval confirmation...`);
                      const receipt = await waitForReceipt(chain, approvalTxHash);
                      log(`  ✓ Approval confirmed in block ${parseInt(receipt.blockNumber, 16)}: ${approvalTxHash}`);
                    }
                  } catch (approvalErr) {
                    log(`  ❌ Approval failed for ${quoteName}: ${approvalErr.message}`);
                    if (qi + 1 < endIndex) log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} approval failed`;
                    continue;
                  }
                  await new Promise(r => setTimeout(r, 2000));
                  log('');
                }
              }

              // Pre-flight simulation
              if (!noSimulate && !gasless) {
                const txData = currentQuote.transaction;
                const sim = await simulateEvmCall(chain, {
                  from: wcAddress,
                  to: txData.to,
                  data: txData.data,
                  value: txData.value ? '0x' + BigInt(txData.value).toString(16) : '0x0',
                });
                if (!sim.success) {
                  log(`  ⚠ Simulation failed for ${quoteName}: ${sim.reason}`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} simulation failed: ${sim.reason}`;
                  continue;
                }
              }

              // Resolve gas
              const txData = currentQuote.transaction;
              const apiGas = parseInt(currentQuote.gas || "0");
              const txGas = parseInt(txData.gas || txData.gasLimit || "0");
              const finalGas = apiGas > 0 ? apiGas : txGas;

              // Guard the target before the wallet signs (see validateSwapTarget).
              await validateSwapTarget(chain, txData.to, currentQuote.inputMint);

              // Send transaction via WalletConnect
              log('  Sending transaction via WalletConnect...');
              let wcResult;
              try {
                wcResult = await sendTransactionViaWalletConnect({
                  to: txData.to,
                  data: txData.data,
                  value: txData.value || '0',
                  gas: String(finalGas),
                  chainId: chainConfig.chainId,
                });
              } catch (wcErr) {
                log(`  ❌ WalletConnect transaction failed for ${quoteName}: ${wcErr.message}`);
                if (qi + 1 < endIndex) log(`  Trying next quote...`);
                lastQuoteError = `${quoteName}: ${wcErr.message}`;
                continue;
              }

              if (wcResult.txHash) {
                // Wallet broadcast — verify on-chain
                log('  Verifying on-chain status...');
                try {
                  await waitForReceipt(chain, wcResult.txHash);
                } catch (receiptErr) {
                  log(`\n  ⚠ Transaction was broadcast but REVERTED on-chain!`);
                  log(`    Tx Hash:   ${wcResult.txHash}`);
                  log(`    Explorer:  ${chainConfig.explorer}${wcResult.txHash}`);
                  log(`    Error:     ${receiptErr.message}`);
                  if (qi + 1 < endIndex) {
                    log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} reverted on-chain`;
                    continue;
                  }
                  throw new CommandError(`\n  ⚠ Transaction was broadcast but REVERTED on-chain!\n    Tx Hash:   ${wcResult.txHash}\n    Explorer:  ${chainConfig.explorer}${wcResult.txHash}\n    Error:     ${receiptErr.message}`, 'TX_REVERTED');
                }

                log(`\n  ✓ Transaction successful!`);
                log(`    Tx Hash:   ${wcResult.txHash}`);
                log(`    Chain:       ${chainConfig.name}`);
                log(`    Explorer:    ${chainConfig.explorer}${wcResult.txHash}`);

                // Cross-chain: poll bridge status after source tx success
                if (quoteData.toChain && quoteData.toChain !== quoteData.chain) {
                  saveTxRecord(wcResult.txHash, {
                    aggregator: currentQuote.aggregator,
                    requestId: currentQuote.metadata?.requestId,
                    fromChain: quoteData.chain,
                    toChain: quoteData.toChain,
                  });
                  log(`\n  Cross-chain bridge in progress (${chainConfig.name} → ${resolveChain(quoteData.toChain).name})...`);
                  try {
                    const bridgeResult = await pollBridgeStatus(wcResult.txHash, quoteData.chain, quoteData.toChain, { log, aggregator: currentQuote.aggregator });
                    if (bridgeResult.substatus === 'REFUNDED') {
                      log(`\n  ⚠ Bridge refunded — funds returned on source chain.`);
                      if (bridgeResult.substatusMessage) log(`    Reason: ${bridgeResult.substatusMessage}`);
                    } else {
                      log(`\n  ✓ Bridge completed!`);
                      if (bridgeResult.receiving?.txHash) {
                        const toChainConfig = resolveChain(quoteData.toChain);
                        log(`    Destination tx: ${toChainConfig.explorer}${bridgeResult.receiving.txHash}`);
                      }
                    }
                  } catch (bridgeErr) {
                    log(`\n  Bridge status: ${bridgeErr.message}`);
                    log(`  Check later with: nansen trade bridge-status --tx-hash ${wcResult.txHash} --from-chain ${quoteData.chain} --to-chain ${quoteData.toChain}`);
                  }
                }

                log('');
                return undefined; // Success
              }

              // Wallet returned signedTransaction — fall through to broadcast via Trading API
              signedTransaction = wcResult.signedTransaction;

            } else {
              // EVM: quote.transaction is { to, data, value, gas, gasPrice }
              const walletAddress = exported.evm.address;

              // Handle approval if needed — skip for native ETH
              // Check existing allowance first to avoid unnecessary approve txs
              // (industry standard: LiFi SDK checkAllowance, 1inch Permit2)
              const isNative = isNativeToken(currentQuote.inputMint);

              // Validate transaction.value matches the swap type.
              // ERC-20 swaps transfer tokens via calldata, so value must be 0.
              // Native ETH swaps must have value matching the quoted inAmount.
              // A compromised API could attach a large value to drain ETH silently.
              const txValue = BigInt(currentQuote.transaction.value || '0');
              if (isNative) {
                const expectedValue = BigInt(currentQuote.inAmount || currentQuote.inputAmount || '0');
                if (txValue !== expectedValue) {
                  log(`  ❌ Transaction value mismatch for ${quoteName}: tx.value=${txValue}, expected=${expectedValue}`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} transaction value mismatch`;
                  continue;
                }
              } else {
                if (txValue > 0n) {
                  log(`  ❌ ERC-20 swap has non-zero tx.value (${txValue}) for ${quoteName} — aborting`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} unexpected tx.value`;
                  continue;
                }
              }

              // Empty-string approvalAddress is Relay's "no approval needed" sentinel — skip.
              if (currentQuote.approvalAddress && currentQuote.approvalAddress !== '' && !isNative) {
                assertUsableSpender(currentQuote.approvalAddress);
                // Check if sufficient allowance already exists
                const inputAmount = BigInt(currentQuote.inputAmount || currentQuote.inAmount || currentQuote.transaction?.value || '0');
                const approveAmt = approvalAmountForSwap({ inputAmount, swapMode: quoteData.swapMode, slippage: quoteData.slippage });
                const existingAllowance = await checkErc20Allowance(
                  chain, currentQuote.inputMint, walletAddress, currentQuote.approvalAddress
                );

                if (existingAllowance >= approveAmt && existingAllowance > 0n) {
                  log(`  ✓ Sufficient allowance exists for ${quoteName}, skipping approval`);
                } else {
                  log(`  ⚠ Approval required → ${currentQuote.approvalAddress}`);
                  log(`  Sending approval tx...`);
                  const approvalNonce = await getEvmNonce(chain, walletAddress);

                  const approvalGasPrice = currentQuote.transaction?.gasPrice || currentQuote.transaction?.maxFeePerGas || '1000000';
                  const approvalTxHex = buildApprovalTransaction(
                    currentQuote.inputMint,
                    currentQuote.approvalAddress,
                    exported.evm.privateKey,
                    chain,
                    approvalNonce,
                    approvalGasPrice,
                    approveAmt,
                  );

                  const approvalResult = await executeTransaction({
                    signedTransaction: approvalTxHex,
                    chain,
                    simulate: !noSimulate,
                  });

                  if (approvalResult.status !== 'Success') {
                    log(`  ❌ Approval failed for ${quoteName}: ${approvalResult.error || 'unknown error'}`);
                    if (qi + 1 < endIndex) log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} approval failed`;
                    continue;
                  }

                  log(`  Waiting for approval confirmation...`);
                  try {
                    const receipt = await waitForReceipt(chain, approvalResult.txHash);
                    log(`  ✓ Approval confirmed in block ${parseInt(receipt.blockNumber, 16)}: ${approvalResult.txHash}`);
                  } catch (receiptErr) {
                    log(`  ❌ Approval may not have confirmed: ${receiptErr.message}`);
                    if (qi + 1 < endIndex) log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} approval unconfirmed`;
                    continue;
                  }
                  // Wait for RPC state propagation after approval
                  await new Promise(r => setTimeout(r, 2000));
                  log('');
                }
              }

              // Pre-flight simulation (EVM only) — catch logic reverts before spending gas
              // Runs AFTER approval so eth_call sees the current allowance state
              // Simulates WITHOUT gas limit to check swap logic; gas re-estimation is separate
              if (!noSimulate && !gasless) {
                const txData = currentQuote.transaction;
                const sim = await simulateEvmCall(chain, {
                  from: walletAddress,
                  to: txData.to,
                  data: txData.data,
                  value: txData.value ? '0x' + BigInt(txData.value).toString(16) : '0x0',
                });
                if (!sim.success) {
                  log(`  ⚠ Simulation failed for ${quoteName}: ${sim.reason}`);
                  if (qi + 1 < endIndex) log(`  Trying next quote...`);
                  lastQuoteError = `${quoteName} simulation failed: ${sim.reason}`;
                  continue;
                }
              }

              // Use the Trading API's gas estimation (quote.gas) directly.
              // The API already applies a 1.5x buffer over eth_estimateGas.
              // Skip client-side re-estimation — it adds latency and the API value is reliable.
              const txData = currentQuote.transaction;
              const apiGas = parseInt(currentQuote.gas || "0");
              const txGas = parseInt(txData.gas || txData.gasLimit || "0");
              const finalGas = apiGas > 0 ? apiGas : txGas;
              if (finalGas !== txGas) {
                log(`  ℹ Using API gas ${finalGas} (tx.gas was ${txGas})`);
              }
              if (txData.gasLimit) txData.gasLimit = String(finalGas);
              else txData.gas = String(finalGas);

              // Guard the target before signing: whatever `to`/`data` the quote
              // supplied gets signed verbatim, so reject a target that isn't a
              // plausible router (zero, EOA, or the sold token itself).
              await validateSwapTarget(chain, txData.to, currentQuote.inputMint);

              log('  Fetching nonce...');
              await new Promise(r => setTimeout(r, 1000));
              const nonce = await getEvmNonce(chain, walletAddress);
              log(`  Nonce: ${nonce}`);

              log('  Signing EVM transaction...');
              signedTransaction = signEvmTransaction(
                currentQuote.transaction,
                exported.evm.privateKey,
                chain,
                nonce
              );
            }

            log(gasless ? '  Forwarding to Relay solver (gasless)...' : '  Broadcasting...');
            const execParams = {
              signedTransaction,
              chain,
              simulate: !noSimulate && !gasless,
            };

            // Prefer the backend quote id saved from /quote; per-aggregator ids can
            // appear on individual quote metadata and are only a fallback.
            const backendQuoteId =
              quoteData.response?.metadata?.quoteId ?? currentQuote.metadata?.quoteId;
            if (backendQuoteId) {
              execParams.quoteId = backendQuoteId;
            }
            // The backend's /execute schema is strict; sending fields it doesn't expect
            // for the (chain × aggregator × gasless) combination causes 502s or
            // "Unrecognized keys" rejections. The matrix we've validated against the
            // live backend:
            //   - EVM signed (any aggregator): no aggregator/requestId fields.
            //     Those trigger schema errors.
            //   - Solana signed (Jupiter/OKX): include requestId for Jupiter Ultra
            //     intent resolution.
            //   - Solana signed (Relay): omit requestId — backend tries to look it up
            //     as a Jupiter intent and 502s.
            //   - Gasless (EVM): aggregator + gasless + steps + requestId.
            //   - Gasless (Solana): currently rejected by the backend ("Unrecognized
            //     keys"); we still send the gasless envelope and let the backend
            //     surface the error so users notice when support lands.
            if (gasless) {
              execParams.aggregator = 'relay';
              execParams.gasless = true;
              const gaslessRequestId = requestId || currentQuote.metadata?.requestId;
              if (gaslessRequestId) execParams.requestId = gaslessRequestId;
              if (currentQuote.metadata?.steps) execParams.steps = currentQuote.metadata.steps;
            } else if (requestId && !isRelay) {
              execParams.requestId = requestId; // Solana Jupiter Ultra
            }

            const result = await executeTransaction(execParams);

            if (result.status === 'Success') {
              const txId = result.signature || result.txHash;
              const explorerUrl = chainConfig.explorer + txId;

              // For EVM: verify the tx actually succeeded on-chain
              if (chainType === 'evm' && result.txHash) {
                log('  Verifying on-chain status...');
                try {
                  await waitForReceipt(chain, result.txHash);
                } catch (receiptErr) {
                  log(`\n  ⚠ Transaction was broadcast but REVERTED on-chain!`);
                  log(`    Tx Hash:   ${result.txHash}`);
                  log(`    Explorer:  ${explorerUrl}`);
                  log(`    Error:     ${receiptErr.message}`);
                  if (qi + 1 < endIndex) {
                    log(`  Trying next quote...`);
                    lastQuoteError = `${quoteName} reverted on-chain`;
                    continue;
                  }
                  throw new CommandError(`\n  ⚠ Transaction was broadcast but REVERTED on-chain!\n    Tx Hash:   ${result.txHash}\n    Explorer:  ${explorerUrl}\n    Error:     ${receiptErr.message}\n\n  The trading API reported success, but the contract execution failed.\n  This can happen due to: stale quotes, insufficient gas, or liquidity changes.`, 'TX_REVERTED');
                }
              }

              log(`\n  ✓ Transaction successful!`);
              log(`    Status:      ${result.status}`);
              log(`    ${result.signature ? 'Signature' : 'Tx Hash'}:   ${txId}`);
              log(`    Chain:       ${chainConfig.name} (${result.chainType})`);
              log(`    Broadcaster: ${result.broadcaster}`);
              log(`    Explorer:    ${explorerUrl}`);

              if (result.swapEvents?.length) {
                log(`    Swaps:`);
                result.swapEvents.forEach(e => {
                  log(`      ${e.inputAmount} ${e.inputMint?.slice(0, 8)}... → ${e.outputAmount} ${e.outputMint?.slice(0, 8)}...`);
                });
              }

              // Cross-chain: poll bridge status after source tx success
              if (quoteData.toChain && quoteData.toChain !== quoteData.chain) {
                saveTxRecord(txId, {
                  aggregator: currentQuote.aggregator,
                  requestId: currentQuote.metadata?.requestId,
                  fromChain: quoteData.chain,
                  toChain: quoteData.toChain,
                });
                if (isRelay && currentQuote.metadata?.requestId) {
                  log(`    Relay:       https://relay.link/transaction/${currentQuote.metadata.requestId}`);
                }
                log(`\n  Cross-chain bridge in progress (${chainConfig.name} → ${resolveChain(quoteData.toChain).name})...`);
                try {
                  const bridgeResult = await pollBridgeStatus(txId, quoteData.chain, quoteData.toChain, { log, aggregator: currentQuote.aggregator });
                  if (bridgeResult.substatus === 'REFUNDED') {
                    log(`\n  ⚠ Bridge refunded — funds returned on source chain.`);
                    if (bridgeResult.substatusMessage) log(`    Reason: ${bridgeResult.substatusMessage}`);
                  } else {
                    log(`\n  ✓ Bridge completed!`);
                    if (bridgeResult.receiving?.txHash) {
                      const toChainConfig = resolveChain(quoteData.toChain);
                      log(`    Destination tx: ${toChainConfig.explorer}${bridgeResult.receiving.txHash}`);
                    }
                  }
                } catch (bridgeErr) {
                  log(`\n  Bridge status: ${bridgeErr.message}`);
                  log(`  Check later with: nansen trade bridge-status --tx-hash ${txId} --from-chain ${quoteData.chain} --to-chain ${quoteData.toChain}`);
                }
              }

              log('');
              return undefined; // Success — done
            } else {
              log(`\n  ✗ Quote ${quoteName} failed: ${result.status}`);
              if (result.error) log(`    Error:  ${result.error}`);
              lastQuoteError = `${quoteName}: ${result.error || result.status}`;
              if (qi + 1 < endIndex) log(`  Trying next quote...`);
            }

          } catch (quoteErr) {
            const msg = quoteErr.message || '';
            log(`  ❌ Quote ${quoteName} failed: ${msg}`);
            if (msg.includes('AccountNotFound') && chainType === 'solana') {
              log(`  Hint: Your Solana wallet may not have enough SOL to cover transaction fees (~0.005 SOL minimum).`);
            }
            lastQuoteError = `${quoteName}: ${msg}`;
            if (qi + 1 < endIndex) log(`  Trying next quote...`);
          }
        }

        // All quotes exhausted
        throw new CommandError(`\n❌ All quotes failed. Last error: ${lastQuoteError || 'unknown'}\n`, 'ALL_QUOTES_FAILED');

      } catch (err) {
        if (err instanceof CommandError) throw err;
        let msg = `Error: ${err.message}`;
        if (err.details) msg += `\n  Details: ${JSON.stringify(err.details)}`;
        throw new CommandError(msg, err.code || 'EXECUTE_ERROR');
      }
    },

    'bridge-status': async (args, _apiInstance, _flags, options) => {
      const txHash = options['tx-hash'] || args[0];
      const fromChain = options['from-chain'] || args[1];
      const toChain = options['to-chain'] || args[2];

      const aggregatorOverride = options.aggregator;
      if (aggregatorOverride && aggregatorOverride !== 'lifi' && aggregatorOverride !== 'relay') {
        throw new CommandError(`Invalid --aggregator: "${aggregatorOverride}". Use "lifi" or "relay".`, 'INVALID_AGGREGATOR');
      }

      if (!txHash || !fromChain || !toChain) {
        throw new CommandError(`Usage: nansen trade bridge-status --tx-hash <hash> --from-chain <chain> --to-chain <chain> [--aggregator <lifi|relay>]

Check the status of a cross-chain bridge transaction.

OPTIONS:
  --tx-hash <hash>          Source chain transaction hash
  --from-chain <chain>      Source chain (solana or base)
  --to-chain <chain>        Destination chain (solana or base)
  --aggregator <name>       lifi or relay. Overrides auto-detection from the
                            local tx record. Use this when polling from a
                            different machine or after the record has expired.

EXAMPLES:
  nansen trade bridge-status --tx-hash 0xabc... --from-chain base --to-chain solana
  nansen trade bridge-status --tx-hash 0xabc... --from-chain base --to-chain solana --aggregator relay`, 'MISSING_ARGS');
      }

      try {
        // Resolution order: explicit --aggregator flag → local tx record → backend
        // default (LiFi). The override matters when polling from a fresh machine
        // or after the 30-day record TTL expires.
        const txRecord = loadTxRecord(txHash);
        const aggregator = aggregatorOverride || txRecord?.aggregator;
        const status = await getBridgeStatus(txHash, fromChain, toChain, { aggregator });
        log(`\nBridge Status: ${status.status || 'unknown'}`);
        if (status.substatus === 'REFUNDED') {
          log(`  ⚠ REFUNDED — funds returned on source chain`);
        } else if (status.substatus) {
          log(`  Substatus:   ${status.substatus}`);
        }
        if (status.substatusMessage) log(`  Message:     ${status.substatusMessage}`);
        if (status.tool) log(`  Bridge:      ${status.tool}`);
        if (status.sending?.txHash) {
          log(`  Sending:`);
          log(`    Tx:        ${status.sending.txHash}`);
          if (status.sending.amount) log(`    Amount:    ${status.sending.amount}`);
          if (status.sending.txLink) log(`    Explorer:  ${status.sending.txLink}`);
        }
        if (status.receiving?.txHash) {
          log(`  Receiving:`);
          log(`    Tx:        ${status.receiving.txHash}`);
          if (status.receiving.amount) log(`    Amount:    ${status.receiving.amount}`);
          if (status.receiving.txLink) log(`    Explorer:  ${status.receiving.txLink}`);
        }
        const explorerLink = status.lifiExplorerLink || status.relayExplorerLink || status.explorerLink;
        if (explorerLink) log(`  Explorer:    ${explorerLink}`);
        if (aggregator === 'relay' && txRecord?.requestId) {
          log(`  Relay:       https://relay.link/transaction/${txRecord.requestId}`);
        } else if (aggregator === 'relay') {
          // No local record (cross-machine / expired). Surface the explorer
          // by tx hash so users can still cross-reference manually.
          log(`  Relay:       https://relay.link/transaction/${txHash}`);
        }
        log('');
      } catch (err) {
        if (err instanceof CommandError) throw err;
        let msg = `Error: ${err.message}`;
        if (err.details) msg += `\n  Details: ${JSON.stringify(err.details)}`;
        throw new CommandError(msg, err.code || 'BRIDGE_STATUS_ERROR');
      }
    },
  };
}
