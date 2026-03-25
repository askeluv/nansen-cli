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
import { CHAIN_RPCS } from './rpc-urls.js';

// ============= Constants =============

const TRADING_API_URL = process.env.NANSEN_TRADING_API_URL || 'https://trading-api.nansen.ai';

const CHAIN_MAP = {
  solana:   { index: '501', type: 'solana', chainId: 501,  name: 'Solana',   explorer: 'https://solscan.io/tx/' },
  base:     { index: '8453', type: 'evm',   chainId: 8453, name: 'Base',     explorer: 'https://basescan.org/tx/' },
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
async function evmRpcCall(chain, method, params = []) {
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

function getQuotesDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'quotes');
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

  const headers = { 'Accept': 'application/json' };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

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
 * @param {string} [params.requestId] - Optional Jupiter request ID (Solana only)
 * @param {boolean} [params.simulate] - Run pre-broadcast simulation
 * @returns {Promise<object>} Execution result
 */
export async function executeTransaction(params, { retries = 2, retryDelayMs = 1500 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (process.env.NANSEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.NANSEN_API_KEY}`;
  }

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

// ============= Quote Storage =============

/**
 * Save a quote response to disk for later execution.
 * @returns {string} Quote ID
 */
export function saveQuote(quoteResponse, chain, signerType = 'local', privyWalletIds = null) {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const timestamp = Date.now();
  const hash = crypto.randomBytes(4).toString('hex');
  const quoteId = `${timestamp}-${hash}`;

  const data = { quoteId, chain, timestamp, signerType, response: quoteResponse };
  if (privyWalletIds) data.privyWalletIds = privyWalletIds;

  fs.writeFileSync(path.join(dir, `${quoteId}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
  cleanupQuotes();
  return quoteId;
}

/**
 * Load a saved quote by ID.
 */
export function loadQuote(quoteId) {
  const filePath = path.join(getQuotesDir(), `${quoteId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Quote "${quoteId}" not found. Quotes expire after 1 hour.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Date.now() - data.timestamp > 3600000) {
    fs.unlinkSync(filePath);
    throw new Error('Quote has expired. Please request a new quote.');
  }
  return data;
}

/**
 * Remove quotes older than 1 hour.
 */
export function cleanupQuotes() {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (now - data.timestamp > 3600000) fs.unlinkSync(path.join(dir, file));
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
 * Signs as a legacy (type 0) transaction with gasPrice (matching the e2e tests).
 *
 * @param {object} txData - Transaction fields from quote.transaction { to, data, value, gas, gasPrice }
 * @param {string} privateKeyHex - 64-char hex (32-byte secp256k1 private key)
 * @param {string} chain - Chain name
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed transaction hex
 */
// ⚠️ SECURITY: EVM transaction signing - requires thorough review before production use
// TODO: Always signs as legacy (type 0) transactions. Do we need EIP-1559 (type 2) support?
export function signEvmTransaction(txData, privateKeyHex, chain, nonce) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig || chainConfig.type !== 'evm') {
    throw new Error(`Unsupported EVM chain: ${chain}`);
  }

  const tx = {
    nonce,
    gasPrice: toHex(txData.gasPrice || txData.maxFeePerGas || '1'),
    gasLimit: toHex(txData.gas || txData.gasLimit || '210000'),
    to: txData.to,
    value: toHex(txData.value || '0'),
    data: txData.data || '0x',
    chainId: chainConfig.chainId,
  };

  return signLegacyTransaction(tx, privateKeyHex);
}

/**
 * Fetch the pending nonce for an EVM address.
 * @param {string} chain - Chain name
 * @param {string} address - 0x address
 * @returns {Promise<number>} Nonce
 */
export async function getEvmNonce(chain, address) {
  const result = await evmRpcCall(chain, 'eth_getTransactionCount', [address, 'pending']);
  return parseInt(result, 16);
}

/**
 * Wait for an EVM transaction to be confirmed on-chain.
 * Polls eth_getTransactionReceipt until receipt is available or timeout.
 *
 * @param {string} chain - Chain name
 * @param {string} txHash - Transaction hash (0x...)
 * @param {number} [timeoutMs=30000] - Max wait time
 * @param {number} [pollMs=2000] - Poll interval
 * @returns {Promise<object>} Transaction receipt
 */
export async function waitForReceipt(chain, txHash, timeoutMs = 30000, pollMs = 2000) {
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
 * Send an ERC-20 approval transaction.
 * Required before swapping non-native EVM tokens.
 *
 * @param {string} tokenAddress - ERC-20 token contract
 * @param {string} spenderAddress - Approval target (from quote.approvalAddress)
 * @param {string} privateKeyHex - Wallet private key
 * @param {string} chain - Chain name
 * @param {number} nonce - Account nonce
 * @returns {string} 0x-prefixed signed approval tx hex
 */
// ⚠️ SECURITY: ERC-20 approval signing - requires thorough review
export function buildApprovalTransaction(tokenAddress, spenderAddress, privateKeyHex, chain, nonce, gasPrice) {
  const chainConfig = CHAIN_MAP[chain];
  if (!chainConfig) throw new Error(`Unsupported chain: ${chain}`);

  // ERC-20 approve(address spender, uint256 amount) selector = 0x095ea7b3
  // Approve max uint256
  const MAX_UINT256_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const data = '0x095ea7b3'
    + spenderAddress.slice(2).toLowerCase().padStart(64, '0')
    + MAX_UINT256_HEX;

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
  return /^0x[eE]{40}$/.test(mintAddress);
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
  if (quote.approvalAddress && !isNativeToken(quote.inputMint)) lines.push(`    ⚠ Requires token approval to: ${quote.approvalAddress}`);
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
  const { log = console.log, exit = process.exit } = deps;

  return {
    'quote': async (args, apiInstance, flags, options) => {
      const chain = options.chain || args[0];
      const fromRaw = options.from || options['from-token'] || args[1];
      const toRaw = options.to || options['to-token'] || args[2];
      const from = resolveTokenAddress(fromRaw, chain);
      const to = resolveTokenAddress(toRaw, chain);
      const amount = options.amount || args[3];
      const walletName = options.wallet;
      const slippage = options.slippage;
      const autoSlippage = flags['auto-slippage'] || flags.autoSlippage;
      const maxAutoSlippage = options['max-auto-slippage'];
      const swapMode = options['swap-mode'] || 'exactIn';
      const amountUnit = options['amount-unit'];

      if (!chain || !from || !to || !amount) {
        log(`
Usage: nansen trade quote --chain <chain> --from <token> --to <token> --amount <baseUnits>

PREREQUISITE:
  A wallet must be configured before using this command (the trading API builds
  a transaction specific to your sender address).
  Set one up with: nansen wallet create

OPTIONS:
  --chain <chain>           Chain: solana, base
  --from <symbol|address>   Input token (symbol like SOL, USDC or address)
  --to <symbol|address>     Output token (symbol like USDC, ETH or address)
  --amount <units>          Amount in BASE UNITS (e.g. lamports, wei)
  --amount-unit <unit>      "token" to specify amount in token units (e.g. 0.5 SOL)
  --wallet <name>           Wallet name (default: default wallet). Use "walletconnect" or "wc" for WalletConnect.
  --slippage <pct>          Slippage as decimal (e.g. 0.03 for 3%). Default: 0.03
  --auto-slippage           Enable auto slippage calculation
  --max-auto-slippage <pct> Max auto slippage when auto-slippage enabled
  --swap-mode <mode>        exactIn (default) or exactOut

EXAMPLES:
  nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
  nansen trade quote --chain solana --from SOL --to USDC --amount 0.5 --amount-unit token
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000
  nansen trade quote --chain solana --from So11111111111111111111111111111111111111112 --to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 1000000000
`);
        exit(1);
        return;
      }

      // Validate --amount-unit if provided
      if (amountUnit && amountUnit !== 'token' && amountUnit !== 'base') {
        log(`Error: Unknown --amount-unit "${amountUnit}". Supported values: token, base`);
        exit(1);
        return;
      }

      // When --amount-unit token is used, resolve decimals and convert to base units.
      // Otherwise, validate that the amount is already in base units (integer).
      let resolvedAmount = amount;
      if (amountUnit === 'token') {
        try {
          const tokenForDecimals = swapMode === 'exactOut' ? to : from;
          const decimals = await resolveTokenDecimals(tokenForDecimals, chain);
          resolvedAmount = convertToBaseUnits(amount, decimals);
        } catch (err) {
          log(`Error resolving token decimals: ${err.message}`);
          exit(1);
          return;
        }
      } else {
        const amountError = validateBaseUnitAmount(amount);
        if (amountError) {
          log(`Error: ${amountError}`);
          exit(1);
          return;
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
            log('No WalletConnect session active. Run: walletconnect connect');
            exit(1);
            return;
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
          log('No wallet found. A wallet address is required for quotes because the trading API builds a transaction specific to the sender.\nCreate one with: nansen wallet create');
          exit(1);
          return;
        }

        log(`\nFetching quote on ${chainConfig.name}...`);
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
        if (slippage) params.slippagePercent = slippage;
        if (autoSlippage) params.autoSlippage = true;
        if (maxAutoSlippage) params.maxAutoSlippagePercent = maxAutoSlippage;
        if (swapMode !== 'exactIn') params.swapMode = swapMode;

        const response = await getQuote(params);

        if (!response.success || !response.quotes?.length) {
          log('No quotes available');
          if (response.warnings?.length) {
            response.warnings.forEach(w => log(`  Warning: ${w}`));
          }
          exit(1);
          return;
        }

        log('');
        response.quotes.forEach((q, i) => log(formatQuote(q, i)));

        const signerType = isWalletConnect ? 'walletconnect' : walletProvider;
        const quoteId = saveQuote(response, chain, signerType, privyWalletIds);
        log(`\n  Quote ID: ${quoteId}`);
        log(`  Execute:  nansen trade execute --quote ${quoteId}`);
        if (response.quotes.length > 1) {
          log(`  Pin #1:  nansen trade execute --quote ${quoteId} --quote-index 0`);
        }

        if (response.quotes[0]?.approvalAddress && !isNativeToken(response.quotes[0]?.inputMint)) {
          log(`\n  Warning: This token swap requires an ERC-20 approval step.`);
          log(`    The execute command will handle this automatically.`);
        }

        log('');
        return undefined; // Output already printed above

      } catch (err) {
        let message = err.message;
        if (err.code === 'INVALID_AMOUNT' || /amount/i.test(err.message)) {
          message += '. Amounts must be in base units (e.g., 1000000000 lamports for 1 SOL, 1000000000000000000 wei for 1 ETH)';
        }
        log(`Error: ${message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || options['quote-id'] || args[0];
      const walletName = options.wallet;
      const noSimulate = flags['no-simulate'] || flags.noSimulate;

      if (!quoteId) {
        log(`
Usage: nansen trade execute --quote <quoteId> [options]

OPTIONS:
  --quote <id>              Quote ID from 'nansen quote'
  --wallet <name>           Wallet name (default: default wallet)
  --no-simulate             Skip pre-broadcast simulation

EXAMPLES:
  nansen trade execute --quote 1708900000000-abc123
`);
        exit(1);
        return;
      }

      try {
        const quoteData = loadQuote(quoteId);
        const chain = quoteData.chain;
        const chainConfig = resolveChain(chain);
        const chainType = chainConfig.type;

        const allQuotes = quoteData.response.quotes || [];
        if (!allQuotes.length) {
          log('❌ No quote data found');
          exit(1);
          return;
        }

        // --quote-index pins a specific quote (no fallback)
        const pinIndex = options['quote-index'] != null ? parseInt(options['quote-index'], 10) : null;
        const startIndex = pinIndex ?? 0;
        const endIndex = pinIndex != null ? startIndex + 1 : allQuotes.length;

        // Check if any quote in range has transaction data before prompting for password
        const hasAnyTransaction = allQuotes.slice(startIndex, endIndex).some(q => q?.transaction);
        if (!hasAnyTransaction) {
          log('❌ No quotes contain transaction data.');
          log('  Ensure userWalletAddress was provided when fetching the quote.');
          exit(1);
          return;
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
              log(JSON.stringify({
                error: 'PASSWORD_REQUIRED',
                message: 'Wallet is encrypted and no password was found.',
                resolution: [
                  'Set NANSEN_WALLET_PASSWORD environment variable',
                  'Or run: nansen wallet create (password is saved to OS keychain automatically)',
                ],
              }));
              exit(1);
              return;
            }
          }

          let effectiveWalletName = walletName;
          if (!effectiveWalletName) {
            const list = listWallets();
            effectiveWalletName = list.defaultWallet;
          }
          if (!effectiveWalletName) {
            log('No wallet found. Create one with: nansen wallet create');
            exit(1);
            return;
          }

          exported = exportWallet(effectiveWalletName, password);
        } else {
          // Verify WalletConnect session is still active and address matches quote
          const wcAddress = await getWalletConnectAddress(chainType);
          if (!wcAddress) {
            log('No WalletConnect session active. Run: walletconnect connect');
            exit(1);
            return;
          }
          // Check address matches the one used during quoting
          const quoteWallet = quoteData.response?.quotes?.[0]?.transaction?.from
            || quoteData.response?.metadata?.userWalletAddress;
          if (quoteWallet && (chainType === 'solana'
            ? wcAddress.trim() !== quoteWallet.trim()
            : wcAddress.toLowerCase().trim() !== quoteWallet.toLowerCase().trim())) {
            log(`Connected wallet (${wcAddress}) doesn't match quote. Get a new quote with --wallet walletconnect`);
            exit(1);
            return;
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
              if (currentQuote.approvalAddress && !isNative) {
                const inputAmount = BigInt(currentQuote.inputAmount || currentQuote.inAmount || '0');
                const existingAllowance = await checkErc20Allowance(
                  chain, currentQuote.inputMint, walletAddress, currentQuote.approvalAddress
                );

                if (existingAllowance >= inputAmount && existingAllowance > 0n) {
                  log(`  ✓ Sufficient allowance exists for ${quoteName}, skipping approval`);
                } else {
                  log(`  ⚠ Approval required → ${currentQuote.approvalAddress}`);
                  const approvalNonce = await getEvmNonce(chain, walletAddress);
                  const MAX_UINT256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
                  const approvalData = '0x095ea7b3'
                    + currentQuote.approvalAddress.slice(2).toLowerCase().padStart(64, '0')
                    + MAX_UINT256;
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
              if (!noSimulate) {
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
              if (currentQuote.approvalAddress && !isNative) {
                const inputAmount = BigInt(currentQuote.inputAmount || currentQuote.inAmount || '0');
                const existingAllowance = await checkErc20Allowance(
                  chain, currentQuote.inputMint, wcAddress, currentQuote.approvalAddress
                );

                if (existingAllowance >= inputAmount && existingAllowance > 0n) {
                  log(`  ✓ Sufficient allowance exists for ${quoteName}, skipping approval`);
                } else {
                  log(`  ⚠ Approval required → ${currentQuote.approvalAddress}`);
                  log(`  Sending approval via WalletConnect...`);
                  try {
                    const approvalResult = await sendApprovalViaWalletConnect(
                      currentQuote.inputMint,
                      currentQuote.approvalAddress,
                      chainConfig.chainId,
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
              if (!noSimulate) {
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
                  exit(1);
                  return;
                }

                log(`\n  ✓ Transaction successful!`);
                log(`    Tx Hash:   ${wcResult.txHash}`);
                log(`    Chain:       ${chainConfig.name}`);
                log(`    Explorer:    ${chainConfig.explorer}${wcResult.txHash}`);
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

              if (currentQuote.approvalAddress && !isNative) {
                // Check if sufficient allowance already exists
                const inputAmount = BigInt(currentQuote.inputAmount || currentQuote.inAmount || currentQuote.transaction?.value || '0');
                const existingAllowance = await checkErc20Allowance(
                  chain, currentQuote.inputMint, walletAddress, currentQuote.approvalAddress
                );

                if (existingAllowance >= inputAmount && existingAllowance > 0n) {
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
              if (!noSimulate) {
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

            log('  Broadcasting...');
            const execParams = {
              signedTransaction,
              chain,
              simulate: !noSimulate,
            };
            if (requestId) execParams.requestId = requestId;

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
                  log(`\n  The trading API reported success, but the contract execution failed.`);
                  log(`  This can happen due to: stale quotes, insufficient gas, or liquidity changes.`);
                  exit(1);
                  return;
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
              log('');
              return undefined; // Success — done
            } else {
              log(`\n  ✗ Quote ${quoteName} failed: ${result.status}`);
              if (result.error) log(`    Error:  ${result.error}`);
              lastQuoteError = `${quoteName}: ${result.error || result.status}`;
              if (qi + 1 < endIndex) log(`  Trying next quote...`);
            }

          } catch (quoteErr) {
            log(`  ❌ Quote ${quoteName} failed: ${quoteErr.message}`);
            lastQuoteError = `${quoteName}: ${quoteErr.message}`;
            if (qi + 1 < endIndex) log(`  Trying next quote...`);
          }
        }

        // All quotes exhausted
        log(`\n❌ All quotes failed. Last error: ${lastQuoteError || 'unknown'}`);
        log('');
        exit(1);
        return undefined;

      } catch (err) {
        log(`Error: ${err.message}`);
        if (err.details) log(`  Details: ${JSON.stringify(err.details)}`);
        exit(1);
      }
    },
  };
}
