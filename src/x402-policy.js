/**
 * x402 payment policy guard.
 * Decides whether an auto-payment is safe to sign before any signature is produced.
 * Three layers: known-asset allowlist, optional payTo allowlist, per-payment USD cap.
 */

import { EVM_X402_TOKENS, SVM_X402_TOKENS } from './x402-tokens.js';
import { getWalletConfig } from './wallet.js';

/**
 * True for the exact Solana CAIP-2 network prefix ("solana:..."), matching
 * isSvmNetwork() in x402-svm.js. Duplicated here (rather than imported) to
 * avoid a circular dependency: x402-svm.js imports resolvePaymentAmount from
 * this module.
 */
function isSvmNetworkString(network) {
  return typeof network === 'string' && network.startsWith('solana:');
}

/**
 * Look up the known token entry for a (network, asset) pair.
 * Returns { token, symbol, decimals } or null if the pair is not a known
 * Nansen x402 payment asset.
 *
 * EVM addresses are compared case-insensitively (hex is case-insensitive
 * modulo EIP-55 checksum casing). Solana mint addresses are base58 and
 * MUST be compared case-sensitively — flipping the case of a base58 string
 * decodes to different bytes entirely, not the same address in a different
 * checksum casing.
 */
export function resolveKnownToken(network, asset) {
  if (typeof network !== 'string' || typeof asset !== 'string') return null;
  if (network.startsWith('eip155:')) {
    const table = EVM_X402_TOKENS[network];
    if (!table) return null;
    return table.find(t => t.token.toLowerCase() === asset.toLowerCase()) || null;
  }
  if (isSvmNetworkString(network)) {
    const table = SVM_X402_TOKENS['solana'];
    if (!table) return null;
    return table.find(t => t.token === asset) || null;
  }
  return null;
}

// Default per-payment ceiling in USD. x402 API calls cost cents; $1.00 is a
// conservative safety ceiling — raise NANSEN_X402_MAX_AMOUNT if legitimate
// calls exceed it (they should not for normal API usage).
export const DEFAULT_X402_MAX_AMOUNT_USD = 1.0;

/**
 * Resolve the per-payment USD cap.
 * Precedence: NANSEN_X402_MAX_AMOUNT env var > wallet config x402MaxAmount > default.
 * Returns a positive number, or Infinity when explicitly set to "unlimited".
 */
export function resolveMaxAmountUsd() {
  const env = process.env.NANSEN_X402_MAX_AMOUNT;
  // An empty/whitespace-only value (e.g. an exported-but-unset shell var) must
  // be treated as unset, not as Number('') === 0 — a $0.00 cap would refuse
  // every real payment.
  if (env !== undefined && env.trim() !== '') {
    if (env.trim().toLowerCase() === 'unlimited') return Infinity;
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
    // fall through on garbage value
  }
  try {
    const cfg = getWalletConfig();
    if (cfg && cfg.x402MaxAmount !== undefined) {
      const n = Number(cfg.x402MaxAmount);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* no config yet */ }
  return DEFAULT_X402_MAX_AMOUNT_USD;
}

/**
 * Optional payTo allowlist.
 * If NANSEN_X402_ALLOWED_PAYTO is set (comma-separated addresses), only those
 * recipients may be paid. Unset = no recipient restriction.
 *
 * Comparison is case-insensitive for EVM (hex) but case-sensitive for Solana
 * (base58) — see resolveKnownToken for why. `network` is required to know
 * which rule applies; omit it only for EVM-style (case-insensitive) checks.
 */
export function isPayToAllowed(payTo, network) {
  const raw = process.env.NANSEN_X402_ALLOWED_PAYTO;
  if (!raw) return true;
  const caseSensitive = isSvmNetworkString(network);
  const normalize = (s) => (caseSensitive ? s.trim() : s.trim().toLowerCase());
  const allow = raw.split(',').map(normalize).filter(Boolean);
  if (allow.length === 0) return true;
  return typeof payTo === 'string' && allow.includes(normalize(payTo));
}

/**
 * Resolve the payment amount field, preferring `amount` over the legacy
 * `maxAmountRequired` alias (older x402 implementations only send the latter).
 * A present-but-empty `amount` (e.g. "") is treated as missing so it falls
 * through to `maxAmountRequired` here too — the one place this decision is
 * made. Signers must call this instead of re-deriving the fallback themselves;
 * a mismatched `??` vs `||` between here and a signer is exactly the
 * amount-substitution bypass this guard exists to prevent.
 */
export function resolvePaymentAmount(requirement) {
  const amount = requirement.amount;
  if (amount !== undefined && amount !== null && amount !== '') return amount;
  return requirement.maxAmountRequired;
}

/**
 * Resolve the payment recipient field, preferring `payTo` (camelCase) over
 * the legacy `pay_to` (snake_case) alias. A present-but-empty `payTo` (e.g.
 * "") is treated as missing, exactly like resolvePaymentAmount — the same
 * single-source-of-truth rule signers must use instead of re-deriving the
 * fallback themselves.
 */
export function resolvePayTo(requirement) {
  const payTo = requirement.payTo;
  if (payTo !== undefined && payTo !== null && payTo !== '') return payTo;
  return requirement.pay_to;
}

/**
 * Decide whether an x402 payment requirement is safe to auto-sign.
 * Returns { ok: true, usd, symbol } when allowed, or { ok: false, reason }
 * with a human-readable, actionable reason when refused.
 *
 * Enforces in order: known (network, asset) allowlist, optional payTo
 * allowlist, per-payment USD cap. Never signs; pure decision.
 */
export function evaluatePaymentRequirement(requirement) {
  const network = requirement.network;
  const asset = requirement.asset;
  const payTo = resolvePayTo(requirement);
  const amountRaw = resolvePaymentAmount(requirement);

  const known = resolveKnownToken(network, asset);
  if (!known) {
    return {
      ok: false,
      reason:
        `Refusing to auto-pay: asset ${asset} on ${network} is not a recognized ` +
        `Nansen payment token. No signature was produced.`,
    };
  }

  if (!isPayToAllowed(payTo, network)) {
    return {
      ok: false,
      reason: `Refusing to auto-pay: recipient ${payTo} is not in NANSEN_X402_ALLOWED_PAYTO.`,
    };
  }

  if (amountRaw === undefined || amountRaw === null) {
    return { ok: false, reason: 'Refusing to auto-pay: amount field is missing from the payment requirement.' };
  }

  let usd;
  try {
    // BigInt base units → USD. Keep integer/fraction split to avoid float loss
    // on large values; final Number() is safe for display-scale amounts.
    const base = BigInt(amountRaw);
    // A transfer authorization must be for a positive amount; a negative value
    // is never legitimate and should never be signed.
    if (base < 0n) {
      return { ok: false, reason: `Refusing to auto-pay: negative amount ${amountRaw}.` };
    }
    const scale = 10n ** BigInt(known.decimals);
    // Number arithmetic is precise enough for stablecoin amounts at 6 or 18
    // decimals against a dollar-scale cap. Would need BigInt-native comparison
    // if supported decimals or cap magnitudes change significantly.
    usd = Number(base / scale) + Number(base % scale) / Number(scale);
  } catch {
    return { ok: false, reason: `Refusing to auto-pay: unparseable amount ${amountRaw}.` };
  }

  // Cap is inclusive: an amount exactly at the cap is allowed (usd > cap, not >=).
  // Note a cap of 0 still permits a zero-value payment (0 > 0 is false); use
  // NANSEN_X402_ALLOWED_PAYTO or an unfunded wallet to block signing entirely.
  const cap = resolveMaxAmountUsd();
  if (usd > cap) {
    const capStr = Number.isFinite(cap) ? `$${cap.toFixed(2)}` : 'unlimited';
    return {
      ok: false,
      reason:
        `Refusing to auto-pay $${usd.toFixed(2)} ${known.symbol}: exceeds the ` +
        `${capStr} per-payment cap. To authorize, raise it with ` +
        `NANSEN_X402_MAX_AMOUNT=<usd> (or NANSEN_X402_MAX_AMOUNT=unlimited to disable).`,
    };
  }

  return { ok: true, usd, symbol: known.symbol };
}
