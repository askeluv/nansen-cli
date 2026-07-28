/**
 * nansen bridge — Hyperliquid bridge commands (EVM <-> Hyperliquid via Relay).
 *
 * Calls nansen-api /api/v1/perp/bridge/* endpoints. Transaction signing and
 * EVM broadcasting happen client-side; HL withdrawal signatures are
 * proxied through the API's /perp/bridge/execute endpoint.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CommandError } from './api.js';
import { signSecp256k1 } from './crypto.js';
import { retrievePassword } from './keychain.js';
import {
  convertToBaseUnits,
  evmRpcCall,
  getEvmNonce,
  getQuotesDir,
  resolveUsdPrice,
  safeQuotesPath,
  signEvmTransaction,
  waitForReceipt,
} from './trading.js';
import { screenOrThrow } from './perp.js';
import { exportWallet, getWalletConfig, showWallet } from './wallet.js';
import { hashTypedData } from './x402-evm.js';

const QUOTE_TTL_MS = 3600000; // 1 hour

const BRIDGE_TOKENS = {
  ethereum:    { USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  base:        { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  arbitrum:    { USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  hyperliquid: { USDC: '0x00000000000000000000000000000000' },
};

// Routes this CLI can actually complete, as ordered [origin, destination] pairs.
// Deliberately narrower than the API accepts, and asymmetric, because the two
// directions need different things from us:
//
//   Deposits (EVM → HL) broadcast an EVM transaction locally, so the origin
//   chain must be signable by signEvmTransaction — which only knows Base. The
//   API accepts ethereum/arbitrum/polygon/bnb origins as well, but nothing here
//   can sign them, so offering them would just fail at execute time. Base → HL
//   is also the only deposit route with a real-money round-trip behind it.
//
//   Withdrawals (HL → EVM) sign a Hyperliquid EIP-712 action instead and never
//   touch the destination chain, so no local per-chain support is needed; these
//   mirror the API's supported pairs.
//
// Widening the deposit side means teaching signEvmTransaction the chain AND
// putting real funds through it first.
const BRIDGE_ROUTES = [
  ['base', 'hyperliquid'],
  ['hyperliquid', 'base'],
  ['hyperliquid', 'ethereum'],
  ['hyperliquid', 'arbitrum'],
];

function isSupportedBridgeRoute(originChain, destinationChain) {
  return BRIDGE_ROUTES.some(([o, d]) => o === originChain && d === destinationChain);
}

function formatBridgeRoutes() {
  return BRIDGE_ROUTES.map(([o, d]) => `${o} -> ${d}`).join(', ');
}

function resolveBridgeToken(symbolOrAddress, chain) {
  if (!symbolOrAddress || !chain) return symbolOrAddress;
  const tokens = BRIDGE_TOKENS[chain.toLowerCase()];
  if (!tokens) return symbolOrAddress;
  return tokens[symbolOrAddress.toUpperCase()] || symbolOrAddress;
}

function isBridgeUsdc(tokenAddress, chain) {
  const usdc = BRIDGE_TOKENS[chain.toLowerCase()]?.USDC;
  return !!usdc && tokenAddress.toLowerCase() === usdc.toLowerCase();
}

// Resolve a token's on-chain decimals so a human --amount can be converted to
// base units. USDC is 6 on every supported EVM chain but 8 on Hyperliquid (the
// crux of the per-chain decimals trap); other EVM tokens fall back to decimals().
export async function resolveBridgeTokenDecimals(tokenAddress, chain) {
  const normChain = chain.toLowerCase();
  if (normChain === 'hyperliquid') {
    if (isBridgeUsdc(tokenAddress, normChain)) return 8;
    throw new Error(
      `Cannot resolve decimals for ${tokenAddress} on hyperliquid. Pass --amount in base units (omit --amount-unit).`,
    );
  }
  if (isBridgeUsdc(tokenAddress, normChain)) return 6;
  // EVM fallback: decimals() selector 0x313ce567
  const result = await evmRpcCall(normChain, 'eth_call', [{ to: tokenAddress, data: '0x313ce567' }, 'latest']);
  const decimals = parseInt(result, 16);
  if (isNaN(decimals) || decimals > 255) {
    throw new Error(`Could not resolve decimals for ${tokenAddress} on ${normChain}.`);
  }
  return decimals;
}

// USDC's canonical precision the Relay bridge formats Hyperliquid sendAsset to.
const HYPERLIQUID_USDC_BRIDGE_DECIMALS = 6;

// Hyperliquid spot USDC is 8 decimals, but the Relay bridge rounds the sendAsset
// amount to USDC's 6 decimals (round-half-up). Submitting the full 8-decimal
// amount can round UP past the balance, which Hyperliquid rejects. Flooring to 6
// keeps the bridge's rounding a no-op. (Mirrors Superapp SUPER-13582.)
export function floorHyperliquidUsdcBridgeAmount(amountBaseUnits, decimals, tokenAddress, chain) {
  if (chain.toLowerCase() !== 'hyperliquid' || !isBridgeUsdc(tokenAddress, chain)) {
    return amountBaseUnits;
  }
  const dropped = decimals - HYPERLIQUID_USDC_BRIDGE_DECIMALS;
  if (dropped <= 0) return amountBaseUnits;
  const factor = 10n ** BigInt(dropped);
  return ((BigInt(amountBaseUnits) / factor) * factor).toString();
}

// Slippage is whole basis points in [0, 10000] (50 = 0.5%, 10000 = 100%).
// Validate client-side so "abc" or "-1" fail here with a clear message instead
// of an opaque backend 422, matching how `perp` validates --slippage. parseInt
// alone would silently accept "999abc" (-> 999) or "-1", so check the string
// shape before parsing.
export function parseSlippageBps(raw) {
  const s = String(raw).trim();
  const bad = `Invalid --slippage "${raw}". Use whole basis points between 0 and 10000 (e.g. 50 = 0.5%).`;
  if (!/^\d+$/.test(s)) throw new Error(bad);
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error(bad);
  return n;
}

// ── API helpers ──────────────────────────────────────────────────────

// cache: false — a quote carries live pricing, fees and per-step transaction
// data, and is cached locally as a quote file anyway. Replaying a stale one
// would mean signing against amounts the route no longer offers.
async function getBridgeQuote(apiInstance, params) {
  return apiInstance.request('/api/v1/perp/bridge/quote', params, { cache: false });
}

// retry: false because this is not idempotent — it proxies to Relay's
// /authorize and to Hyperliquid's /exchange, so an automatic re-send on a 500
// or 502 can submit the same signed action twice. hl-client.js's submitExchange
// documents the same reasoning for the direct path; this is the proxied one.
async function postBridgeExecute(apiInstance, targetUrl, body) {
  return apiInstance.request(
    '/api/v1/perp/bridge/execute',
    { target_url: targetUrl, body },
    { cache: false, retry: false },
  );
}

// cache: false, and here it is what makes polling work at all. The cache key is
// endpoint + body, so every poll for a given request id is the same key — under
// --cache the loop would re-read one cached verdict for the whole TTL and stay
// blind to a bridge that had already completed or failed.
async function getBridgeStatus(apiInstance, { requestId, txHash }) {
  const params = new URLSearchParams();
  if (requestId) params.set('request_id', requestId);
  if (txHash) params.set('tx_hash', txHash);
  return apiInstance.request(`/api/v1/perp/bridge/status?${params}`, {}, { method: 'GET', cache: false });
}

// ── Quote caching ────────────────────────────────────────────────────

function saveBridgeQuote(response, originChain, destinationChain, walletProvider, walletAddress) {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.randomBytes(4).toString('hex');
  const quoteId = `bridge-${Date.now()}-${hash}`;
  const data = {
    quoteId,
    type: 'bridge',
    originChain,
    destinationChain,
    walletProvider,
    walletAddress,
    timestamp: Date.now(),
    response,
  };
  const filePath = path.join(dir, `${quoteId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  return quoteId;
}

export function loadBridgeQuote(quoteId) {
  const filePath = safeQuotesPath(`${quoteId}.json`);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Bridge quote "${quoteId}" not found. Quotes expire after 1 hour.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Date.now() - data.timestamp > QUOTE_TTL_MS) {
    fs.unlinkSync(filePath);
    throw new Error('Bridge quote has expired. Please request a new quote.');
  }
  if (data.type !== 'bridge') {
    throw new Error(`Quote "${quoteId}" is not a bridge quote. Use "nansen trade execute" for a swap quote.`);
  }
  if (data.executedAt) {
    // Quotes are single-use: re-signing and re-broadcasting would move funds
    // a second time. Refuse a quote that has already been executed.
    const when = new Date(data.executedAt).toISOString();
    const fullyDone = data.totalSteps && data.broadcastSteps >= data.totalSteps;
    if (!fullyDone && data.broadcasts?.length) {
      // Something is in flight but the run didn't finish — e.g. the tx was
      // accepted and the receipt wait timed out. Re-running would re-send it, so
      // refuse and name the hashes so the operator can check what landed.
      const hashes = data.broadcasts.map(b => b.txHash).filter(Boolean);
      const detail = hashes.length ? ` (${hashes.join(', ')})` : '';
      throw new Error(
        `Bridge quote "${quoteId}" partially executed at ${when}: ${data.broadcasts.length} transaction(s) already broadcast${detail}. Funds may be in flight — check "nansen bridge status" before requesting a new quote.`,
      );
    }
    if (data.totalSteps && data.broadcastSteps && data.broadcastSteps < data.totalSteps) {
      // Partial execution: a later step failed after an earlier one had already
      // been broadcast. Re-running from step 0 would re-send what already went
      // out, so refuse and say what landed — the funds may be in flight.
      throw new Error(
        `Bridge quote "${quoteId}" partially executed at ${when}: ${data.broadcastSteps} of ${data.totalSteps} steps were broadcast. Check "nansen bridge status" before requesting a new quote — the earlier step may already have moved funds.`,
      );
    }
    throw new Error(
      `Bridge quote "${quoteId}" was already executed at ${when}. Request a new quote to bridge again.`,
    );
  }
  return data;
}

// Records that a broadcast has happened. `executedAt` is set on the first call
// and never moved, so the quote is consumed the moment any step goes out — a
// later step throwing must not leave the quote reusable. The step counters make
// a partial failure legible to the operator (see loadBridgeQuote).
export function markBridgeQuoteExecuted(quoteId, progress = {}) {
  const filePath = safeQuotesPath(`${quoteId}.json`);
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.executedAt = data.executedAt || Date.now();
    if (progress.broadcast) {
      data.broadcasts = [...(data.broadcasts || []), { ...progress.broadcast, at: Date.now() }];
    }
    if (progress.broadcastSteps !== undefined) {
      data.broadcastSteps = Math.max(data.broadcastSteps || 0, progress.broadcastSteps);
    }
    if (progress.totalSteps !== undefined) data.totalSteps = progress.totalSteps;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort: if the marker can't be written, the next execute attempt
    // will still proceed, but that's preferable to crashing after a successful
    // broadcast.
  }
}

// ── EIP-712 signing (for HL withdrawals) ─────────────────────────────

// `types[primaryType] || []` used to swallow a missing type definition: with no
// fields, hashStruct hashes typeHash("PrimaryType()") over none of the message's
// contents, so we would hand back a well-formed signature that commits to
// nothing about the action being authorised. Refuse instead — an omitted or
// misspelled type list is a bug or a tampered response, never something to sign
// through.
function signEip712Local(typedData, privateKeyHex, context = 'EIP-712 payload') {
  const { domain, types, primaryType, message } = typedData;
  const fields = (types?.[primaryType] || []).map(f => ({ name: f.name, type: f.type }));
  if (fields.length === 0) {
    throw new Error(
      `${context} is missing its EIP-712 type definition for "${primaryType}", so the signature would not cover the action. Refusing to sign.`,
    );
  }
  const msgHash = hashTypedData(domain, primaryType, fields, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  return '0x' + r.toString('hex') + s.toString('hex') + (27 + v).toString(16).padStart(2, '0');
}

// ── Step processors ──────────────────────────────────────────────────

// Headroom multiplier applied to the current base fee when setting maxFeePerGas.
// A type-2 transaction only ever pays baseFee + priority, so a generous cap
// costs nothing extra — it just buys tolerance for the base fee moving between
// signing and inclusion. Base's fee moved ~2x within minutes while this was
// being tested, so the tolerance is not theoretical.
const BASE_FEE_HEADROOM = 3n;

// Floor for maxPriorityFeePerGas, in wei (0.01 gwei).
//
// The priority fee is what orders a transaction for inclusion, and it is where a
// real deposit got stuck: Relay quotes ~0.0011 gwei, while Base was including at
// ~0.008 gwei and up, so the transaction sat in the mempool and burned the nonce.
// A cap alone does not fix that — the cap is only what you are *willing* to pay.
// At 21k-75k gas this floor is a small fraction of a cent per step.
const MIN_PRIORITY_FEE_WEI = 10000000n;

// Decide the fee fields for an EVM bridge step.
//
// Relay's quote already carries maxFeePerGas/maxPriorityFeePerGas, which this
// used to discard in favour of a bare eth_gasPrice reading — producing a legacy
// transaction priced at roughly the current base fee with almost no priority
// fee. Keep Relay's intent, but raise the priority fee to something Base will
// actually schedule and lift the cap to cover it plus base-fee movement.
export async function resolveEvmStepFees(chain, txData) {
  if (txData.maxFeePerGas) {
    let maxPriorityFeePerGas = BigInt(txData.maxPriorityFeePerGas ?? 0);
    if (maxPriorityFeePerGas < MIN_PRIORITY_FEE_WEI) {
      maxPriorityFeePerGas = MIN_PRIORITY_FEE_WEI;
    }

    // The cap must cover the raised priority fee, or the transaction is
    // self-contradictory: maxFeePerGas < maxPriorityFeePerGas is rejected
    // outright by every node.
    let maxFeePerGas = BigInt(txData.maxFeePerGas);
    try {
      const block = await evmRpcCall(chain, 'eth_getBlockByNumber', ['latest', false]);
      const baseFee = BigInt(block?.baseFeePerGas ?? 0);
      const floor = baseFee * BASE_FEE_HEADROOM + maxPriorityFeePerGas;
      if (floor > maxFeePerGas) maxFeePerGas = floor;
    } catch {
      // Base-fee lookup is best-effort, but the cap still has to clear the
      // priority fee even without it.
      if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
    }

    return {
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    };
  }

  // Pre-1559 shape (or a quote that only gave a flat price): fall back to the
  // node's reading, which is what the legacy signer needs.
  return { gasPrice: await evmRpcCall(chain, 'eth_gasPrice') };
}

async function processEvmStep(step, { chain, privateKeyHex, log, onBroadcast }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const txData = item.data;

    const fees = await resolveEvmStepFees(chain, txData);
    const nonce = await getEvmNonce(chain, txData.from);

    const signedTx = signEvmTransaction(
      { ...txData, ...fees },
      privateKeyHex,
      chain,
      parseInt(nonce, 16),
    );

    log(`  Broadcasting ${step.id} on ${chain}...`);
    const txHash = await evmRpcCall(chain, 'eth_sendRawTransaction', [signedTx]);
    // In flight now: record it before waiting on the receipt, because a receipt
    // timeout must not leave the quote reusable.
    onBroadcast?.(step.id, txHash);
    log(`  Tx: ${txHash}`);

    const receipt = await waitForReceipt(chain, txHash);
    const status = parseInt(receipt.status, 16);
    if (status !== 1) {
      throw new Error(`Transaction reverted: ${txHash}`);
    }
    log(`  Confirmed in block ${parseInt(receipt.blockNumber, 16)}`);
  }
}

async function processSignatureStepLocal(step, { privateKeyHex, log, apiInstance, onBroadcast }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const { data: signData } = item;

    if (signData.sign) {
      const typedData = {
        domain: signData.sign.domain,
        types: signData.sign.types,
        primaryType: signData.sign.primaryType,
        message: signData.sign.value,
      };
      const signature = signEip712Local(typedData, privateKeyHex, `Bridge step "${step.id}"`);

      let targetUrl = signData.post.endpoint;
      if (!targetUrl.startsWith('http')) {
        targetUrl = `https://api.relay.link${targetUrl}`;
      }
      const postBody = { ...signData.post.body };

      if (targetUrl.includes('/authorize')) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${sep}signature=${signature}`;
      } else {
        postBody.signature = signature;
      }

      log(`  Signing ${step.id} (EIP-712)...`);
      await postBridgeExecute(apiInstance, targetUrl, postBody);
      onBroadcast?.(step.id, null);
      log(`  Submitted to ${new URL(targetUrl).hostname}`);
    } else if (signData.action) {
      const domain = {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: 1,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      };
      const types = signData.eip712Types || {};
      const primaryType = signData.eip712PrimaryType || 'HyperliquidTransaction';
      const message = {
        ...(signData.action.parameters || signData.action),
        type: signData.action.type,
        signatureChainId: '0x1',
      };

      const typedData = { domain, types, primaryType, message };
      const signature = signEip712Local(typedData, privateKeyHex, `Bridge step "${step.id}"`);
      const [rHex, sHex, vHex] = [signature.slice(2, 66), signature.slice(66, 130), signature.slice(130, 132)];

      const flatAction = { type: signData.action.type, ...signData.action.parameters, signatureChainId: '0x1' };
      const hlBody = {
        action: flatAction,
        nonce: signData.nonce,
        signature: { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) },
        vaultAddress: null,
      };

      log(`  Signing ${step.id} (Hyperliquid deposit)...`);
      await postBridgeExecute(apiInstance, 'https://api.hyperliquid.xyz/exchange', hlBody);
      onBroadcast?.(step.id, null);
      log(`  Submitted to api.hyperliquid.xyz`);
    }
  }
}

async function processSignatureStepPrivy(step, { privyClient, walletId, log, apiInstance, onBroadcast }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const { data: signData } = item;

    let typedData;
    if (signData.sign) {
      typedData = {
        domain: signData.sign.domain,
        types: signData.sign.types,
        primaryType: signData.sign.primaryType,
        message: signData.sign.value,
      };
    } else if (signData.action) {
      typedData = {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 1,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: signData.eip712Types || {},
        primaryType: signData.eip712PrimaryType || 'HyperliquidTransaction',
        message: {
          ...(signData.action.parameters || signData.action),
          type: signData.action.type,
          signatureChainId: '0x1',
        },
      };
    } else {
      throw new Error(`Unexpected signature step format for ${step.id}`);
    }

    log(`  Signing ${step.id} via Privy...`);
    const result = await privyClient.ethSignTypedDataV4(walletId, typedData);
    const signature = result.data?.signature || result.signature || result;

    if (signData.sign) {
      let targetUrl = signData.post.endpoint;
      if (!targetUrl.startsWith('http')) targetUrl = `https://api.relay.link${targetUrl}`;
      const postBody = { ...signData.post.body };
      if (targetUrl.includes('/authorize')) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${sep}signature=${signature}`;
      } else {
        postBody.signature = signature;
      }
      await postBridgeExecute(apiInstance, targetUrl, postBody);
      onBroadcast?.(step.id, null);
    } else {
      const [rHex, sHex, vHex] = [signature.slice(2, 66), signature.slice(66, 130), signature.slice(130, 132)];
      const flatAction = { type: signData.action.type, ...signData.action.parameters, signatureChainId: '0x1' };
      const hlBody = {
        action: flatAction,
        nonce: signData.nonce,
        signature: { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) },
        vaultAddress: null,
      };
      await postBridgeExecute(apiInstance, 'https://api.hyperliquid.xyz/exchange', hlBody);
      onBroadcast?.(step.id, null);
    }
    log(`  Submitted`);
  }
}

// ── Status polling ───────────────────────────────────────────────────

async function pollBridgeCompletion(apiInstance, { requestId, txHash, timeoutMs = 600000, pollMs = 10000, log = console.log }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await getBridgeStatus(apiInstance, { requestId, txHash });
      log(`  Bridge: ${status.status} (${status.raw_status || ''})`);
      if (status.status === 'success') return status;
      if (status.status === 'failure') {
        throw Object.assign(new Error('Bridge failed'), { code: 'BRIDGE_FAILED', details: status });
      }
      if (status.status === 'refund') {
        log('  Bridge: REFUNDED — funds returned on source chain');
        return status;
      }
    } catch (err) {
      if (err.code === 'BRIDGE_FAILED') throw err;
      log(`  Bridge: poll error — retrying...`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw Object.assign(
    new Error(`Bridge polling timed out after ${timeoutMs / 1000}s. Check manually: nansen bridge status --request-id ${requestId || txHash}`),
    { code: 'BRIDGE_TIMEOUT' },
  );
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
  return {
    address: wallet.evm,
    provider: wallet.provider || 'local',
    privyWalletIds: wallet.privyWalletIds || null,
  };
}

function resolveWalletCredentials(walletName) {
  const config = getWalletConfig();
  const isPrivy = (() => {
    try {
      const w = showWallet(walletName || config.defaultWallet);
      return w.provider === 'privy';
    } catch { return false; }
  })();

  if (isPrivy) {
    return { provider: 'privy', privateKey: null };
  }

  let password = null;
  if (config.passwordHash) {
    const { password: pw, source } = retrievePassword();
    if (source === 'file') {
      process.stderr.write(
        '⚠️  Password loaded from ~/.nansen/wallets/.credentials (insecure).\n',
      );
    }
    password = pw;
  }

  const name = walletName || config.defaultWallet;
  if (!name) throw new Error('No wallet found. Create one with: nansen wallet create');
  const exported = exportWallet(name, password);
  return { provider: 'local', privateKey: exported.evm.privateKey };
}

// ── Command builder ──────────────────────────────────────────────────

export function buildBridgeCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'quote': async (args, apiInstance, flags, options) => {
      const originChain = (options['from-chain'] || options.from || '').toLowerCase();
      const destinationChain = (options['to-chain'] || options.to || '').toLowerCase();
      const fromTokenRaw = options['from-token'] || options.token || '';
      const toTokenRaw = options['to-token'] || '';
      const amount = options.amount;
      // Normalize so "Token"/"USD" etc. are accepted; reject anything unknown
      // rather than silently falling back to base units (which would re-open the
      // per-chain magnitude trap --amount-unit exists to prevent).
      const amountUnit = options['amount-unit'] != null
        ? String(options['amount-unit']).toLowerCase()
        : undefined;
      const slippageBps = options.slippage !== undefined ? parseSlippageBps(options.slippage) : 50;
      const walletName = options.wallet;
      const recipient = options.recipient;

      if (amountUnit !== undefined && amountUnit !== 'token' && amountUnit !== 'usd') {
        throw new Error(
          `Invalid --amount-unit "${options['amount-unit']}". Must be "token" or "usd" (omit for base units).`,
        );
      }

      if (!originChain || !destinationChain || !fromTokenRaw || !amount) {
        throw new CommandError(
          `Usage: nansen bridge quote --from-chain <chain> --to-chain <chain> --from-token <token> --amount <amount> [--wallet <name>]

SUPPORTED ROUTES:
  ${BRIDGE_ROUTES.map(([o, d]) => `${o} -> ${d}`).join('\n  ')}

OPTIONS:
  --from-chain    Source chain (see supported routes above)
  --to-chain      Destination chain (see supported routes above)
  --from-token    Source token (symbol like USDC, or address)
  --to-token      Destination token (defaults to USDC)
  --amount        Amount. Base units by default (decimals differ per chain:
                  USDC is 6 on EVM chains, 8 on Hyperliquid). Use --amount-unit
                  to pass human amounts instead.
  --amount-unit   token (human token amount) or usd. Omit for base units.
  --slippage      Slippage in bps (default 50 = 0.5%)
  --wallet        Wallet name
  --recipient     Destination wallet (defaults to same address)`,
          'MISSING_PARAM',
        );
      }

      if (!isSupportedBridgeRoute(originChain, destinationChain)) {
        throw new Error(
          `Unsupported bridge route: ${originChain} -> ${destinationChain}. Supported routes: ${formatBridgeRoutes()}`,
        );
      }

      const originToken = resolveBridgeToken(fromTokenRaw, originChain);
      const destinationToken = toTokenRaw
        ? resolveBridgeToken(toTokenRaw, destinationChain)
        : resolveBridgeToken('USDC', destinationChain);

      const wallet = resolveWalletAddress(walletName);

      // Default: --amount is base units. With --amount-unit, accept a human token
      // or USD amount and convert client-side using the source token's decimals.
      let resolvedAmount = amount;
      if (amountUnit === 'token' || amountUnit === 'usd') {
        try {
          const decimals = await resolveBridgeTokenDecimals(originToken, originChain);
          let humanAmount = amount;
          if (amountUnit === 'usd') {
            // USDC is USD-pegged ($1), so skip the price lookup — and Hyperliquid's
            // USDC uses a sentinel address the price API can't resolve, which would
            // otherwise make `--amount-unit usd` unusable from HL. Non-stable tokens
            // still fetch a live price.
            const price = isBridgeUsdc(originToken, originChain)
              ? 1
              : await resolveUsdPrice(apiInstance, originToken, originChain);
            humanAmount = (parseFloat(amount) / price).toFixed(decimals);
          }
          resolvedAmount = convertToBaseUnits(humanAmount, decimals);
          resolvedAmount = floorHyperliquidUsdcBridgeAmount(resolvedAmount, decimals, originToken, originChain);
        } catch (err) {
          throw new Error(`Error converting --amount: ${err.message}`, { cause: err });
        }
      }

      log(`\n  Fetching bridge quote: ${originChain} → ${destinationChain}...`);

      const result = await getBridgeQuote(apiInstance, {
        wallet_address: wallet.address,
        origin_chain: originChain,
        destination_chain: destinationChain,
        origin_token: originToken,
        destination_token: destinationToken,
        amount: resolvedAmount,
        slippage_bps: slippageBps,
        ...(recipient && { recipient }),
      });

      const details = result.details || {};
      const currIn = details.currencyIn || {};
      const currOut = details.currencyOut || {};
      const fees = result.fees || {};
      const relayerFee = fees.relayer || {};

      log(`\n  Bridge Quote: ${originChain} → ${destinationChain}`);
      log(`  Type:    ${result.execution_type}`);
      log(`  Send:    ${currIn.amountFormatted || amount} ${currIn.currency?.symbol || originToken}`);
      log(`  Receive: ${currOut.amountFormatted || '?'} ${currOut.currency?.symbol || destinationToken}`);
      if (relayerFee.amountUsd) {
        log(`  Fee:     $${relayerFee.amountUsd}`);
      }
      log(`  Steps:   ${(result.steps || []).length}`);
      for (const s of result.steps || []) {
        log(`    - ${s.id} (${s.kind})`);
      }

      const quoteId = saveBridgeQuote(result, originChain, destinationChain, wallet.provider, wallet.address);
      log(`\n  Quote ID: ${quoteId}`);
      log(`  Execute:  nansen bridge execute --quote ${quoteId}`);
      log('');
      return undefined;
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || args[0];
      const walletName = options.wallet;

      if (!quoteId) {
        throw new CommandError(
          `Usage: nansen bridge execute --quote <quoteId> [--wallet <name>]

Execute a cached bridge quote. Signs transactions and broadcasts them.`,
          'MISSING_PARAM',
        );
      }

      const quoteData = loadBridgeQuote(quoteId);
      const { execution_type, steps, request_id } = quoteData.response;

      log(`\n  Executing bridge: ${quoteData.originChain} → ${quoteData.destinationChain}`);
      log(`  Type: ${execution_type}`);
      log(`  Steps: ${steps.length}`);

      // The quote was issued for one wallet, but the signing wallet is resolved
      // separately from --wallet / the current default — which can have changed
      // since. Signing with a different wallet than the quote was built for would
      // screen one address and move funds from another, and the cached tx data
      // (nonce, from) belongs to the quote's wallet regardless. Refuse instead.
      const signer = resolveWalletAddress(walletName);
      if (
        quoteData.walletAddress &&
        String(signer.address).toLowerCase() !== String(quoteData.walletAddress).toLowerCase()
      ) {
        throw new Error(
          `Bridge quote "${quoteId}" was created for ${quoteData.walletAddress} but the signing wallet is ${signer.address}. Pass --wallet for the quote's wallet, or request a new quote.`,
        );
      }

      // Re-screen immediately before signing, fail-closed, mirroring the perp
      // path — and screen the address that actually signs, now known to match the
      // quote. The quote was screened server-side when issued, but quotes live up
      // to an hour and the EVM deposit leg broadcasts straight to a public RPC, so
      // without this nothing re-checks the wallet between the quote and the
      // transaction that moves funds.
      await screenOrThrow(apiInstance, [signer.address]);

      const creds = resolveWalletCredentials(walletName);

      // Consume the quote at each INDIVIDUAL broadcast, before any receipt wait.
      // A tx can be accepted by the network and then have waitForReceipt time
      // out; if the quote were still unspent, a retry would re-sign and re-send
      // it with a fresh nonce. markBridgeQuoteExecuted pins executedAt on the
      // first call, so the quote is spent the instant anything is in flight.
      const onBroadcast = (stepId, txHash) =>
        markBridgeQuoteExecuted(quoteId, {
          broadcast: { step: stepId, txHash: txHash || null },
          totalSteps: steps.length,
        });

      // Step-level counter, recorded only once a step fully completes.
      const markBroadcast = (index) =>
        markBridgeQuoteExecuted(quoteId, {
          broadcastSteps: index + 1,
          totalSteps: steps.length,
        });

      if (execution_type === 'evm_transaction') {
        for (const [index, step] of steps.entries()) {
          await processEvmStep(step, {
            chain: quoteData.originChain,
            privateKeyHex: creds.privateKey,
            log,
            onBroadcast,
          });
          markBroadcast(index);
        }
      } else if (execution_type === 'hyperliquid_signature') {
        if (creds.provider === 'privy') {
          const { PrivyClient } = await import('./privy.js');
          const privyClient = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
          for (const [index, step] of steps.entries()) {
            await processSignatureStepPrivy(step, {
              privyClient,
              // `signer` above — the same resolution that was screened and
              // matched against the quote, rather than resolving a second time.
              walletId: signer.privyWalletIds?.evm,
              log,
              apiInstance,
              onBroadcast,
            });
            markBroadcast(index);
          }
        } else {
          for (const [index, step] of steps.entries()) {
            await processSignatureStepLocal(step, {
              privateKeyHex: creds.privateKey,
              log,
              apiInstance,
              onBroadcast,
            });
            markBroadcast(index);
          }
        }
      } else {
        throw new Error(`Unknown execution type: ${execution_type}`);
      }

      // Every step is out; the marker above already consumed the quote.
      markBridgeQuoteExecuted(quoteId, { broadcastSteps: steps.length, totalSteps: steps.length });

      log(`\n  Bridge submitted. Polling for completion...`);
      const status = await pollBridgeCompletion(apiInstance, { requestId: request_id, log });

      if (status.status === 'success') {
        log(`\n  Bridge completed!`);
        if (status.destination_tx_hashes?.length) {
          log(`  Destination tx: ${status.destination_tx_hashes[0]}`);
        }
      }
      log('');
      return undefined;
    },

    'status': async (args, apiInstance, flags, options) => {
      const requestId = options['request-id'] || args[0];
      const txHash = options['tx-hash'];

      if (!requestId && !txHash) {
        throw new CommandError(
          `Usage: nansen bridge status --request-id <id> or --tx-hash <hash>

Check the status of a Hyperliquid bridge transaction.`,
          'MISSING_PARAM',
        );
      }

      const status = await getBridgeStatus(apiInstance, { requestId, txHash });

      log(`\n  Bridge Status: ${status.status}`);
      if (status.raw_status) log(`  Raw:     ${status.raw_status}`);
      if (status.source_tx_hashes?.length) log(`  Source:  ${status.source_tx_hashes.join(', ')}`);
      if (status.destination_tx_hashes?.length) log(`  Dest:    ${status.destination_tx_hashes.join(', ')}`);
      log('');
      return undefined;
    },
  };
}
