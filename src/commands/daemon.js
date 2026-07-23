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
  status  Show daemon state (running/stopped, last alert, PID)
  logs    Show the last 50 daemon log lines

OPTIONS:
  --action <cmd>          Shell command to run per alert.
                          Alert JSON passed on stdin. Supports {alertId}, {alertName},
                          {alertType}, {firedAt} placeholder substitutions.
  --action-env            Pass alert JSON as NANSEN_ALERT env var instead of stdin
  --no-backfill           Skip past-alert backfill on (re)connect
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
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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

    for (const key of ['action', 'ws-url', 'state-file', 'pid-file', 'log-file']) {
      if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) {
        throw new Error(`--${key} must be a non-empty string`);
      }
    }

    if (options['ws-url']) {
      let url;
      try {
        url = new URL(options['ws-url']);
      } catch {
        throw new Error('--ws-url must be a valid WebSocket URL');
      }
      const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
      if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && localHosts.has(url.hostname))) {
        throw new Error('--ws-url must use wss:// (ws:// is allowed only for localhost)');
      }
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
        const restUrl = wsUrl
          ? wsUrl.replace(/^ws/, 'http').replace('/v1/smart-alert/stream', '/api/v1/smart-alert/past-alerts')
          : undefined;

        const daemon = new AlertsDaemon({
          apiKey,
          wsUrl,
          restUrl,
          action: options.action,
          actionEnv: flags['action-env'],
          backfill: !flags['no-backfill'],
          stateFile,
          logFile: options['log-file'] ?? null,
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
        const argv = [
          ...process.argv.slice(0, 2), // node + script path
          'alerts', 'daemon', 'run',
          ...(options['ws-url'] ? ['--ws-url', options['ws-url']] : []),
          ...(options.action ? ['--action', options.action] : []),
          ...(flags['action-env'] ? ['--action-env'] : []),
          ...(flags['no-backfill'] ? ['--no-backfill'] : []),
          ...(options['state-file'] ? ['--state-file', options['state-file']] : []),
          '--log-file', logFile,
        ];

        const child = spawn(process.execPath, argv.slice(1), {
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
        } catch {
          // Missing or corrupt state is reported as empty.
        }

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
