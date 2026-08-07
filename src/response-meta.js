/**
 * Request-id, credit, rate-limit, and notice metadata, read from Nansen API
 * response headers.
 *
 * The API reports what a call actually cost, what quota is left, and an id that
 * identifies the call end to end. Until now the CLI dropped those headers on the
 * floor and showed only the static per-endpoint estimate published in the
 * OpenAPI spec (see cost-cache.js), which is a quote rather than a charge.
 *
 * readResponseMeta(response) — parse the headers, or null if none are present
 * creditWarning(meta)        — stderr warning string when the balance is short, else null
 *
 * Every header is optional. Some auth rails charge no credits, some responses
 * are served before quota is resolved, and older deployments may send neither
 * the rate-limit triplet nor the request id — so a missing header means
 * "unknown", never zero.
 */

/** Header names, as documented in the API reference. */
const CREDITS_USED = 'x-nansen-credits-used';
const CREDITS_REMAINING = 'x-nansen-credits-remaining';
const CREDITS_COST = 'x-nansen-credits-cost';
const RATE_LIMIT = 'x-ratelimit-limit';
const RATE_REMAINING = 'x-ratelimit-remaining';
const RATE_RESET = 'x-ratelimit-reset';
const UPGRADE_HINT = 'x-nansen-upgrade-hint';
const PLAN_NOTICE = 'x-nansen-plan-notice';
const API_KEY_NOTICE = 'x-nansen-api-key-notice';
const REQUEST_ID = 'x-request-id';

/**
 * Read a header as a non-negative integer, or null when absent/unparseable.
 * Tolerates any header bag with a .get() — a real Headers, or a Map in tests.
 */
function intHeader(response, name) {
  const raw = stringHeader(response, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read a header as a trimmed non-empty string, or null when absent.
 * Tolerates any header bag with a .get() — a real Headers, or a Map in tests.
 */
function stringHeader(response, name) {
  const raw = response?.headers?.get?.(name);
  if (raw == null) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

/**
 * Extract request-id, credit, rate-limit, and notice metadata from a fetch Response.
 * Returns null when the response carries none of it, so callers can skip
 * attaching an object full of nulls.
 */
export function readResponseMeta(response) {
  const used = intHeader(response, CREDITS_USED);
  const remaining = intHeader(response, CREDITS_REMAINING);
  const cost = intHeader(response, CREDITS_COST);
  const limit = intHeader(response, RATE_LIMIT);
  const rateRemaining = intHeader(response, RATE_REMAINING);
  const resetSeconds = intHeader(response, RATE_RESET);
  const upgradeHint = stringHeader(response, UPGRADE_HINT);
  const planNotice = stringHeader(response, PLAN_NOTICE);
  const apiKeyNotice = stringHeader(response, API_KEY_NOTICE);
  const requestId = stringHeader(response, REQUEST_ID);

  const meta = {};
  if (requestId !== null) {
    // The single value that identifies this call to Nansen support. Opaque —
    // never parse it or assume a format.
    meta.requestId = requestId;
  }
  if (used !== null || remaining !== null || cost !== null) {
    // cost is the server's authoritative pre-flight price for this call;
    // used is what was actually deducted. They can disagree (e.g. free rails).
    meta.credits = { used, remaining, cost };
  }
  if (limit !== null || rateRemaining !== null || resetSeconds !== null) {
    // resetSeconds is a delta in seconds — how long the tripped window needs to
    // drain — not a wall-clock timestamp.
    meta.rateLimit = { limit, remaining: rateRemaining, resetSeconds };
  }
  if (upgradeHint !== null || planNotice !== null || apiKeyNotice !== null) {
    meta.notices = {
      ...(upgradeHint !== null && { upgradeHint }),
      ...(planNotice !== null && { planNotice }),
      ...(apiKeyNotice !== null && { apiKeyNotice }),
    };
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Yield notice strings for any server-set advisory headers.
 * Each yields a `⚠️  <message>` line for stderr.
 * Order: apiKeyNotice (most urgent) → upgradeHint → planNotice.
 */
export function noticeWarnings(meta) {
  const notices = meta?.notices;
  if (!notices) return [];
  const out = [];
  if (notices.apiKeyNotice) out.push(`⚠️  ${notices.apiKeyNotice}`);
  if (notices.upgradeHint) out.push(`ℹ️  ${notices.upgradeHint}`);
  if (notices.planNotice) out.push(`ℹ️  ${notices.planNotice}`);
  return out;
}

/**
 * Warn only when the remaining balance will not cover another call of the size
 * just made.
 */
export function creditWarning(meta) {
  const credits = meta?.credits;
  if (!credits) return null;
  const { used, remaining, cost } = credits;
  if (remaining === null) return null;
  if (remaining === 0) {
    return '⚠️  Out of API credits. Top up at https://app.nansen.ai/api';
  }
  // The cost header is the authoritative charge; used is the fallback.
  const charged = cost ?? used;
  if (charged !== null && charged > 0 && remaining < charged) {
    return `⚠️  ${remaining} API credit${remaining === 1 ? '' : 's'} left — less than this call cost (${charged}). Top up at https://app.nansen.ai/api`;
  }
  return null;
}
