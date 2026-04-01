/**
 * Telemetry module tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock fetch globally before importing the module
const fetchMock = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', fetchMock);

/** Import a fresh telemetry module with all memoized state reset. */
async function freshImport() {
  vi.resetModules();
  return await import('../telemetry.js');
}

describe('telemetry', () => {
  let trackCommandSucceeded, trackCommandFailed, getAnonymousId, getSessionId;

  beforeEach(async () => {
    fetchMock.mockClear();
    delete process.env.NANSEN_BASE_URL;
    delete process.env.NANSEN_SESSION_ID;
    delete process.env.NANSEN_NO_TELEMETRY;
    ({ trackCommandSucceeded, trackCommandFailed, getAnonymousId, getSessionId } = await freshImport());
  });

  describe('trackCommandSucceeded', () => {
    it('should send a cli_command_succeeded event', () => {
      trackCommandSucceeded({ command: 'smart-money netflow', duration_ms: 500, flags: ['--chain'] });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('bi-data-sources.nansen.ai');
      const body = JSON.parse(opts.body);
      expect(body.event).toBe('cli_command_succeeded');
      expect(body.event_source).toBe('cli_prod');
      expect(body.path).toBe('/smart-money/netflow');
      expect(body.properties.latency).toBe(0.5);
      expect(body.properties.flags).toEqual(['--chain']);
      expect(body.anonymous_id).toBeTruthy();
      expect(body.session_id).toBeTruthy();
      expect(body.timestamp).toBeTruthy();
      expect(body.event_id).toBeTruthy();
      expect(body.context.client_type).toBe('nansen-cli');
      expect(body.context.client_version).toBeTruthy();
      expect(body.context.system_name).toBeTruthy();
      expect(body.context.system_version).toBeTruthy();
      expect(body.context.node_version).toBe(process.version);
    });

    it('should include from_cache when set', () => {
      trackCommandSucceeded({ command: 'token info', duration_ms: 10, from_cache: true });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.properties.from_cache).toBe(true);
    });

    it('should include chain when specified', () => {
      trackCommandSucceeded({ command: 'token info', duration_ms: 50, chain: 'ethereum' });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.properties.chain).toBe('ethereum');
    });

    it('should omit chain when not specified', () => {
      trackCommandSucceeded({ command: 'token info', duration_ms: 50 });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.properties.chain).toBeUndefined();
    });
  });

  describe('trackCommandFailed', () => {
    it('should send a cli_command_failed event with error details', () => {
      trackCommandFailed({
        command: 'smart-money netflow',
        duration_ms: 1200,
        error_code: 'UNAUTHORIZED',
        status: 401,
        flags: ['--chain', '--pretty'],
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.event).toBe('cli_command_failed');
      expect(body.event_source).toBe('cli_prod');
      expect(body.path).toBe('/smart-money/netflow');
      expect(body.properties.error_code).toBe('UNAUTHORIZED');
      expect(body.properties.status).toBe(401);
    });
  });

  describe('event source', () => {
    it('should use cli_dev when NANSEN_BASE_URL is not production', async () => {
      process.env.NANSEN_BASE_URL = 'http://localhost:8000';
      ({ trackCommandSucceeded } = await freshImport());
      trackCommandSucceeded({ command: 'test', duration_ms: 0 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.event_source).toBe('cli_dev');
    });

    it('should use cli_prod when NANSEN_BASE_URL is production', async () => {
      process.env.NANSEN_BASE_URL = 'https://api.nansen.ai';
      ({ trackCommandSucceeded } = await freshImport());
      trackCommandSucceeded({ command: 'test', duration_ms: 0 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.event_source).toBe('cli_prod');
    });
  });

  describe('anonymous ID', () => {
    it('should persist a UUID to ~/.nansen/telemetry-id', async () => {
      const writeCalls = [];
      const origRead = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('telemetry-id')) throw new Error('ENOENT');
        return origRead(p, ...args);
      });
      vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
        writeCalls.push({ path: p, data });
      });

      ({ getAnonymousId } = await freshImport());
      const id = getAnonymousId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0].path).toContain('telemetry-id');
      expect(writeCalls[0].data).toBe(id);

      vi.restoreAllMocks();
    });

    it('should read existing ID from file', async () => {
      const existingId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const origRead = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('telemetry-id')) return existingId;
        return origRead(p, ...args);
      });

      ({ getAnonymousId } = await freshImport());
      expect(getAnonymousId()).toBe(existingId);

      vi.restoreAllMocks();
    });
  });

  describe('session ID', () => {
    it('should use NANSEN_SESSION_ID env var when set', async () => {
      process.env.NANSEN_SESSION_ID = 'custom-session-123';
      ({ getSessionId } = await freshImport());
      expect(getSessionId()).toBe('custom-session-123');
    });

    it('should create a new session when no file exists', async () => {
      const writeCalls = [];
      const origRead = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('session')) throw new Error('ENOENT');
        return origRead(p, ...args);
      });
      vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
        writeCalls.push({ path: p, data });
      });

      ({ getSessionId } = await freshImport());
      const id = getSessionId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const sessionWrite = writeCalls.find(c => c.path.includes('session'));
      expect(sessionWrite).toBeTruthy();
      const persisted = JSON.parse(sessionWrite.data);
      expect(persisted.id).toBe(id);
      expect(persisted.ts).toBeTypeOf('number');

      vi.restoreAllMocks();
    });

    it('should reuse session within timeout window', async () => {
      const existingSession = { id: 'existing-session-id', ts: Date.now() - 1000 };
      const origRead = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('session')) return JSON.stringify(existingSession);
        return origRead(p, ...args);
      });
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      ({ getSessionId } = await freshImport());
      expect(getSessionId()).toBe('existing-session-id');

      vi.restoreAllMocks();
    });

    it('should rotate session after timeout', async () => {
      const expiredSession = { id: 'old-session', ts: Date.now() - 31 * 60 * 1000 };
      const origRead = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('session')) return JSON.stringify(expiredSession);
        return origRead(p, ...args);
      });
      vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      ({ getSessionId } = await freshImport());
      const id = getSessionId();
      expect(id).not.toBe('old-session');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      vi.restoreAllMocks();
    });
  });

  describe('resilience', () => {
    it('should not throw when fetch fails', () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      expect(() => {
        trackCommandSucceeded({ command: 'test', duration_ms: 0 });
      }).not.toThrow();
    });
  });

  describe('opt-out', () => {
    it('should not send events when DO_NOT_TRACK=1', async () => {
      process.env.DO_NOT_TRACK = '1';
      ({ trackCommandSucceeded } = await freshImport());
      trackCommandSucceeded({ command: 'test', duration_ms: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      delete process.env.DO_NOT_TRACK;
    });

    it('should not send events when NANSEN_NO_TELEMETRY=1', async () => {
      process.env.NANSEN_NO_TELEMETRY = '1';
      ({ trackCommandSucceeded } = await freshImport());
      trackCommandSucceeded({ command: 'test', duration_ms: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      delete process.env.NANSEN_NO_TELEMETRY;
    });
  });
});
