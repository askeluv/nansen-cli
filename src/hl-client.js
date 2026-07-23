/**
 * Nansen CLI — direct Hyperliquid exchange submission (client egress).
 *
 * This is the ONE direct-to-HL network call (Decision D4): a signed L1 or
 * user-signed action goes straight from the user's machine to
 * api.hyperliquid.xyz/exchange. Reads and market-data stay on the Nansen proxy
 * (/api/v1/perp/*), so nothing else here talks to HL directly.
 *
 * Mirrors the contract of the backend proxy (perp_execute.py) that this
 * replaces. HL replies with an envelope:
 *   { status: "ok" | "err", response: <object|string> }
 * and signals failure in TWO ways, both of which must throw:
 *   1. a top-level status of "err" (response carries the reason string), and
 *   2. a status of "ok" that still carries per-action errors in
 *      response.data.statuses[].error — a rejected order that would otherwise
 *      masquerade as a fill. The proxy caught this via extract_action_errors;
 *      going direct, the CLI has to catch it itself.
 */

import { CommandError } from "./api.js";

export const HL_MAINNET_API_URL = "https://api.hyperliquid.xyz";

// Resolve the HL API base. NANSEN_HL_API_URL overrides it (tests, or pointing at
// the testnet); defaults to mainnet, matching the prepare flow's phantom agent.
export function hlApiUrl() {
  return process.env.NANSEN_HL_API_URL || HL_MAINNET_API_URL;
}

// Port of perp_execute.py::extract_action_errors. HL returns top-level
// status "ok" even when individual actions are rejected:
//   {"status":"ok","response":{"data":{"statuses":[{"error":"..."}]}}}
// Pull out every per-action error so a rejected order/cancel/close isn't masked
// as success.
export function extractActionErrors(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return [];
  const data = responseBody.data;
  if (!data || typeof data !== "object") return [];
  const statuses = data.statuses;
  if (!Array.isArray(statuses)) return [];
  const errors = [];
  for (const entry of statuses) {
    if (entry && typeof entry === "object" && "error" in entry) {
      errors.push(String(entry.error));
    }
  }
  return errors;
}

// POST a signed action to HL's /exchange endpoint.
//
// `signature` is the {r, s, v} object signAgent() already produces; `nonce` is
// the same nonce the action was hashed with; `vaultAddress` is null for a normal
// wallet (omitted from the body when null, matching the SDK).
//
// Returns the parsed HL response object on success. Throws CommandError on a
// network failure, a non-JSON / HTTP-error response, a top-level "err", or a
// per-action error.
//
// Deliberately NOT retried: each submit carries a unique nonce and is not
// idempotent, so a retry after a request that may have reached HL risks a
// double-submit. A network error surfaces to the caller as-is.
export async function submitExchange(
  { action, nonce, signature, vaultAddress = null },
  { fetchImpl = fetch, baseUrl = hlApiUrl(), timeoutMs = 30000 } = {}
) {
  const body = { action, nonce, signature };
  // HL only expects vaultAddress when trading on behalf of a vault; omit the
  // null so a normal-wallet action hashes/serializes like the SDK's.
  if (vaultAddress != null) body.vaultAddress = vaultAddress;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason =
      err.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : err.message;
    throw new CommandError(
      `Could not reach Hyperliquid: ${reason}`,
      "HL_NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CommandError(
      `Hyperliquid returned a non-JSON response (HTTP ${
        response.status
      }): ${text.slice(0, 200)}`,
      "HL_BAD_RESPONSE"
    );
  }

  if (!response.ok) {
    const detail =
      typeof data === "string"
        ? data
        : data.response || data.error || JSON.stringify(data);
    throw new CommandError(
      `Hyperliquid error (HTTP ${response.status}): ${detail}`,
      "HL_HTTP_ERROR"
    );
  }

  const status = data.status ?? "ok";
  const responseBody = data.response;

  if (status === "err") {
    const reason =
      typeof responseBody === "string"
        ? responseBody
        : "Hyperliquid rejected the action";
    throw new CommandError(
      `Hyperliquid rejected the action: ${reason}`,
      "HL_ACTION_REJECTED"
    );
  }

  const actionErrors = extractActionErrors(responseBody);
  if (actionErrors.length > 0) {
    throw new CommandError(
      `Hyperliquid rejected the action: ${actionErrors.join("; ")}`,
      "HL_ACTION_REJECTED"
    );
  }

  return data;
}
