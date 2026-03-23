/**
 * Nansen CLI - Smart Alerts Daemon
 * WebSocket client that connects to the Nansen alerts stream.
 * Handles reconnect, backfill, state persistence, and action hooks.
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_WS_URL = 'wss://api.nansen.ai/v1/smart-alert/stream';
export const DEFAULT_REST_URL = 'https://api.nansen.ai/api/v1/smart-alert/past-alerts';
const DEFAULT_BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function jitter(maxMs = 2000) {
  return Math.floor(Math.random() * maxMs);
}

function backoffDelay(attempt, baseMs = DEFAULT_BASE_DELAY_MS) {
  const raw = baseMs * Math.pow(2, attempt) + jitter();
  return Math.min(raw, MAX_DELAY_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomically write a JSON file: write to .tmp then rename.
 * Permissions: 0600 (owner read/write only — state may contain session IDs).
 */
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Interpolate {placeholder} tokens in a command string using safe alert metadata.
 * Alert data payload is NOT interpolated — only top-level string fields.
 * This prevents any injection from alert content into the shell command.
 */
function interpolateCommand(template, alert) {
  return template
    .replace(/\{alertId\}/g, sanitizeShell(alert.alertId ?? ''))
    .replace(/\{alertName\}/g, sanitizeShell(alert.alertName ?? ''))
    .replace(/\{alertType\}/g, sanitizeShell(alert.alertType ?? ''))
    .replace(/\{firedAt\}/g, sanitizeShell(alert.firedAt ?? ''));
}

/**
 * Strip characters that could break a shell command.
 * Placeholder substitutions land inside a shell string that we don't fully control,
 * so we only allow a safe subset: alphanumeric, dash, underscore, dot, colon, slash, @.
 */
function sanitizeShell(str) {
  return String(str).replace(/[^a-zA-Z0-9\-_.:/@ ]/g, '');
}

// ── AlertsDaemon ──────────────────────────────────────────────────────────────

export class AlertsDaemon extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.apiKey       Nansen API key (required)
   * @param {string}   [opts.wsUrl]      WebSocket server URL
   * @param {string}   [opts.restUrl]    /past-alerts endpoint base URL
   * @param {string}   [opts.action]     Shell command template to run per alert
   * @param {boolean}  [opts.actionEnv]  Pass alert JSON as NANSEN_ALERT env var (vs stdin)
   * @param {boolean}  [opts.backfill]   Fetch past alerts on (re)connect (default: true)
   * @param {string}   [opts.stateFile]  Path to state JSON
   * @param {string}   [opts.logFile]    Append logs to this file (null = stderr only)
   * @param {function} [opts.log]        Custom log function(level, message)
   * @param {function} [opts.WebSocket]  Injected WebSocket class (for testing)
   * @param {function} [opts.fetchFn]    Injected fetch (for testing)
   */
  constructor(opts = {}) {
    super();
    if (!opts.apiKey) throw new Error('apiKey is required');

    this.apiKey = opts.apiKey;
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
    this.restUrl = opts.restUrl ?? DEFAULT_REST_URL;
    this.action = opts.action ?? null;
    this.actionEnv = opts.actionEnv ?? false;
    this.backfill = opts.backfill ?? true;
    this.stateFile = opts.stateFile ?? path.join(os.homedir(), '.nansen', 'alerts-daemon-state.json');
    this.logFile = opts.logFile ?? null;
    this._logFn = opts.log ?? null;
    this._WebSocket = opts.WebSocket ?? null;
    this._fetch = opts.fetchFn ?? globalThis.fetch;

    this._ws = null;
    this._running = false;
    this._reconnectAttempt = 0;
    this._pingTimer = null;
    this._pongTimer = null;
    this._state = readJsonSafe(this.stateFile) ?? {};
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;
    this.log('info', 'Daemon starting');
    await this._connectLoop();
  }

  stop() {
    this._running = false;
    this._clearTimers();
    if (this._ws) {
      try { this._ws.close(1000, 'daemon stopped'); } catch { /* ignore close errors */ }
      this._ws = null;
    }
    this.log('info', 'Daemon stopped');
  }

  // ── Connection loop ──────────────────────────────────────────────────────────

  async _connectLoop() {
    while (this._running) {
      try {
        await this._connect();
      } catch (err) {
        this.log('error', `Connection error: ${err.message}`);
      }

      if (!this._running) break;

      const delay = backoffDelay(this._reconnectAttempt);
      this.log('info', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempt + 1})`);
      this._reconnectAttempt++;
      await sleep(delay);
    }
  }

  async _connect() {
    // Resolve WebSocket class: injected (tests) > Node 22 built-in > ws package
    let WS = this._WebSocket;
    if (!WS) {
      if (typeof globalThis.WebSocket !== 'undefined') {
        WS = globalThis.WebSocket;
      } else {
        // Dynamically import 'ws' — optional peer dependency
        try {
          WS = (await import('ws')).default;
        } catch {
          throw new Error(
            'No WebSocket implementation found. ' +
            'Node 22+ has it built-in. For older Node, run: npm install ws'
          );
        }
      }
    }

    return new Promise((resolve, reject) => {
      const ws = new WS(this.wsUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this._ws = ws;

      ws.on('open', async () => {
        this.log('info', `Connected to ${this.wsUrl}`);
        this._reconnectAttempt = 0;
        this._startPing();
        this._saveState({ startedAt: this._state.startedAt ?? new Date().toISOString() });

        if (this.backfill && this._state.lastAlertAt) {
          try {
            await this._fetchPastAlerts(this._state.lastAlertAt);
          } catch (err) {
            this.log('warn', `Backfill failed: ${err.message}`);
          }
        }
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.log('warn', 'Received unparseable message, ignoring');
          return;
        }
        this._handleMessage(msg);
      });

      ws.on('close', (code, reason) => {
        this._clearTimers();
        this.log('info', `Connection closed (code=${code} reason=${reason?.toString() ?? ''})`);
        resolve(); // let the loop decide whether to reconnect
      });

      ws.on('error', (err) => {
        this.log('error', `WebSocket error: ${err.message}`);
        // 'close' will fire after 'error', so we reject to surface it in connectLoop
        reject(err);
      });
    });
  }

  // ── Message handling ─────────────────────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        this._saveState({ sessionId: msg.sessionId });
        this.log('info', `Session: ${msg.sessionId}`);
        this.emit('connected', msg);
        break;

      case 'alert':
        // Log only metadata — not alert data payload (may contain market-sensitive info)
        this.log('info', `Alert: [${msg.alertId}] ${msg.alertName} (${msg.alertType}) at ${msg.firedAt}`);
        this._saveState({ lastAlertAt: msg.firedAt, lastAlertId: msg.alertId });
        this.emit('alert', msg);
        this._dispatchAlert(msg);
        break;

      case 'pong':
        this._clearPongTimer();
        break;

      case 'error':
        this.log('error', `Server error [${msg.code}]: ${msg.message}`);
        this.emit('server-error', msg);
        if (msg.code === 'UNAUTHORIZED') {
          this._running = false; // auth failures are not recoverable
          this._ws?.close();
        }
        break;

      default:
        this.log('debug', `Unknown message type: ${msg.type}`);
    }
  }

  _dispatchAlert(alert) {
    // 1. Always emit as NDJSON on stdout (for pipe mode)
    process.stdout.write(JSON.stringify(alert) + '\n');

    // 2. Run --action hook if configured
    if (!this.action) return;

    const cmd = interpolateCommand(this.action, alert);
    const alertJson = JSON.stringify(alert);
    const env = { ...process.env };

    if (this.actionEnv) {
      env.NANSEN_ALERT = alertJson;
    }

    try {
      const child = spawn('/bin/sh', ['-c', cmd], {
        env,
        stdio: ['pipe', 'inherit', 'inherit'],
      });

      if (!this.actionEnv) {
        child.stdin.write(alertJson);
        child.stdin.end();
      }

      child.on('error', (err) => {
        this.log('error', `Action hook error: ${err.message}`);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          this.log('warn', `Action hook exited ${code} for alert ${alert.alertId}`);
        }
      });
    } catch (err) {
      this.log('error', `Failed to spawn action hook: ${err.message}`);
    }
  }

  // ── Backfill ─────────────────────────────────────────────────────────────────

  async _fetchPastAlerts(since) {
    this.log('info', `Backfilling since ${since}`);
    const url = `${this.restUrl}?since=${encodeURIComponent(since)}&limit=50`;

    const res = await this._fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`past-alerts ${res.status} ${res.statusText}`);
    }

    const body = await res.json();
    const alerts = body.alerts ?? [];

    if (alerts.length === 0) {
      this.log('info', 'No missed alerts in backfill window');
      return;
    }

    this.log('info', `Replaying ${alerts.length} missed alert(s)`);
    for (const alert of alerts) {
      this.emit('alert', alert);
      this._dispatchAlert(alert);
    }
  }

  // ── Keepalive ────────────────────────────────────────────────────────────────

  _startPing() {
    this._clearTimers();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === 1 /* OPEN */) {
        this._ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        this._pongTimer = setTimeout(() => {
          this.log('warn', 'Pong timeout — forcing reconnect');
          this._ws?.close();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  _clearPongTimer() {
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  _clearTimers() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this._clearPongTimer();
  }

  // ── State ────────────────────────────────────────────────────────────────────

  _saveState(patch) {
    this._state = { ...this._state, ...patch };
    try {
      writeJsonAtomic(this.stateFile, this._state);
    } catch (err) {
      this.log('warn', `State file write failed: ${err.message}`);
    }
  }

  // ── Logging ──────────────────────────────────────────────────────────────────

  log(level, message) {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    if (this._logFn) {
      this._logFn(level, message);
    } else {
      process.stderr.write(line + '\n');
    }
    if (this.logFile) {
      try { fs.appendFileSync(this.logFile, line + '\n'); } catch { /* ignore log write errors */ }
    }
    this.emit('log', { level, message, line });
  }
}

export default AlertsDaemon;
