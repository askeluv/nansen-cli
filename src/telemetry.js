/**
 * Lightweight CLI telemetry.
 *
 * Sends anonymous usage events so we can understand which commands are used,
 * how long they take, and where errors occur.  Events are fire-and-forget —
 * failures are silently ignored and never block the CLI.
 *
 * Perp `order`/`close` additionally emit a `perp_order_completed` event that
 * carries only the trade side and the Hyperliquid order id, tied to the same
 * random anonymous_id. All telemetry is opt-out via DO_NOT_TRACK=1 or
 * NANSEN_NO_TELEMETRY=1.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { version: cliVersion } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

const TELEMETRY_URL =
  'https://bi-data-sources.nansen.ai/events-service-68ifmnpsx2uq7cgab8dw/v2/event';

const TIMEOUT_MS = 1000;

// Every other module that writes under ~/.nansen (api.js, wallet.js, keychain.js,
// trading.js, update-check.js, …) creates directories 0700 and files 0600, because
// the same directory also holds the API key and the encrypted wallet keystores.
// Telemetry writes there too, so it uses the same modes: mkdir with recursive:true
// leaves an existing directory's mode alone, so whichever module creates ~/.nansen
// first fixes its permissions for good — and on the documented NANSEN_API_KEY path
// no config is ever saved, so that first writer is this file.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ─── opt-out ──────────────────────────────────────────────

/**
 * The single source of truth for the opt-out predicate — only the literal '1'
 * disables telemetry. Also used by `nansen doctor` to report telemetry state.
 */
export function isTelemetryDisabled(env = process.env) {
  return env.DO_NOT_TRACK === '1' || env.NANSEN_NO_TELEMETRY === '1';
}

export const TELEMETRY_DISABLED = isTelemetryDisabled();

// ─── environment ──────────────────────────────────────────

/**
 * Infer prod vs dev from NANSEN_BASE_URL env var.
 * Only engineers pointing at a local/staging API will have this set.
 */
function getEventSource() {
  const baseUrl = process.env.NANSEN_BASE_URL || '';
  return baseUrl && !baseUrl.includes('api.nansen.ai') ? 'cli_dev' : 'cli_prod';
}

// ─── system info ──────────────────────────────────────────

const SYSTEM_NAMES = { Darwin: 'macos', Linux: 'linux', Windows_NT: 'windows' };

function getSystemName() {
  return SYSTEM_NAMES[os.type()] || os.type().toLowerCase();
}

// ─── identity ──────────────────────────────────────────────

const TELEMETRY_ID_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.nansen',
  'telemetry-id'
);

/**
 * Get or create a persistent random anonymous_id stored in ~/.nansen/telemetry-id.
 */
let _anonymousId;
export function getAnonymousId() {
  if (!_anonymousId) {
    try {
      const stored = fs.readFileSync(TELEMETRY_ID_FILE, 'utf8').trim();
      if (stored) _anonymousId = stored;
    } catch { /* missing or unreadable → generate below */ }
    if (!_anonymousId) {
      _anonymousId = crypto.randomUUID();
      try {
        fs.mkdirSync(path.dirname(TELEMETRY_ID_FILE), { mode: DIR_MODE, recursive: true });
        fs.writeFileSync(TELEMETRY_ID_FILE, _anonymousId, { encoding: 'utf8', mode: FILE_MODE });
      } catch { /* best-effort persist */ }
    }
  }
  return _anonymousId;
}

// ─── session ───────────────────────────────────────────────

const SESSION_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.nansen',
  'session'
);

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create a session ID. The session rotates after 30 min of inactivity.
 * Callers can override via NANSEN_SESSION_ID env var.
 */
let _sessionId;
export function getSessionId() {
  if (_sessionId !== undefined) return _sessionId;

  if (process.env.NANSEN_SESSION_ID) {
    _sessionId = process.env.NANSEN_SESSION_ID;
    return _sessionId;
  }

  const now = Date.now();
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (raw.id && raw.ts && now - raw.ts < SESSION_TIMEOUT_MS) {
      _sessionId = raw.id;
      // touch timestamp, but only if >1 min elapsed to reduce writes
      if (now - raw.ts > 60_000) {
        try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ id: _sessionId, ts: now }), { encoding: 'utf8', mode: FILE_MODE }); } catch { /* best-effort touch */ }
      }
      return _sessionId;
    }
  } catch { /* missing or corrupt → new session */ }

  _sessionId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { mode: DIR_MODE, recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ id: _sessionId, ts: now }), { encoding: 'utf8', mode: FILE_MODE });
  } catch { /* best-effort */ }
  return _sessionId;
}

// ─── send ──────────────────────────────────────────────────

/**
 * Send a telemetry event. Returns a promise that resolves when the request
 * completes (or fails/times out). Never rejects — errors are swallowed.
 * Callers that need to ensure delivery before process.exit can await this.
 */
function sendEvent(event) {
  if (TELEMETRY_DISABLED) return Promise.resolve();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref();

  return fetch(TELEMETRY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: controller.signal,
  })
    .catch(() => {}) // swallow errors
    .finally(() => clearTimeout(timer));
}

// ─── context ───────────────────────────────────────────────

function buildContext() {
  return {
    client_type: 'nansen-cli',
    client_version: cliVersion,
    system_name: getSystemName(),
    system_version: os.release(),
    node_version: process.version,
  };
}

// ─── public API ────────────────────────────────────────────

/**
 * Convert a command string like "smart-money netflow" to a path like "/smart-money/netflow".
 * Agent ("agent …") always maps to "/agent" so prompts are not exploded into path segments.
 */
function commandToPath(command) {
  if (typeof command === 'string' && /^agent(?:\s+|$)/.test(command.trimStart())) {
    return '/agent';
  }
  return '/' + String(command).replace(/\s+/g, '/');
}

/**
 * Track a CLI command that completed successfully.
 *
 * @param {object} opts
 * @param {string} opts.command  - Full command string, e.g. "smart-money netflow"
 * @param {number} opts.duration_ms - Wall-clock execution time
 * @param {boolean} [opts.from_cache] - Whether result was served from cache
 * @param {string[]} [opts.flags] - Flag names used (no values), e.g. ["--chain", "--pretty"]
 * @param {string|null} [opts.chain] - Chain name if specified, e.g. "ethereum", "solana"
 */
export function trackCommandSucceeded({
  command,
  duration_ms,
  from_cache = false,
  flags = [],
  chain = null,
}) {
  return sendEvent({
    event: 'cli_command_succeeded',
    event_source: getEventSource(),
    event_id: crypto.randomUUID(),
    user_id: null,
    anonymous_id: getAnonymousId(),
    session_id: getSessionId(),
    timestamp: new Date().toISOString(),
    path: commandToPath(command),
    properties: {
      source: `nansen-cli/${cliVersion}`,
      latency: duration_ms / 1000,
      from_cache,
      flags,
      ...(chain ? { chain } : {}),
    },
    context: buildContext(),
  });
}

/**
 * Track a CLI command that failed.
 *
 * @param {object} opts
 * @param {string} opts.command - Full command string
 * @param {number} opts.duration_ms - Wall-clock execution time
 * @param {string} opts.error_code - Structured error code (from ErrorCode or custom)
 * @param {number|null} [opts.status] - HTTP status if the error came from the API
 * @param {string[]} [opts.flags] - Flag names used
 * @param {string|null} [opts.chain] - Chain name if specified
 */
export function trackCommandFailed({
  command,
  duration_ms,
  error_code,
  status = null,
  flags = [],
  chain = null,
}) {
  return sendEvent({
    event: 'cli_command_failed',
    event_source: getEventSource(),
    event_id: crypto.randomUUID(),
    user_id: null,
    anonymous_id: getAnonymousId(),
    session_id: getSessionId(),
    timestamp: new Date().toISOString(),
    path: commandToPath(command),
    properties: {
      source: `nansen-cli/${cliVersion}`,
      latency: duration_ms / 1000,
      error_code,
      status,
      flags,
      ...(chain ? { chain } : {}),
    },
    context: buildContext(),
  });
}

/**
 * Track a completed Hyperliquid perp order (`nansen perp order` / `perp close`).
 *
 * Fired from `buildScreenSignSubmit` in perp.js AFTER the HL /exchange response
 * is parsed (`summarizeOrderResult`). This is the only event that sees the order
 * OUTCOME: `cli_command_succeeded` fires at the command wrapper, before the
 * order path returns, so it captures command metadata but never the fill. Perp
 * orders bypass the Nansen API on submit (CLI signs and posts straight to
 * Hyperliquid — Decision D4), so the backend never sees the response either;
 * this client-side event is the only way order outcomes reach BI.
 *
 * Fires on success only: a HL rejection throws in `submitExchange` and is
 * captured by `cli_command_failed`, so no failed event is emitted here.
 *
 * Deliberately minimal: only the trade side and the Hyperliquid order id — no
 * asset, price, size, or fill detail. A trade (fill) id is not carried by the
 * order-placement response (it exists only once the order fills, via the fills
 * feed), so it is not available here. `oid` is omitted when it exceeded JS
 * safe-integer precision at parse time (see summarizeOrderResult).
 *
 * @param {object} opts
 * @param {'order'|'close'} opts.command  - Which perp command placed the order (routes `path`)
 * @param {'buy'|'sell'} opts.side        - Normalized trade side
 * @param {number} [opts.oid]             - Parent leg's Hyperliquid order id (omitted if imprecise)
 */
export function trackPerpOrderCompleted({ command, side, oid }) {
  return sendEvent({
    event: 'perp_order_completed',
    event_source: getEventSource(),
    event_id: crypto.randomUUID(),
    user_id: null,
    anonymous_id: getAnonymousId(),
    session_id: getSessionId(),
    timestamp: new Date().toISOString(),
    // Same path as the command's cli_command_succeeded ("/perp/order" |
    // "/perp/close"), so BI can line the two events up per command.
    path: commandToPath(`perp ${command}`),
    properties: {
      source: `nansen-cli/${cliVersion}`,
      side,
      ...(oid !== undefined && { oid }),
    },
    context: buildContext(),
  });
}
