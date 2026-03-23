/**
 * Nansen CLI - Alerts daemon subcommand
 *
 * nansen alerts daemon <start|stop|status|logs|run> [options]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { AlertsDaemon } from '../daemon/alerts-daemon.js';

const NANSEN_DIR = path.join(os.homedir(), '.nansen');
const DEFAULT_PID_FILE = path.join(NANSEN_DIR, 'alerts-daemon.pid');
const DEFAULT_LOG_FILE = path.join(NANSEN_DIR, 'alerts-daemon.log');
const DEFAULT_STATE_FILE = path.join(NANSEN_DIR, 'alerts-daemon-state.json');

const DAEMON_HELP = `nansen alerts daemon — Listen to Smart Alert events in real-time

SUBCOMMANDS:
  run     Run in foreground (pipe mode — alerts emitted as NDJSON on stdout)
  start   Start daemon in background (writes PID file)
  stop    Stop the running daemon
  status  Show daemon state (running/stopped, last alert, uptime)
  logs    Tail the daemon log file

OPTIONS (run / start):
  --action <cmd>          Shell command to run per alert.
                          Alert JSON passed on stdin. Supports {alertId}, {alertName},
                          {alertType}, {firedAt} placeholder substitutions.
  --action-env            Pass alert JSON as NANSEN_ALERT env var instead of stdin
  --no-backfill           Skip past-alert backfill on (re)connect
  --reconnect-delay <s>   Base reconnect delay in seconds (default: 5)
  --ws-url <url>          Override WebSocket server URL
  --state-file <path>     Path to state JSON (default: ~/.nansen/alerts-daemon-state.json)
  --pid-file <path>       Path to PID file (default: ~/.nansen/alerts-daemon.pid)
  --log-file <path>       Path to log file (default: ~/.nansen/alerts-daemon.log)

EXAMPLES:
  # Print all alerts as JSON (pipe to jq, agent, etc.)
  nansen alerts daemon run

  # Pipe to OpenClaw
  nansen alerts daemon run | openclaw inject

  # Start background daemon, wake up OpenClaw per alert
  nansen alerts daemon start --action 'openclaw inject --message "Alert: {alertName}"'

  # Run against local mock server (for development)
  nansen alerts daemon run --ws-url ws://localhost:9876/v1/smart-alert/stream

  # Check daemon status
  nansen alerts daemon status

  # Stop daemon
  nansen alerts daemon stop
`;

function readPid(pidFile) {
  try {
    return parseInt(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = just check existence
    return true;
  } catch {
    return false;
  }
}

export function buildDaemonCommand(deps = {}) {
  const { log = console.log, getApiKey } = deps;

  return async (args, _apiInstance, flags, options) => {
    const sub = args[0];

    if (!sub || sub === 'help' || flags.help || flags.h) {
      log(DAEMON_HELP);
      return;
    }

    const pidFile = options['pid-file'] ?? DEFAULT_PID_FILE;
    const logFile = options['log-file'] ?? DEFAULT_LOG_FILE;
    const stateFile = options['state-file'] ?? DEFAULT_STATE_FILE;

    const handlers = {
      // ── run ─────────────────────────────────────────────────────────────────
      'run': async () => {
        const apiKey = getApiKey?.() ?? process.env.NANSEN_API_KEY;
        if (!apiKey) {
          throw new Error('No API key found. Run: nansen login --api-key <key>');
        }

        const wsUrl = options['ws-url'];
        // Best-effort derivation of REST URL from WebSocket URL (for dev/test use).
        // Parse properly instead of fragile string replacement.
        let restUrl;
        if (wsUrl) {
          const parsed = new URL(wsUrl);
          parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
          parsed.pathname = '/api/v1/smart-alert/past-alerts';
          restUrl = parsed.toString();
        }

        const daemon = new AlertsDaemon({
          apiKey,
          wsUrl,
          restUrl,
          action: options.action,
          actionEnv: flags['action-env'],
          backfill: !flags['no-backfill'],
          stateFile,
          logFile: null, // foreground: log to stderr, not file
          log: (level, message) => {
            process.stderr.write(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`);
          },
        });

        // Graceful shutdown
        process.on('SIGINT', () => { daemon.stop(); process.exit(0); });
        process.on('SIGTERM', () => { daemon.stop(); process.exit(0); });

        await daemon.start();
      },

      // ── start ────────────────────────────────────────────────────────────────
      'start': async () => {
        const pid = readPid(pidFile);
        if (isProcessRunning(pid)) {
          log(`Daemon already running (PID ${pid})`);
          return;
        }

        // Spawn detached child
        const { spawn } = await import('child_process');
        const runFlags = [
          'alerts', 'daemon', 'run',
          ...(options['ws-url'] ? ['--ws-url', options['ws-url']] : []),
          ...(options.action ? ['--action', options.action] : []),
          ...(flags['action-env'] ? ['--action-env'] : []),
          ...(flags['no-backfill'] ? ['--no-backfill'] : []),
          ...(options['state-file'] ? ['--state-file', options['state-file']] : []),
          '--log-file', logFile,
        ];

        // Detect whether we're running as a Node script or a compiled/shim binary.
        // When installed globally (e.g. `nansen` shim), process.argv[1] is the
        // binary itself and we invoke it directly. When running as a Node script
        // (e.g. `node src/index.js`), we need process.execPath + script path.
        const scriptPath = process.argv[1] ?? '';
        const isNodeScript = scriptPath.endsWith('.js') || scriptPath.endsWith('.mjs');
        const [bin, spawnArgs] = isNodeScript
          ? [process.execPath, [scriptPath, ...runFlags]]
          : [scriptPath, runFlags];

        const child = spawn(bin, spawnArgs, {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();

        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });

        log(`Daemon started (PID ${child.pid})`);
        log(`Log: ${logFile}`);
        log(`State: ${stateFile}`);
      },

      // ── stop ─────────────────────────────────────────────────────────────────
      'stop': () => {
        const pid = readPid(pidFile);
        if (!isProcessRunning(pid)) {
          log('Daemon is not running');
          return;
        }
        try {
          process.kill(pid, 'SIGTERM');
          log(`Daemon stopped (PID ${pid})`);
          fs.unlinkSync(pidFile);
        } catch (err) {
          log(`Failed to stop daemon: ${err.message}`);
        }
      },

      // ── status ───────────────────────────────────────────────────────────────
      'status': () => {
        const pid = readPid(pidFile);
        const running = isProcessRunning(pid);

        let state = {};
        try {
          state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        } catch { /* state file may not exist yet */ }

        const status = {
          running,
          pid: running ? pid : null,
          lastAlertAt: state.lastAlertAt ?? null,
          lastAlertId: state.lastAlertId ?? null,
          sessionId: state.sessionId ?? null,
          stateFile,
          logFile,
          pidFile,
        };

        if (flags.pretty) {
          log(JSON.stringify(status, null, 2));
        } else {
          log(`Status:     ${running ? 'running' : 'stopped'}`);
          if (running) log(`PID:        ${pid}`);
          if (status.sessionId) log(`Session:    ${status.sessionId}`);
          if (status.lastAlertAt) log(`Last alert: ${status.lastAlertAt} (${status.lastAlertId})`);
          log(`PID file:   ${pidFile}`);
          log(`Log file:   ${logFile}`);
          log(`State file: ${stateFile}`);
        }

        return status;
      },

      // ── logs ─────────────────────────────────────────────────────────────────
      'logs': async () => {
        if (!fs.existsSync(logFile)) {
          log(`No log file found at ${logFile}. Has the daemon been started?`);
          return;
        }
        // Tail last 50 lines
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const tail = lines.slice(-50).join('\n');
        log(tail);
      },
    };

    if (!handlers[sub]) {
      throw new Error(`Unknown daemon subcommand: ${sub}. Available: run, start, stop, status, logs`);
    }

    return handlers[sub]();
  };
}
