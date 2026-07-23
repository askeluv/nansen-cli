/**
 * Unit tests for AlertsDaemon
 * Uses an in-process mock WebSocket server to verify:
 *   - connection & auth
 *   - alert dispatch + stdout emission
 *   - ping/pong keepalive
 *   - reconnect on close
 *   - backfill on reconnect
 *   - state persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildDaemonCommand } from '../commands/daemon.js';
import { AlertsDaemon } from '../daemon/alerts-daemon.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAlert(overrides = {}) {
  return {
    type: 'alert',
    alertId: 'test-alert-001',
    alertName: 'Test Alert',
    alertType: 'sm-token-flows',
    firedAt: new Date().toISOString(),
    data: { chain: 'ethereum' },
    ...overrides,
  };
}

function makeDaemon(opts = {}) {
  class MockWS extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.send = vi.fn();
      this.close = vi.fn((code) => {
        this.readyState = 3;
        this.emit('close', code ?? 1000, '');
      });
      setImmediate(() => this.emit('open'));
    }
  }

  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ alerts: [], count: 0 }),
  });

  const daemon = new AlertsDaemon({
    apiKey: 'test-key',
    wsUrl: 'ws://localhost:9876/v1/smart-alert/stream',
    restUrl: 'http://localhost:9876/api/v1/smart-alert/past-alerts',
    stateFile: '/tmp/test-daemon-state.json',
    backfill: false,
    WebSocket: MockWS,
    fetchFn: mockFetch,
    log: vi.fn(),
    ...opts,
  });

  return { daemon, MockWS, mockFetch };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AlertsDaemon', () => {
  let originalStdoutWrite;
  let stdoutLines = [];

  beforeEach(() => {
    stdoutLines = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data) => {
      if (typeof data === 'string') stdoutLines.push(data);
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  it('throws if no apiKey provided', () => {
    expect(() => new AlertsDaemon({})).toThrow('apiKey is required');
  });

  it('ignores non-object messages', () => {
    const { daemon } = makeDaemon();
    expect(() => daemon._handleMessage(null)).not.toThrow();
  });

  it('emits "connected" event on WS open + connected message', async () => {
    let headers;

    class AutoMockWS extends EventEmitter {
      constructor(_url, options) {
        super();
        headers = options.headers;
        this.readyState = 1;
        this.send = vi.fn();
        this.close = vi.fn((code) => {
          this.readyState = 3;
          this.emit('close', code ?? 1000, '');
        });
        setImmediate(() => {
          this.emit('open');
          setImmediate(() => {
            this.emit('message', JSON.stringify({
              type: 'connected',
              sessionId: 'sess-abc',
              serverTime: new Date().toISOString(),
            }));
          });
        });
      }
    }

    const daemon = new AlertsDaemon({
      apiKey: 'test-key',
      wsUrl: 'ws://localhost/stream',
      restUrl: 'http://localhost/past-alerts',
      stateFile: '/tmp/test-daemon-state2.json',
      backfill: false,
      WebSocket: AutoMockWS,
      fetchFn: vi.fn(),
      log: vi.fn(),
    });

    const conn = await new Promise((resolve) => {
      daemon.once('connected', resolve);
      daemon.start();
    });

    daemon.stop();

    expect(conn.sessionId).toBe('sess-abc');
    expect(headers).toEqual({ apikey: 'test-key' });
  });

  it('emits "alert" event and writes JSON to stdout', async () => {
    const alert = makeAlert();

    class AlertMockWS extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
        this.send = vi.fn();
        this.close = vi.fn((code) => { this.readyState = 3; this.emit('close', code ?? 1000, ''); });
        setImmediate(() => {
          this.emit('open');
          setImmediate(() => this.emit('message', JSON.stringify(alert)));
        });
      }
    }

    const daemon = new AlertsDaemon({
      apiKey: 'test-key',
      wsUrl: 'ws://localhost/stream',
      restUrl: 'http://localhost/past-alerts',
      stateFile: '/tmp/test-daemon-state3.json',
      backfill: false,
      WebSocket: AlertMockWS,
      fetchFn: vi.fn(),
      log: vi.fn(),
    });

    const received = await new Promise((resolve) => {
      daemon.once('alert', resolve);
      daemon.start();
    });

    daemon.stop();

    expect(received.alertId).toBe('test-alert-001');
    expect(received.alertName).toBe('Test Alert');

    // Should have written NDJSON to stdout
    const line = stdoutLines.find((l) => l.includes('test-alert-001'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line.trim());
    expect(parsed.alertId).toBe('test-alert-001');
  });

  it('sends ping and handles pong', async () => {
    vi.useFakeTimers();

    let wsSendCalls = [];

    class PingMockWS extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
        this.send = vi.fn((data) => wsSendCalls.push(JSON.parse(data)));
        this.close = vi.fn((code) => { this.readyState = 3; this.emit('close', code ?? 1000, ''); });
        setImmediate(() => this.emit('open'));
      }
    }

    const daemon = new AlertsDaemon({
      apiKey: 'test-key',
      wsUrl: 'ws://localhost/stream',
      restUrl: 'http://localhost/past-alerts',
      stateFile: '/tmp/test-daemon-state4.json',
      backfill: false,
      WebSocket: PingMockWS,
      fetchFn: vi.fn(),
      log: vi.fn(),
    });

    daemon.start();

    // Advance past the first setImmediate (open), then past one ping interval (30s)
    await vi.advanceTimersByTimeAsync(31_000);

    daemon.stop();

    const pings = wsSendCalls.filter((m) => m.type === 'ping');
    expect(pings.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it('stops reconnecting on UNAUTHORIZED server error', async () => {
    class AuthErrorMockWS extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
        this.send = vi.fn();
        this.close = vi.fn((code) => { this.readyState = 3; this.emit('close', code ?? 1000, ''); });
        setImmediate(() => {
          this.emit('open');
          setImmediate(() => {
            this.emit('message', JSON.stringify({
              type: 'error',
              code: 'UNAUTHORIZED',
              message: 'Invalid API key',
            }));
          });
        });
      }
    }

    const daemon = new AlertsDaemon({
      apiKey: 'bad-key',
      wsUrl: 'ws://localhost/stream',
      restUrl: 'http://localhost/past-alerts',
      stateFile: '/tmp/test-daemon-state5.json',
      backfill: false,
      WebSocket: AuthErrorMockWS,
      fetchFn: vi.fn(),
      log: vi.fn(),
    });

    // Wait for both the error event and for the daemon loop to finish
    const errorMsg = await new Promise((resolve) => {
      daemon.once('server-error', resolve);
      daemon.start();
    });

    // The daemon sets _running = false synchronously in the error handler,
    // but the connect loop needs a microtask tick to process the close event.
    // Flush microtasks by awaiting a resolved promise a few times.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(daemon._running).toBe(false);
    expect(errorMsg.code).toBe('UNAUTHORIZED');

    daemon.stop(); // cleanup timers
  });

  it('calls /past-alerts on reconnect when backfill=true', async () => {
    const missedAlert = makeAlert({ alertId: 'past-001', alertName: 'Past Alert' });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ alerts: [missedAlert], count: 1 }),
    });

    class BackfillMockWS extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
        this.send = vi.fn();
        this.close = vi.fn((code) => { this.readyState = 3; this.emit('close', code ?? 1000, ''); });
        setImmediate(() => this.emit('open'));
      }
    }

    const daemon = new AlertsDaemon({
      apiKey: 'test-key',
      wsUrl: 'ws://localhost/stream',
      restUrl: 'http://localhost/past-alerts',
      stateFile: '/tmp/test-daemon-state6.json',
      backfill: true,
      WebSocket: BackfillMockWS,
      fetchFn: mockFetch,
      log: vi.fn(),
    });

    // Seed a lastAlertAt so backfill triggers
    daemon._state = { lastAlertAt: '2026-03-20T10:00:00Z' };

    const backfilledAlerts = [];
    daemon.on('alert', (a) => backfilledAlerts.push(a));

    // Start the daemon — it will connect, backfill, then wait for messages.
    // We use a log spy to detect when backfill completes.
    const backfillDone = new Promise((resolve) => {
      const origLog = daemon._logFn;
      daemon._logFn = (level, msg) => {
        origLog?.(level, msg);
        if (msg.includes('Replaying') || msg.includes('No missed alerts')) resolve();
      };
    });

    daemon.start();

    await backfillDone;

    daemon.stop();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/past-alerts'),
      expect.objectContaining({ headers: { apikey: 'test-key' } })
    );
    expect(backfilledAlerts.some((a) => a.alertId === 'past-001')).toBe(true);
    expect(daemon._state).toMatchObject({
      lastAlertAt: missedAlert.firedAt,
      lastAlertId: 'past-001',
    });

    await daemon._fetchPastAlerts(daemon._state.lastAlertAt);
    expect(backfilledAlerts.filter((a) => a.alertId === 'past-001')).toHaveLength(1);

    daemon._handleMessage({
      ...missedAlert,
      firedAt: new Date(Date.parse(missedAlert.firedAt) + 1_000).toISOString(),
    });
    expect(backfilledAlerts.filter((a) => a.alertId === 'past-001')).toHaveLength(2);
  });
});

describe('daemon command', () => {
  it('does not treat an invalid PID file as a running daemon', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-daemon-test-'));
    const pidFile = path.join(dir, 'daemon.pid');
    fs.writeFileSync(pidFile, '-1');

    try {
      const command = buildDaemonCommand({ log: vi.fn() });
      const status = await command(['status'], null, {}, {
        'pid-file': pidFile,
        'state-file': path.join(dir, 'state.json'),
        'log-file': path.join(dir, 'daemon.log'),
      });

      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      await expect(command(['status'], null, {}, {
        'pid-file': -1,
      })).rejects.toThrow('--pid-file must be a non-empty string');
      await expect(command(['status'], null, {}, {
        'ws-url': 'ws://example.com/stream',
      })).rejects.toThrow('--ws-url must use wss://');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
