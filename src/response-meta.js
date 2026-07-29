/**
 * Credit and rate-limit metadata, read from Nansen API response headers.
 *
 * The API reports what a call actually cost and what quota is left on every
 * response. Until now the CLI dropped those headers on the floor and showed
 * only the static per-endpoint estimate published in the OpenAPI spec (see
 * cost-cache.js), which is a quote rather than a charge.
 *
 * readResponseMeta(response) — parse the headers, or null if none are present
 * creditWarning(meta)        — stderr warning string when the balance is short, else null
 *
 * Every header is optional. Some auth rails charge no credits, some responses
 * are served before quota is resolved, and older deployments may not send the
 * rate-limit triplet at all — so a missing header means "unknown", never zero.
 */

/** Header names, as documented in the API reference. */
const CREDITS_USED = 'x-nansen-credits-used';
const CREDITS_REMAINING = 'x-nansen-credits-remaining';
const RATE_LIMIT = 'x-ratelimit-limit';
const RATE_REMAINING = 'x-ratelimit-remaining';
const RATE_RESET = 'x-ratelimit-reset';

/**
 * Read a header as a non-negative integer, or null when absent/unparseable.
 * Tolerates any header bag with a .get() — a real Headers, or a Map in tests.
 */
function intHeader(response, name) {
  const raw = response?.headers?.get?.(name);
  if (raw == null || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Extract credit + rate-limit metadata from a fetch Response.
 * Returns null when the response carries none of it, so callers can skip
 * attaching an object full of nulls.
 */
export function readResponseMeta(response) {
  const used = intHeader(response, CREDITS_USED);
  const remaining = intHeader(response, CREDITS_REMAINING);
  const limit = intHeader(response, RATE_LIMIT);
  const rateRemaining = intHeader(response, RATE_REMAINING);
  const resetSeconds = intHeader(response, RATE_RESET);

  const meta = {};
  if (used !== null || remaining !== null) {
    meta.credits = { used, remaining };
  }
  if (limit !== null || rateRemaining !== null || resetSeconds !== null) {
    // resetSeconds is a delta in seconds — how long the tripped window needs to
    // drain — not a wall-clock timestamp.
    meta.rateLimit = { limit, remaining: rateRemaining, resetSeconds };
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Warn only when the remaining balance will not cover another call of the size
 * just made. Self-scaling across plans — no absolute threshold to tune, and it
 * stays silent until the warning is actually actionable.
 */
export function creditWarning(meta) {
  const credits = meta?.credits;
  if (!credits) return null;
  const { used, remaining } = credits;
  if (remaining === null) return null;
  if (remaining === 0) {
    return '⚠️  Out of API credits. Top up at https://app.nansen.ai/api';
  }
  if (used !== null && used > 0 && remaining < used) {
    return `⚠️  ${remaining} API credit${remaining === 1 ? '' : 's'} left — less than this call cost (${used}). Top up at https://app.nansen.ai/api`;
  }
  return null;
}
