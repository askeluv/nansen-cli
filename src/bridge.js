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

import { CommandError, validateAddress } from './api.js';
import { signSecp256k1 } from './crypto.js';
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
import { extractActionErrors } from './hl-client.js';
import { resolveEvmWallet, resolveSigningCredentials } from './wallet-signing.js';
import { hashTypedData } from './x402-evm.js';

const QUOTE_TTL_MS = 3600000; // 1 hour

// Hyperliquid user-signed actions (here, Relay's `sendAsset` withdrawal leg) are
// signed under the HyperliquidSignTransaction domain, whose chainId must equal
// the action's own signatureChainId — HL, and the API's OFAC signer-recovery
// screening, both reconstruct the domain from that field to recover the signer.
// Use 0x66eee (421614), matching hl-action.js and the API's prepare endpoints, so
// the whole codebase agrees on one value. (The previous 0x1 / chainId-1 pair was
// internally consistent too, so it recovered the correct signer — this is
// codebase consistency, not the withdrawal bug. That bug was a discarded HL error
// response; see assertHyperliquidStepAccepted.)
const HL_SIGNATURE_CHAIN_ID = '0x66eee';

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

export function formatBridgeRoutes() {
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

// Fail loudly on a Hyperliquid rejection instead of printing "Submitted".
//
// The /perp/bridge/execute proxy returns { success, data } where `data` is the
// upstream response verbatim; for the HL leg that is HL's { status, response }
// envelope. HL signals failure two ways that BOTH come back as HTTP 200, so the
// proxy forwards them without flagging (it only raises on HTTP errors):
//   1. top-level status "err" (response is the reason string), and
//   2. status "ok" with per-action errors in response.data.statuses[].error.
// Left uninspected — as it was — a rejected withdrawal printed "Submitted" and
// then polled to a 600s timeout with no reason. Mirrors the direct-path
// checks in hl-client.js::submitExchange.
function assertHyperliquidStepAccepted(result, stepId) {
  const envelope = result?.data ?? result;
  if (!envelope || typeof envelope !== 'object') return;
  if (envelope.status === 'err') {
    const reason =
      typeof envelope.response === 'string'
        ? envelope.response
        : JSON.stringify(envelope.response);
    throw new CommandError(
      `Hyperliquid rejected bridge step "${stepId}": ${reason}`,
      'HL_ACTION_REJECTED',
    );
  }
  const actionResults = extractActionErrors(envelope.response);
  if (actionResults.failed.length > 0 && actionResults.succeeded.length > 0) {
    throw new CommandError(
      `Hyperliquid partially filled bridge step "${stepId}": succeeded ${actionResults.succeeded.join(', ')}; failed ${actionResults.failed.map(({ leg, error }) => `${leg}: ${error}`).join('; ')}`,
      'PARTIAL_FILL',
    );
  }
  if (actionResults.failed.length > 0) {
    throw new CommandError(
      `Hyperliquid rejected bridge step "${stepId}": ${actionResults.failed.map(({ error }) => error).join('; ')}`,
      'HL_ACTION_REJECTED',
    );
  }
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

function saveBridgeQuote(response, originChain, destinationChain, walletProvider, walletAddress, recipient, requestedAmountBaseUnits) {
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
    recipient,
    requestedAmountBaseUnits,
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
// through. Shared by signEip712Local (right before hashing), the Privy path
// (right before delegating to ethSignTypedDataV4), and the preflight pass
// (before any step signs at all).
function assertEip712TypeListNonEmpty(types, primaryType, context) {
  if ((types?.[primaryType] || []).length === 0) {
    throw new CommandError(
      `${context} is missing its EIP-712 type definition for "${primaryType}", so the signature would not cover the action. Refusing to sign.`,
      'UNEXPECTED_ACTION',
    );
  }
}

function signEip712Local(typedData, privateKeyHex, context = 'EIP-712 payload') {
  const { domain, types, primaryType, message } = typedData;
  assertEip712TypeListNonEmpty(types, primaryType, context);
  const fields = (types?.[primaryType] || []).map(f => ({ name: f.name, type: f.type }));
  const msgHash = hashTypedData(domain, primaryType, fields, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  return '0x' + r.toString('hex') + s.toString('hex') + (27 + v).toString(16).padStart(2, '0');
}

// Hyperliquid action types this bridge path is designed to produce and sign. The
// server supplies the action; we refuse to sign anything outside this set so a
// tampered response can't swap the intended withdrawal for a different
// fund-moving action whose fields we don't validate. Confirmed from real quotes
// across every supported withdrawal route (HL -> base/ethereum/arbitrum).
const ALLOWED_HL_BRIDGE_ACTION_TYPES = new Set(['sendAsset']);

// Hyperliquid's on-chain identifier for spot USDC — the only source token this
// bridge path can ever legitimately request (resolveBridgeTokenDecimals never
// resolves any other HL-origin token). Confirmed identical across all three
// captured withdrawal routes (HL -> base/ethereum/arbitrum): it names the
// SOURCE token, which does not vary by destination.
const HYPERLIQUID_BRIDGE_USDC_TOKEN_ID = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';

// The relayer authorize step signs a "NonceMapping" typed-data payload whose
// domain/types/primaryType/value ALL come from the server response — unlike
// the deposit action, nothing about this one is pinned client-side. Left
// unchecked, a malicious response could ask the wallet to sign a COMPLETELY
// different EIP-712 message — a different protocol's Permit or approval,
// anything with a non-empty type list — and relay the resulting signature to
// an endpoint of its choosing. Pin the exact shape (domain fields, and field
// name+type+ORDER — order affects the EIP-712 struct hash) so this can only
// ever produce a signature over a genuine NonceMapping. Captured from a real
// read-only `bridge quote` response (2026-08-28) — the exact domain
// (RelayNonceMapping, not the plainer "Relay" name used elsewhere in this
// file's comments/URLs) and field types (wallet/depositor are `address`, not
// `string`; id is `bytes32`; nonce is `uint256`) only became visible once
// captured directly — treat this as the source of truth over guesses.
const RELAY_AUTHORIZE_PRIMARY_TYPE = 'NonceMapping';
const RELAY_AUTHORIZE_DOMAIN = {
  name: 'RelayNonceMapping',
  version: '2',
  chainId: 1,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};
const RELAY_AUTHORIZE_FIELDS = [
  { name: 'chainId', type: 'string' },
  { name: 'wallet', type: 'address' },
  { name: 'depositor', type: 'address' },
  { name: 'id', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
];

// The exact (relative) endpoint the authorize signature is POSTed to. Pinned
// literally rather than merely host-allowlisted: the target URL is always
// built from this constant, never from the server-supplied `post.endpoint`,
// so there is nothing left for a malicious response to redirect.
const RELAY_AUTHORIZE_ENDPOINT_PATH = '/authorize';
const RELAY_AUTHORIZE_BASE_URL = 'https://api.relay.link';

// Parse a non-negative decimal string ("2", "2.000000", "1.97859") to an integer
// scaled by `decimals`, via digit slicing (never parseFloat) so it is exact.
export function decimalToScaled(raw, decimals = 8) {
  const s = String(raw).trim();
  if (!/^\d*\.?\d+$/.test(s)) {
    throw new CommandError(`Cannot parse amount "${raw}". Request a new quote.`, 'INVALID_INPUT');
  }
  const [int, frac = ''] = s.split('.');
  const scaledFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(int || '0') * 10n ** BigInt(decimals) + BigInt(scaledFrac);
}

// Bind a server-supplied Hyperliquid bridge ACTION to the user's intent before
// signing. The pinned EIP-712 domain only proves this is *a* Hyperliquid
// action; it says nothing about what the action does. Static only, no RPC.
//
// NOTE ON DESTINATION: in the relayer-mediated flow, action.destination is the
// RELAYER's deposit address, not the user's — so it is deliberately NOT bound to
// the recipient (doing so would reject every legitimate withdrawal). The final
// payout recipient is held off-chain by the relayer and is not in anything we
// sign; the amount cap below is what bounds the loss.
//
// Every check below fails CLOSED (throws) rather than silently skipping when
// its anchor is missing. An earlier version skipped the amount cap whenever
// the server's response omitted the field it compared against — which let a
// malicious response null out just that one field to strip the cap while
// still passing every other check. The anchors here are never legitimately
// absent, so a missing one is itself a signal to refuse.
//
// intent.reviewedAmountBaseUnits — the amount the CLIENT persisted at quote
//                         time from the user's own --amount (HL USDC is
//                         8-decimal base units). Anchored to client-recorded
//                         intent, not a server-supplied display field, so it
//                         can't be nulled out by a tampered response. Cap
//                         anchor for the amount leaving HL.
// intent.hlNetwork      — 'Mainnet' (what the exchange POST targets).
export function assertHlBridgeActionIntent(action, intent, context = 'Bridge action') {
  if (!action || typeof action !== 'object') {
    throw new CommandError(`${context}: no action to verify. Request a new quote.`, 'INVALID_INPUT');
  }
  // A. type allowlist
  if (!ALLOWED_HL_BRIDGE_ACTION_TYPES.has(action.type)) {
    throw new CommandError(
      `${context} has an unexpected action type "${action.type}". Refusing to sign. Request a new quote.`,
      'UNEXPECTED_ACTION',
    );
  }
  // C. network
  const net = action.hyperliquidChain ?? action.parameters?.hyperliquidChain;
  if (net == null || net !== intent.hlNetwork) {
    throw new CommandError(
      `${context} targets Hyperliquid "${net}", expected "${intent.hlNetwork}". Refusing to sign.`,
      'UNEXPECTED_NETWORK',
    );
  }
  // B. amount cap — required, not optional. sendAsset's entire purpose is
  // moving a nonzero amount; an action.type we allowlisted but with no amount
  // to check is not a smaller withdrawal, it is a signal something is wrong
  // with the response, so refuse rather than let it through unchecked.
  const signed = action.amount ?? action.parameters?.amount;
  if (signed == null) {
    throw new CommandError(
      `${context} has no amount to verify. Refusing to sign. Request a new quote.`,
      'AMOUNT_MISMATCH',
    );
  }
  if (intent.reviewedAmountBaseUnits == null) {
    // Expected for a quote saved by an older CLI version before this field
    // existed, not a sign of a bad response — but it can't be verified, so
    // still refuse. Name the likely cause so it doesn't read as a bug.
    throw new CommandError(
      `${context}: no reviewed amount recorded to check ${signed} against (this quote may predate a nansen-cli update). `
        + `Refusing to sign. Request a new quote.`,
      'AMOUNT_MISMATCH',
    );
  }
  // decimalToScaled's default (8) matches Hyperliquid USDC's native decimals,
  // the same scale reviewedAmountBaseUnits is already expressed in.
  const signedScaled = decimalToScaled(signed);
  const reviewedScaled = BigInt(intent.reviewedAmountBaseUnits);
  // +1n is a fixed 1-base-unit slack (0.00000001 USDC) absorbing rounding when
  // the server's 6-dp `amount` string is compared against the 8-dp reviewed
  // value. It is one-sided, so the most it ever permits is over-signing by a
  // single base unit — economically nothing. This is a rounding margin, NOT a
  // user-tunable tolerance: do not widen it.
  if (signedScaled > reviewedScaled + 1n) {
    throw new CommandError(
      `${context} would send ${signed}, more than the ${intent.reviewedAmountBaseUnits} base units you requested. `
        + `Refusing to sign. Request a new quote.`,
      'AMOUNT_MISMATCH',
    );
  }
  // F. token / source fields. Only USDC is ever a legitimate HL-origin source
  // token, and every captured route used empty dex/sub-account fields (no
  // dex-sourced or sub-account withdrawals are supported) — so anything else
  // is off the only shape this bridge path is designed to produce.
  const token = action.token ?? action.parameters?.token;
  if (token !== HYPERLIQUID_BRIDGE_USDC_TOKEN_ID) {
    throw new CommandError(
      `${context} names an unexpected source token "${token}". Refusing to sign. Request a new quote.`,
      'UNEXPECTED_ACTION',
    );
  }
  for (const key of ['sourceDex', 'destinationDex', 'fromSubAccount']) {
    const v = action[key] ?? action.parameters?.[key];
    if (v !== '') {
      throw new CommandError(
        `${context} has an unexpected ${key} "${v}" (expected empty). Refusing to sign. Request a new quote.`,
        'UNEXPECTED_ACTION',
      );
    }
  }
}

// Bind the relayer NonceMapping authorize payload (the FULL EIP-712 sign
// object — domain, types, primaryType, value — not just its value fields) to
// the user's intent before signing. See the constants above for why every
// part of the shape needs pinning: nothing about this payload is fixed
// client-side otherwise.
export function assertHlBridgeAuthorizeIntent(sign, signerAddress, context = 'Bridge authorize') {
  if (!sign || typeof sign !== 'object') {
    throw new CommandError(`${context}: no authorize payload to verify. Request a new quote.`, 'INVALID_INPUT');
  }
  if (sign.primaryType !== RELAY_AUTHORIZE_PRIMARY_TYPE) {
    throw new CommandError(
      `${context} has an unexpected EIP-712 type "${sign.primaryType}". Refusing to sign. Request a new quote.`,
      'UNEXPECTED_ACTION',
    );
  }
  const domain = sign.domain || {};
  const domainMatches = domain.name === RELAY_AUTHORIZE_DOMAIN.name
    && domain.version === RELAY_AUTHORIZE_DOMAIN.version
    && domain.chainId === RELAY_AUTHORIZE_DOMAIN.chainId
    && String(domain.verifyingContract ?? '').toLowerCase() === RELAY_AUTHORIZE_DOMAIN.verifyingContract.toLowerCase();
  if (!domainMatches) {
    throw new CommandError(
      `${context} has an unexpected signing domain ${JSON.stringify(domain)}. Refusing to sign. Request a new quote.`,
      'UNEXPECTED_ACTION',
    );
  }
  // Exact, ORDERED name+type comparison — field order affects the EIP-712
  // struct hash, so a reordering is a different (if superficially similar)
  // message, not a cosmetic difference.
  const fields = sign.types?.[sign.primaryType] || [];
  const fieldsMatch = fields.length === RELAY_AUTHORIZE_FIELDS.length
    && fields.every((f, i) => f?.name === RELAY_AUTHORIZE_FIELDS[i].name && f?.type === RELAY_AUTHORIZE_FIELDS[i].type);
  if (!fieldsMatch) {
    throw new CommandError(
      `${context} has an unexpected field set for "${RELAY_AUTHORIZE_PRIMARY_TYPE}". Refusing to sign. Request a new quote.`,
      'UNEXPECTED_ACTION',
    );
  }
  const value = sign.value || {};
  if (value.chainId !== 'hyperliquid') {
    throw new CommandError(
      `${context} targets chain "${value.chainId}", expected "hyperliquid". Refusing to sign.`,
      'UNEXPECTED_NETWORK',
    );
  }
  for (const key of ['wallet', 'depositor']) {
    const v = value[key];
    if (!v || String(v).toLowerCase() !== String(signerAddress).toLowerCase()) {
      throw new CommandError(
        `${context} names ${key} ${v}, but the signing wallet is ${signerAddress}. `
          + `Refusing to sign. Request a new quote.`,
        'SIGNER_MISMATCH',
      );
    }
  }
}

// Resolve the relayer POST target. The target URL is always built from
// RELAY_AUTHORIZE_BASE_URL + RELAY_AUTHORIZE_ENDPOINT_PATH — never from the
// server-supplied `post.endpoint` — so a malicious response has nothing to
// redirect: it can, at most, cause this to refuse by not matching the one
// endpoint this bridge path is designed to POST to.
function resolveRelayTargetUrl(endpoint, context = 'Bridge step') {
  if (endpoint !== RELAY_AUTHORIZE_ENDPOINT_PATH) {
    throw new CommandError(
      `${context} has an unexpected authorize endpoint "${endpoint}". Refusing to sign. Request a new quote.`,
      'UNEXPECTED_ACTION',
    );
  }
  return `${RELAY_AUTHORIZE_BASE_URL}${RELAY_AUTHORIZE_ENDPOINT_PATH}`;
}

// Build the exact same action object that gets signed AND submitted for a HL
// action step (see processSignatureStepLocal for why: one object rules out
// signed-vs-submitted drift).
function buildHlBridgeAction(signData) {
  return {
    ...(signData.action.parameters || signData.action),
    type: signData.action.type,
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
  };
}

// Validate every signature step against user intent BEFORE any step is
// signed or posted. Steps run in server-supplied order — the captured shape
// is [authorize, sendAsset] — so without this preflight, an earlier step
// would already be signed and POSTed by the time a bad LATER step (either
// leg — a mistargeted authorize endpoint or an under-specified action) is
// reached and rejected. Covers every check that would otherwise gate signing
// at that step's own point of use — the intent binding, the authorize
// endpoint pin, and the EIP-712 type-list guard — so this is a strict
// superset of the per-step processors' checks, run up front across the whole
// plan first.
function preflightHlBridgeSteps(steps, intent) {
  for (const step of steps) {
    for (const item of step.items || []) {
      const { data: signData } = item;
      if (signData.sign) {
        assertHlBridgeAuthorizeIntent(signData.sign, intent.signerAddress, `Bridge step "${step.id}"`);
        resolveRelayTargetUrl(signData.post?.endpoint, `Bridge step "${step.id}"`);
        assertEip712TypeListNonEmpty(signData.sign.types, signData.sign.primaryType, `Bridge step "${step.id}"`);
      } else if (signData.action) {
        assertHlBridgeActionIntent(buildHlBridgeAction(signData), intent, `Bridge step "${step.id}"`);
        const primaryType = signData.eip712PrimaryType || 'HyperliquidTransaction';
        assertEip712TypeListNonEmpty(signData.eip712Types || {}, primaryType, `Bridge step "${step.id}"`);
      }
    }
  }
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

// Parse a --priority-fee / --max-fee override. Given in gwei, because that is
// the unit every fee tracker and block explorer quotes; returned in wei.
//
// Converted digit-wise rather than by multiplying a float, so 0.05 gwei is
// exactly 50000000 wei and not whatever the binary representation rounds to.
export function parseGweiToWei(raw, name) {
  const s = String(raw).trim();
  if (!/^\d*\.?\d+$/.test(s)) {
    throw new CommandError(
      `Invalid --${name} "${raw}". Give a fee in gwei (e.g. 0.05).`,
      'INVALID_INPUT',
    );
  }
  const [int, frac = ''] = s.split('.');
  const wei = BigInt(int || '0') * 1000000000n + BigInt((frac + '000000000').slice(0, 9));
  if (wei <= 0n) {
    throw new CommandError(`Invalid --${name} "${raw}". Must be greater than zero.`, 'INVALID_INPUT');
  }
  return wei;
}

// Decide the fee fields for an EVM bridge step.
//
// Relay's quote already carries maxFeePerGas/maxPriorityFeePerGas, which this
// used to discard in favour of a bare eth_gasPrice reading — producing a legacy
// transaction priced at roughly the current base fee with almost no priority
// fee. Keep Relay's intent, but raise the priority fee to something Base will
// actually schedule and lift the cap to cover it plus base-fee movement.
//
// `overrides` are the operator's explicit --priority-fee/--max-fee, in wei. They
// win outright, including over MIN_PRIORITY_FEE_WEI: their whole purpose is
// outbidding a transaction that is already stuck, which the computed values
// cannot do — they reproduce the same numbers that got stuck in the first place,
// and a replacement needs roughly +10% to be accepted at all.
export async function resolveEvmStepFees(chain, txData, overrides = {}) {
  const { priorityFeeWei = null, maxFeeWei = null } = overrides;

  if (txData.maxFeePerGas || priorityFeeWei || maxFeeWei) {
    let maxPriorityFeePerGas = priorityFeeWei ?? BigInt(txData.maxPriorityFeePerGas ?? 0);
    if (!priorityFeeWei && maxPriorityFeePerGas < MIN_PRIORITY_FEE_WEI) {
      maxPriorityFeePerGas = MIN_PRIORITY_FEE_WEI;
    }

    // The cap must cover the raised priority fee, or the transaction is
    // self-contradictory: maxFeePerGas < maxPriorityFeePerGas is rejected
    // outright by every node.
    if (maxFeeWei) {
      if (maxFeeWei < maxPriorityFeePerGas) {
        throw new CommandError(
          `--max-fee is below --priority-fee (${maxFeeWei} wei < ${maxPriorityFeePerGas} wei); no node accepts that. Raise --max-fee.`,
          'INVALID_INPUT',
        );
      }
      return {
        maxFeePerGas: maxFeeWei.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      };
    }

    let maxFeePerGas = BigInt(txData.maxFeePerGas ?? 0);
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

async function processEvmStep(step, { chain, privateKeyHex, signerAddress, log, onBroadcast, feeOverrides, nonceSequence }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const txData = item.data;

    // The nonce is fetched for txData.from, but the transaction is signed with
    // our key — so a server-returned `from` that isn't our wallet would price
    // the nonce against the wrong account and sign anyway. Assert it matches the
    // signer before touching the nonce.
    if (
      signerAddress
      && txData.from
      && String(txData.from).toLowerCase() !== String(signerAddress).toLowerCase()
    ) {
      throw new CommandError(
        `Bridge step "${step.id}" is addressed from ${txData.from}, but the signing wallet is ${signerAddress}. Request a new quote.`,
        'SIGNER_MISMATCH',
      );
    }

    const fees = await resolveEvmStepFees(chain, txData, feeOverrides);
    // getEvmNonce returns a decimal number and reconciles pending against the
    // mined count. An explicit --nonce skips both: it is how an operator
    // deliberately re-signs at the nonce of a stuck transaction to replace it,
    // which is exactly the case the reconciliation refuses.
    // Fetch the nonce for the signing wallet, not the server-returned `from`.
    // The transaction is signed with our local key regardless of `from`, so its
    // nonce must come from that account — and this stays correct even if a quote
    // omits `from` (which would otherwise resolve a nonce for `undefined`).
    const nonce = nonceSequence
      ? nonceSequence.next++
      : await getEvmNonce(chain, signerAddress);
    if (nonceSequence) log(`  Nonce: ${nonce} (from --nonce)`);

    const signedTx = signEvmTransaction(
      { ...txData, ...fees },
      privateKeyHex,
      chain,
      nonce,
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

async function processSignatureStepLocal(step, { privateKeyHex, log, apiInstance, onBroadcast, intent }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const { data: signData } = item;

    if (signData.sign) {
      assertHlBridgeAuthorizeIntent(signData.sign, intent.signerAddress, `Bridge step "${step.id}"`);
      let targetUrl = resolveRelayTargetUrl(signData.post?.endpoint, `Bridge step "${step.id}"`);
      const typedData = {
        domain: signData.sign.domain,
        types: signData.sign.types,
        primaryType: signData.sign.primaryType,
        message: signData.sign.value,
      };
      const signature = signEip712Local(typedData, privateKeyHex, `Bridge step "${step.id}"`);

      const postBody = { ...signData.post.body };

      // Coupled to the same constant resolveRelayTargetUrl validates against
      // (not a hardcoded substring), so the two can't silently drift apart if
      // that constant ever changes.
      if (targetUrl.endsWith(RELAY_AUTHORIZE_ENDPOINT_PATH)) {
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
        chainId: parseInt(HL_SIGNATURE_CHAIN_ID, 16),
        verifyingContract: '0x0000000000000000000000000000000000000000',
      };
      const types = signData.eip712Types || {};
      const primaryType = signData.eip712PrimaryType || 'HyperliquidTransaction';
      // Sign and submit the SAME action object (matching the perp path in
      // perp.js/hl-action.js). The extra `type`/`signatureChainId` keys are not in
      // the EIP-712 type list so they don't affect the hash, but building one
      // object rules out any signed-vs-submitted drift.
      const action = buildHlBridgeAction(signData);
      assertHlBridgeActionIntent(action, intent, `Bridge step "${step.id}"`);

      const typedData = { domain, types, primaryType, message: action };
      const signature = signEip712Local(typedData, privateKeyHex, `Bridge step "${step.id}"`);
      const [rHex, sHex, vHex] = [signature.slice(2, 66), signature.slice(66, 130), signature.slice(130, 132)];

      // vaultAddress omitted (not null): HL only expects it for vault trades, and
      // the SDK/submitExchange serialize a normal-wallet action without it.
      const hlBody = {
        action,
        nonce: signData.nonce,
        signature: { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) },
      };

      log(`  Signing ${step.id} (Hyperliquid deposit)...`);
      const result = await postBridgeExecute(apiInstance, 'https://api.hyperliquid.xyz/exchange', hlBody);
      assertHyperliquidStepAccepted(result, step.id);
      onBroadcast?.(step.id, null);
      log(`  Submitted to api.hyperliquid.xyz`);
    }
  }
}

async function processSignatureStepPrivy(step, { privyClient, walletId, log, apiInstance, onBroadcast, intent }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const { data: signData } = item;

    let typedData;
    // For the HL action leg, the exact object that is signed is also the object
    // submitted (see the local path for why); hold onto it for the submit below.
    let hlAction = null;
    // For the authorize leg, resolved up front (before signing) so a bad
    // target refuses without ever calling out to Privy.
    let targetUrl = null;
    if (signData.sign) {
      assertHlBridgeAuthorizeIntent(signData.sign, intent.signerAddress, `Bridge step "${step.id}"`);
      targetUrl = resolveRelayTargetUrl(signData.post?.endpoint, `Bridge step "${step.id}"`);
      typedData = {
        domain: signData.sign.domain,
        types: signData.sign.types,
        primaryType: signData.sign.primaryType,
        message: signData.sign.value,
      };
    } else if (signData.action) {
      hlAction = buildHlBridgeAction(signData);
      assertHlBridgeActionIntent(hlAction, intent, `Bridge step "${step.id}"`);
      typedData = {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: parseInt(HL_SIGNATURE_CHAIN_ID, 16),
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: signData.eip712Types || {},
        primaryType: signData.eip712PrimaryType || 'HyperliquidTransaction',
        message: hlAction,
      };
    } else {
      throw new Error(`Unexpected signature step format for ${step.id}`);
    }

    // Same guard the local path gets in signEip712Local. Refuse rather than
    // delegate the check to Privy.
    assertEip712TypeListNonEmpty(typedData.types, typedData.primaryType, `Bridge step "${step.id}"`);

    log(`  Signing ${step.id} via Privy...`);
    const result = await privyClient.ethSignTypedDataV4(walletId, typedData);
    const signature = result.data?.signature || result.signature || result;

    if (signData.sign) {
      const postBody = { ...signData.post.body };
      // Coupled to the same constant resolveRelayTargetUrl validates against
      // (not a hardcoded substring), so the two can't silently drift apart if
      // that constant ever changes.
      if (targetUrl.endsWith(RELAY_AUTHORIZE_ENDPOINT_PATH)) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${sep}signature=${signature}`;
      } else {
        postBody.signature = signature;
      }
      await postBridgeExecute(apiInstance, targetUrl, postBody);
      onBroadcast?.(step.id, null);
    } else {
      const [rHex, sHex, vHex] = [signature.slice(2, 66), signature.slice(66, 130), signature.slice(130, 132)];
      const hlBody = {
        action: hlAction,
        nonce: signData.nonce,
        signature: { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) },
      };
      const result = await postBridgeExecute(apiInstance, 'https://api.hyperliquid.xyz/exchange', hlBody);
      assertHyperliquidStepAccepted(result, step.id);
      onBroadcast?.(step.id, null);
    }
    log(`  Submitted`);
  }
}

// ── Status polling ───────────────────────────────────────────────────

// A not_found means the relayer has no record of the transfer yet — normal for a
// few seconds while it indexes, but terminal if it persists (an unknown/malformed
// handle, or a source tx that never landed). Tolerate it for this bounded window,
// then treat it as terminal instead of polling "pending" to the full timeout.
const NOT_FOUND_GRACE_MS = 60000;

async function pollBridgeCompletion(apiInstance, { requestId, txHash, timeoutMs = 600000, pollMs = 10000, log = console.log }) {
  const start = Date.now();
  let notFoundSince = null;
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
      if (status.status === 'not_found') {
        notFoundSince ??= Date.now();
        if (Date.now() - notFoundSince >= NOT_FOUND_GRACE_MS) {
          throw Object.assign(
            new Error(
              `Bridge not found: the relayer has no record of this transfer after ${NOT_FOUND_GRACE_MS / 1000}s. `
              + 'The source transaction likely never landed, or the handle is wrong.',
            ),
            { code: 'BRIDGE_NOT_FOUND', details: status },
          );
        }
      } else {
        // Any real status (including pending) clears the not_found streak.
        notFoundSince = null;
      }
    } catch (err) {
      if (err.code === 'BRIDGE_FAILED' || err.code === 'BRIDGE_NOT_FOUND') throw err;
      // Say what went wrong. A silent "poll error" hides the difference between
      // a transient 502 (worth waiting out) and a 401 or a bad request id, which
      // will still be failing when the timeout arrives ten minutes later.
      log(`  Bridge: poll error — ${err.message} (retrying...)`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  // Name whichever handle the caller actually gave us. Interpolating a missing
  // request_id produced "--request-id undefined", a command that cannot work.
  const followUp = requestId
    ? `nansen bridge status --request-id ${requestId}`
    : txHash
      ? `nansen bridge status --tx-hash ${txHash}`
      : 'nansen bridge status --tx-hash <source tx hash>';
  throw Object.assign(
    new Error(`Bridge polling timed out after ${timeoutMs / 1000}s. Check manually: ${followUp}`),
    { code: 'BRIDGE_TIMEOUT' },
  );
}

// ── Wallet helpers ───────────────────────────────────────────────────

// Every route here has an EVM address on at least one side (Hyperliquid uses EVM
// addresses too), and both legs sign with the EVM key — so a wallet without a
// valid EVM address can't bridge at all. This used to pass `wallet.evm`
// through unchecked, so a Solana-only wallet reached the API as
// `wallet_address: null` and came back a 422.
function resolveWalletAddress(walletName) {
  return resolveEvmWallet(walletName, 'Bridging');
}

// Destination address for --recipient. Validated against the EVM pattern rather
// than the destination chain's own rules: every supported destination
// (base/ethereum/arbitrum/hyperliquid) takes an EVM address, and passing
// 'hyperliquid' to validateAddress would fall through its unknown-chain branch
// and accept anything.
function assertRecipient(recipient) {
  const { valid, error } = validateAddress(recipient, 'ethereum');
  if (!valid) {
    throw new CommandError(`Invalid --recipient "${recipient}". ${error}`, 'INVALID_ADDRESS');
  }
}

// --amount is a base-unit integer by default, or a positive decimal with
// --amount-unit. Checked client-side because the two failure modes are both
// quiet: a decimal in base units is a units mix-up (5.5 meaning 5.5 USDC would
// bridge 5 base units, i.e. 0.000005 USDC), and trailing garbage would reach
// convertToBaseUnits rather than being rejected.
function parseBridgeAmount(raw, amountUnit) {
  const s = String(raw).trim();
  if (amountUnit === undefined) {
    if (!/^\d+$/.test(s) || BigInt(s) <= 0n) {
      throw new CommandError(
        `Invalid --amount "${raw}". Base units must be a positive whole number (USDC is 6 decimals on EVM chains, 8 on Hyperliquid). Pass --amount-unit token to use a human amount instead.`,
        'INVALID_INPUT',
      );
    }
    return s;
  }
  if (!/^\d*\.?\d+$/.test(s) || !(parseFloat(s) > 0)) {
    throw new CommandError(
      `Invalid --amount "${raw}". Must be a positive number when --amount-unit is ${amountUnit}.`,
      'INVALID_INPUT',
    );
  }
  return s;
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

      if (recipient !== undefined) assertRecipient(recipient);
      const amountInput = parseBridgeAmount(amount, amountUnit);

      const originToken = resolveBridgeToken(fromTokenRaw, originChain);
      const destinationToken = toTokenRaw
        ? resolveBridgeToken(toTokenRaw, destinationChain)
        : resolveBridgeToken('USDC', destinationChain);

      const wallet = resolveWalletAddress(walletName);

      // Default: --amount is base units. With --amount-unit, accept a human token
      // or USD amount and convert client-side using the source token's decimals.
      let resolvedAmount = amountInput;
      if (amountUnit === 'token' || amountUnit === 'usd') {
        try {
          const decimals = await resolveBridgeTokenDecimals(originToken, originChain);
          let humanAmount = amountInput;
          if (amountUnit === 'usd') {
            // USDC is USD-pegged ($1), so skip the price lookup — and Hyperliquid's
            // USDC uses a sentinel address the price API can't resolve, which would
            // otherwise make `--amount-unit usd` unusable from HL. Non-stable tokens
            // still fetch a live price.
            const price = isBridgeUsdc(originToken, originChain)
              ? 1
              : await resolveUsdPrice(apiInstance, originToken, originChain);
            humanAmount = (parseFloat(amountInput) / price).toFixed(decimals);
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

      const quoteId = saveBridgeQuote(
        result,
        originChain,
        destinationChain,
        wallet.provider,
        wallet.address,
        recipient,
        resolvedAmount,
      );
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

Execute a cached bridge quote. Signs transactions and broadcasts them.

RECOVERY OPTIONS (EVM deposit legs only):
  --priority-fee  Priority fee in gwei, overriding the quoted one
  --max-fee       Fee cap in gwei, overriding the computed one
  --nonce         Sign at this nonce instead of the next one

Use these to replace a transaction that is stuck in the mempool: a replacement
must reuse the stuck nonce and outbid it (roughly +10%), and the fees computed
from a quote are the same ones that got stuck. Check the stuck nonce with
"nansen wallet balance" or an explorer, then:

  nansen bridge execute --quote <new quoteId> --nonce <stuck nonce> --priority-fee 0.05`,
          'MISSING_PARAM',
        );
      }

      // Fee/nonce overrides. Parsed before the quote is touched so a typo can't
      // consume it, and only applied to EVM legs — an HL withdrawal signs an
      // action with no fee fields at all.
      const feeOverrides = {
        priorityFeeWei: options['priority-fee'] !== undefined
          ? parseGweiToWei(options['priority-fee'], 'priority-fee')
          : null,
        maxFeeWei: options['max-fee'] !== undefined
          ? parseGweiToWei(options['max-fee'], 'max-fee')
          : null,
      };
      let nonceSequence = null;
      if (options.nonce !== undefined) {
        const s = String(options.nonce).trim();
        if (!/^\d+$/.test(s)) {
          throw new CommandError(
            `Invalid --nonce "${options.nonce}". Must be a non-negative whole number.`,
            'INVALID_INPUT',
          );
        }
        // A multi-step quote (approve then deposit) signs consecutive nonces, so
        // this is a starting point rather than a single value.
        nonceSequence = { next: parseInt(s, 10) };
      }

      const quoteData = loadBridgeQuote(quoteId);
      // A truncated or hand-edited quote file can be missing `response.steps`
      // entirely; guard before destructuring so the operator gets an actionable
      // message rather than a raw TypeError on `steps.length` below.
      if (!Array.isArray(quoteData.response?.steps)) {
        throw new CommandError(
          `Quote "${quoteId}" is malformed: no executable steps found. Request a fresh quote with "nansen bridge quote".`,
          'INVALID_INPUT',
        );
      }
      const { execution_type, steps, request_id } = quoteData.response;
      const { recipient } = quoteData;

      // The overrides only mean something for an EVM broadcast. A withdrawal
      // signs a Hyperliquid action with no fee or nonce fields, so there is
      // nothing to apply them to — refuse rather than ignore them, since the
      // operator passed them expecting a different outcome.
      if (
        execution_type !== 'evm_transaction'
        && (feeOverrides.priorityFeeWei || feeOverrides.maxFeeWei || nonceSequence)
      ) {
        throw new CommandError(
          `--priority-fee/--max-fee/--nonce apply only to EVM deposit legs, but quote "${quoteId}" is a ${execution_type} leg with no on-chain transaction to price.`,
          'INVALID_INPUT',
        );
      }

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

      // Re-screen the signer and any distinct recipient immediately before
      // signing. Quotes live up to an hour, and the EVM leg broadcasts directly.
      const screenAddresses = recipient
        && String(recipient).toLowerCase() !== String(signer.address).toLowerCase()
        ? [signer.address, recipient]
        : [signer.address];
      await screenOrThrow(apiInstance, screenAddresses);

      // Signing material for the wallet resolved above — not a second lookup.
      // Resolving twice re-read the wallet file and, worse, could pick a
      // different wallet than the one just screened if the default changed in
      // between.
      const creds = resolveSigningCredentials(signer);

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
        // Overrides move real money differently from what was quoted, so say so
        // rather than letting them apply silently.
        if (feeOverrides.priorityFeeWei || feeOverrides.maxFeeWei || nonceSequence) {
          const parts = [];
          if (feeOverrides.priorityFeeWei) parts.push(`priority fee ${feeOverrides.priorityFeeWei} wei`);
          if (feeOverrides.maxFeeWei) parts.push(`fee cap ${feeOverrides.maxFeeWei} wei`);
          if (nonceSequence) parts.push(`starting nonce ${nonceSequence.next}`);
          log(`  Overrides: ${parts.join(', ')}`);
        }
        for (const [index, step] of steps.entries()) {
          await processEvmStep(step, {
            chain: quoteData.originChain,
            privateKeyHex: creds.privateKey,
            signerAddress: signer.address,
            log,
            onBroadcast,
            feeOverrides,
            nonceSequence,
          });
          markBroadcast(index);
        }
      } else if (execution_type === 'hyperliquid_signature') {
        // Check E: the quote's own currencyIn.amount — the amount it displayed
        // and will send through /perp/bridge/quote — must equal what was
        // actually requested at quote time. The amount cap below (check B) is
        // anchored to requestedAmountBaseUnits directly, not to this display
        // field, so this check is UI-consistency defense-in-depth: it catches a
        // quote whose displayed send amount has drifted from the request,
        // rather than gating the cap itself.
        const currencyIn = quoteData.response.details?.currencyIn;
        if (quoteData.requestedAmountBaseUnits != null && currencyIn?.amount != null) {
          let currencyInScaled, requestedScaled;
          try {
            currencyInScaled = BigInt(currencyIn.amount);
            requestedScaled = BigInt(quoteData.requestedAmountBaseUnits);
          } catch {
            throw new CommandError(
              `Quote input "${currencyIn.amount}" is not a valid amount. Request a new quote.`,
              'AMOUNT_MISMATCH',
            );
          }
          if (currencyInScaled !== requestedScaled) {
            throw new CommandError(
              `Quote input ${currencyIn.amount} does not match the requested ${quoteData.requestedAmountBaseUnits}. Request a new quote.`,
              'AMOUNT_MISMATCH',
            );
          }
        }
        const hlIntent = {
          // Anchored to what the CLIENT persisted at quote time from the
          // user's own --amount, not to any server-supplied display field —
          // see assertHlBridgeActionIntent for why.
          reviewedAmountBaseUnits: quoteData.requestedAmountBaseUnits ?? null,
          hlNetwork: 'Mainnet',
          signerAddress: signer.address,
        };
        // Validate every step's payload (both the authorize leg and the HL
        // action leg) before any of them are signed or posted — see
        // preflightHlBridgeSteps for why this can't just be the per-step
        // check the loops below already do.
        preflightHlBridgeSteps(steps, hlIntent);
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
              intent: hlIntent,
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
              intent: hlIntent,
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
      if (status.status === 'not_found') {
        log('  (relayer has no record of this transfer — an unknown/malformed handle, or');
        log('   a source tx that has not landed / is not yet indexed. Retry briefly, then');
        log('   treat as terminal.)');
      }
      if (status.raw_status) log(`  Raw:     ${status.raw_status}`);
      if (status.source_tx_hashes?.length) log(`  Source:  ${status.source_tx_hashes.join(', ')}`);
      if (status.destination_tx_hashes?.length) log(`  Dest:    ${status.destination_tx_hashes.join(', ')}`);
      log('');
      return undefined;
    },
  };
}
