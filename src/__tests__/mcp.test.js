/**
 * MCP install/verify command tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMcpCommands, parseMcpResponseBody, MCP_URL, MCP_SERVER_NAME, MCP_HEADER } from '../commands/mcp.js';
import { ErrorCode, NansenError } from '../api.js';

// ── Helpers ──

/** Build a mock apiInstance. */
function mockApi(overrides = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.nansen.ai',
    defaultHeaders: {},
    ...overrides,
  };
}

/** A fetch mock returning a successful SSE initialize response. */
function okHandshakeFetch() {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"nansen-mcp","version":"3.2.4"}}}\n\n';
  return async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    text: async () => sse,
  });
}

/** A NansenAPI stand-in whose getAccount resolves (valid key). */
class OkAccountAPI {
  constructor(apiKey) { this.apiKey = apiKey; }
  async getAccount() { return { plan: 'professional' }; }
}

/** A NansenAPI stand-in whose getAccount rejects as unauthorized (bad key). */
class UnauthorizedAPI {
  async getAccount() { throw new NansenError('Not logged in', ErrorCode.UNAUTHORIZED, 401); }
}

describe('mcp command', () => {
  let tmpDir, configPath, cmd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-test-'));
    configPath = path.join(tmpDir, 'sub', 'mcp.json');
    cmd = buildMcpCommands({}).mcp;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const installArgs = ['install', 'cursor'];
  const verifyArgs = ['verify', 'cursor'];

  describe('install', () => {
    it('creates a fresh config with the nansen entry and restricted permissions', async () => {
      const result = await cmd(installArgs, mockApi(), {}, { 'config-path': configPath });

      expect(result.action).toBe('created');
      expect(result.config_path).toBe(configPath);
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.mcpServers[MCP_SERVER_NAME]).toEqual({
        url: MCP_URL,
        headers: { [MCP_HEADER]: 'test-key' },
      });
      if (process.platform !== 'win32') {
        expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      }
    });

    it('merges into an existing config without touching other servers', async () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: { other: { command: 'npx', args: ['-y', 'other-mcp'] } },
        theme: 'dark',
      }));

      const result = await cmd(installArgs, mockApi(), {}, { 'config-path': configPath });

      expect(result.action).toBe('created');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.mcpServers.other).toEqual({ command: 'npx', args: ['-y', 'other-mcp'] });
      expect(written.theme).toBe('dark');
      expect(written.mcpServers[MCP_SERVER_NAME].url).toBe(MCP_URL);
    });

    it('reports "updated" when a nansen entry already exists and overwrites it', async () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: { [MCP_SERVER_NAME]: { url: 'https://old.example', headers: { [MCP_HEADER]: 'stale' } } },
      }));

      const result = await cmd(installArgs, mockApi(), {}, { 'config-path': configPath });

      expect(result.action).toBe('updated');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.mcpServers[MCP_SERVER_NAME]).toEqual({
        url: MCP_URL,
        headers: { [MCP_HEADER]: 'test-key' },
      });
    });

    it('prefers --api-key over the resolved login key', async () => {
      await cmd(installArgs, mockApi(), {}, { 'config-path': configPath, 'api-key': 'flag-key' });
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.mcpServers[MCP_SERVER_NAME].headers[MCP_HEADER]).toBe('flag-key');
    });

    it('refuses to clobber an existing file that is not valid JSON', async () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{not json');

      await expect(cmd(installArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toThrow(/not valid JSON/);
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{not json');
    });

    it('rejects a config whose mcpServers is not an object', async () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: ['nope'] }));

      await expect(cmd(installArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toThrow(/non-object "mcpServers"/);
    });

    it('errors with API_KEY_REQUIRED when no key is available', async () => {
      await expect(cmd(installArgs, mockApi({ apiKey: null }), {}, { 'config-path': configPath }))
        .rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('rejects an unknown client', async () => {
      await expect(cmd(['install', 'emacs'], mockApi(), {}, {}))
        .rejects.toThrow(/Unknown MCP client: emacs/);
    });

    it('requires a client argument', async () => {
      await expect(cmd(['install'], mockApi(), {}, {}))
        .rejects.toThrow(/Client is required/);
    });
  });

  describe('verify', () => {
    async function install() {
      await cmd(installArgs, mockApi(), {}, { 'config-path': configPath });
    }

    it('passes when the handshake succeeds and the key is valid', async () => {
      await install();
      const verify = buildMcpCommands({ fetchFn: okHandshakeFetch(), NansenAPIClass: OkAccountAPI }).mcp;

      const result = await verify(verifyArgs, mockApi(), {}, { 'config-path': configPath });

      expect(result).toMatchObject({
        client: 'cursor',
        transport: 'ok',
        server: 'nansen-mcp',
        server_version: '3.2.4',
        auth: 'ok',
        plan: 'professional',
      });
    });

    it('errors with MCP_NOT_INSTALLED when no nansen entry exists', async () => {
      const verify = buildMcpCommands({ fetchFn: okHandshakeFetch(), NansenAPIClass: OkAccountAPI }).mcp;
      await expect(verify(verifyArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toMatchObject({ code: 'MCP_NOT_INSTALLED' });
    });

    it('errors with MCP_CONFIG_INVALID when the entry lacks the auth header', async () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: MCP_URL } } }));
      const verify = buildMcpCommands({ fetchFn: okHandshakeFetch(), NansenAPIClass: OkAccountAPI }).mcp;

      await expect(verify(verifyArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toMatchObject({ code: 'MCP_CONFIG_INVALID' });
    });

    it('fails on a non-2xx handshake without reaching the auth check', async () => {
      await install();
      let authChecked = false;
      class TrackingAPI { async getAccount() { authChecked = true; return {}; } }
      const verify = buildMcpCommands({
        fetchFn: async () => ({ ok: false, status: 404, headers: new Headers(), text: async () => '' }),
        NansenAPIClass: TrackingAPI,
      }).mcp;

      await expect(verify(verifyArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toThrow(/HTTP 404/);
      expect(authChecked).toBe(false);
    });

    it('surfaces network failures as MCP endpoint unreachable', async () => {
      await install();
      const verify = buildMcpCommands({
        fetchFn: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); },
        NansenAPIClass: OkAccountAPI,
      }).mcp;

      await expect(verify(verifyArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toThrow(/MCP endpoint unreachable/);
    });

    it('reports INVALID_API_KEY when the configured key fails the auth check', async () => {
      await install();
      const verify = buildMcpCommands({ fetchFn: okHandshakeFetch(), NansenAPIClass: UnauthorizedAPI }).mcp;

      await expect(verify(verifyArgs, mockApi(), {}, { 'config-path': configPath }))
        .rejects.toMatchObject({ code: 'INVALID_API_KEY' });
    });

    it('sends the configured key on the handshake request', async () => {
      await install();
      let sentHeaders = null;
      const verify = buildMcpCommands({
        fetchFn: async (_url, init) => {
          sentHeaders = init.headers;
          return okHandshakeFetch()();
        },
        NansenAPIClass: OkAccountAPI,
      }).mcp;

      await verify(verifyArgs, mockApi(), {}, { 'config-path': configPath });
      expect(sentHeaders[MCP_HEADER]).toBe('test-key');
    });
  });

  describe('help and dispatch', () => {
    it('defaults to help with subcommand list', async () => {
      const result = await cmd([], mockApi(), {}, {});
      expect(result.subcommands).toEqual(['install', 'verify']);
    });

    it('rejects unknown subcommands', async () => {
      await expect(cmd(['upgrade'], mockApi(), {}, {}))
        .rejects.toThrow(/Unknown mcp subcommand: upgrade/);
    });
  });

  describe('parseMcpResponseBody', () => {
    it('parses the first data line of an SSE body', () => {
      const message = parseMcpResponseBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', 'text/event-stream');
      expect(message.jsonrpc).toBe('2.0');
    });

    it('parses a plain JSON body', () => {
      const message = parseMcpResponseBody('{"jsonrpc":"2.0"}', 'application/json');
      expect(message.jsonrpc).toBe('2.0');
    });

    it('throws when an event stream has no data line', () => {
      expect(() => parseMcpResponseBody('event: ping\n\n', 'text/event-stream')).toThrow(/no data/);
    });
  });
});
