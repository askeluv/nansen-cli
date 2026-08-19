/**
 * Tests for `nansen mcp install/uninstall` (src/commands/mcp.js).
 * House pattern: real temp dir + injected deps, no fs mocking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveClientConfigPath,
  buildServerEntry,
  mergeNansenEntry,
  removeNansenEntry,
  buildMcpCommands,
  NANSEN_MCP_URL,
  MCP_REMOTE_PIN,
  extractInstalledKey,
  parseMcpResponse,
  classifyVerifyResult,
} from '../commands/mcp.js';

const API_KEY = 'test-key-123';
const TOKEN_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const response = (body, status = 200) => ({ status, text: async () => body });
const successBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: '{"token_symbol":"USDC"}' }] },
});

describe('resolveClientConfigPath', () => {
  const ctx = { platform: 'linux', homedir: '/home/u', env: {} };

  it('claude-code -> ~/.claude.json on all platforms', () => {
    expect(resolveClientConfigPath('claude-code', ctx)).toBe('/home/u/.claude.json');
    expect(resolveClientConfigPath('claude-code', { ...ctx, platform: 'darwin' })).toBe('/home/u/.claude.json');
    expect(resolveClientConfigPath('claude-code', { ...ctx, platform: 'win32' })).toBe(path.join('/home/u', '.claude.json'));
  });

  it('cursor -> ~/.cursor/mcp.json', () => {
    expect(resolveClientConfigPath('cursor', ctx)).toBe(path.join('/home/u', '.cursor', 'mcp.json'));
  });

  it('claude-desktop on macOS -> Application Support path', () => {
    expect(resolveClientConfigPath('claude-desktop', { ...ctx, platform: 'darwin' }))
      .toBe(path.join('/home/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  });

  it('claude-desktop on Windows uses APPDATA', () => {
    expect(resolveClientConfigPath('claude-desktop', { platform: 'win32', homedir: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }))
      .toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  });

  it('claude-desktop on Linux throws with actionable message', () => {
    expect(() => resolveClientConfigPath('claude-desktop', ctx)).toThrow(/not available on Linux.*claude-code/s);
  });

  it('unknown client throws listing supported clients', () => {
    expect(() => resolveClientConfigPath('vscode', ctx)).toThrow(/claude-code, claude-desktop, cursor/);
  });
});

describe('buildServerEntry', () => {
  it('claude-code: native remote with required type field', () => {
    expect(buildServerEntry('claude-code', API_KEY)).toEqual({
      type: 'http',
      url: NANSEN_MCP_URL,
      headers: { 'NANSEN-API-KEY': API_KEY },
    });
  });

  it('cursor: url + headers, no type field', () => {
    const entry = buildServerEntry('cursor', API_KEY);
    expect(entry).toEqual({ url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': API_KEY } });
    expect(entry.type).toBeUndefined();
  });

  it('claude-desktop: pinned mcp-remote stdio bridge', () => {
    const entry = buildServerEntry('claude-desktop', API_KEY);
    expect(entry.command).toBe('npx');
    expect(entry.args).toContain(MCP_REMOTE_PIN);
    expect(MCP_REMOTE_PIN).toMatch(/^mcp-remote@\d+\.\d+\.\d+$/); // exact pin, not a range
    // no space after the colon (Claude Desktop mis-splits spaced args)
    expect(entry.args).toContain('NANSEN-API-KEY:${NANSEN_API_KEY}');
    expect(entry.args.join(' ')).not.toContain(API_KEY);
    expect(entry.env).toEqual({ NANSEN_API_KEY: API_KEY });
    expect(entry.args).not.toContain('--allow-http');
  });
});

describe('mergeNansenEntry / removeNansenEntry', () => {
  const entry = buildServerEntry('cursor', API_KEY);

  it('preserves sibling servers and unrelated top-level keys', () => {
    const cfg = { mcpServers: { other: { command: 'foo' } }, theme: 'dark' };
    const merged = mergeNansenEntry(cfg, entry);
    expect(merged.mcpServers.other).toEqual({ command: 'foo' });
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.nansen).toEqual(entry);
    expect(cfg.mcpServers.nansen).toBeUndefined(); // input not mutated
  });

  it('creates mcpServers when absent and overwrites an existing nansen entry', () => {
    expect(mergeNansenEntry({}, entry).mcpServers.nansen).toEqual(entry);
    const merged = mergeNansenEntry({ mcpServers: { nansen: { url: 'old' } } }, entry);
    expect(merged.mcpServers.nansen).toEqual(entry);
  });

  it('refuses when mcpServers is not an object', () => {
    expect(() => mergeNansenEntry({ mcpServers: [] }, entry)).toThrow(/not an object/);
    expect(() => mergeNansenEntry({ mcpServers: 'nope' }, entry)).toThrow(/not an object/);
    expect(() => removeNansenEntry({ mcpServers: 42 })).toThrow(/not an object/);
  });

  it('refuses when the config root is not an object', () => {
    for (const config of [null, [], 'nope']) {
      expect(() => mergeNansenEntry(config, entry)).toThrow(/must contain a JSON object/);
      expect(() => removeNansenEntry(config)).toThrow(/must contain a JSON object/);
    }
  });

  it('removeNansenEntry removes only nansen and reports not-found', () => {
    const { config, removed } = removeNansenEntry({ mcpServers: { nansen: entry, other: { command: 'foo' } } });
    expect(removed).toBe(true);
    expect(config.mcpServers).toEqual({ other: { command: 'foo' } });
    expect(removeNansenEntry({}).removed).toBe(false);
    expect(removeNansenEntry({ mcpServers: {} }).removed).toBe(false);
  });
});

describe('MCP verify helpers', () => {
  it('extracts keys only from exact installed entries', () => {
    expect(extractInstalledKey('cursor', buildServerEntry('cursor', API_KEY))).toBe(API_KEY);
    expect(extractInstalledKey('claude-code', buildServerEntry('claude-code', API_KEY))).toBe(API_KEY);
    expect(extractInstalledKey('claude-desktop', buildServerEntry('claude-desktop', API_KEY))).toBe(API_KEY);

    const drifted = buildServerEntry('cursor', API_KEY);
    drifted.url = 'https://evil.example/mcp';
    expect(extractInstalledKey('cursor', drifted)).toBeNull();
    expect(extractInstalledKey('cursor', null)).toBeNull();
    expect(extractInstalledKey('vscode', buildServerEntry('cursor', API_KEY))).toBeNull();
  });

  it('parses direct JSON and selects the matching SSE event', () => {
    const direct = { jsonrpc: '2.0', id: 1, result: { content: [] } };
    expect(parseMcpResponse(JSON.stringify(direct), 1)).toEqual(direct);

    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":99,"result":{"content":[]}}',
      '',
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}',
      '',
      'data: [DONE]',
    ].join('\n');
    expect(parseMcpResponse(sse, 1).id).toBe(1);
    expect(() => parseMcpResponse('', 1)).toThrow(/Empty MCP response/);
    expect(() => parseMcpResponse('data: nope', 1)).toThrow(/Unparseable MCP response/);
  });

  it('falls back to the last parseable SSE event', () => {
    const sse = 'data: {"id":99,"result":{"content":[]}}\ndata: {"id":100,"result":{"content":[]}}';
    expect(parseMcpResponse(sse, 1).id).toBe(100);
  });

  it('classifies authenticated, credential, tool, server, and JSON-RPC outcomes', () => {
    expect(classifyVerifyResult(JSON.parse(successBody))).toMatchObject({ ok: true, reason: 'success' });
    expect(classifyVerifyResult({ result: { isError: true, content: [{ type: 'text', text: 'NANSEN-API-KEY header is required' }] } }))
      .toMatchObject({ ok: false, reason: 'missing-key' });
    expect(classifyVerifyResult({ result: { isError: true, content: [{ type: 'text', text: 'Invalid API key' }] } }))
      .toMatchObject({ ok: false, reason: 'invalid-key' });
    expect(classifyVerifyResult({ result: { isError: true, content: [{ type: 'text', text: 'Unknown tool: token_info' }] } }))
      .toMatchObject({ ok: false, reason: 'unknown-tool' });
    expect(classifyVerifyResult({ result: { isError: true, content: [{ type: 'text', text: 'backend failed' }] } }))
      .toMatchObject({ ok: false, reason: 'server-error', detail: expect.stringContaining('backend failed') });
    expect(classifyVerifyResult({ error: { code: -32600, message: 'bad request' } }))
      .toMatchObject({ ok: false, reason: 'server-error', detail: expect.stringContaining('bad request') });
  });
});

describe('mcp command handler', () => {
  let tempDir;
  let logs;
  let mcp;
  let fetchFn;
  const api = { apiKey: API_KEY };

  const run = (args, { flags = {}, apiInstance = api } = {}) => mcp(args, apiInstance, flags, {});
  const cursorPath = () => path.join(tempDir, '.cursor', 'mcp.json');
  const readCursor = () => JSON.parse(fs.readFileSync(cursorPath(), 'utf8'));

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-test-'));
    logs = [];
    fetchFn = vi.fn();
    ({ mcp } = buildMcpCommands({
      log: (...a) => logs.push(a.join(' ')),
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
      fetchFn,
    }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('install creates dir 0700 and file 0600 with the nansen entry', async () => {
    await run(['install', 'cursor']);
    expect(readCursor().mcpServers.nansen).toEqual(buildServerEntry('cursor', API_KEY));
    expect(fs.statSync(path.dirname(cursorPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cursorPath()).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toContain('Installed Nansen MCP server');
    expect(logs.join('\n')).toContain('plaintext');
    expect(logs.join('\n')).toContain('nansen mcp verify cursor');
  });

  it('install merges into an existing config and writes a backup first', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: 'foo' } }, unrelated: true });
    fs.writeFileSync(cursorPath(), original);

    await run(['install', 'cursor']);

    const cfg = readCursor();
    expect(cfg.mcpServers.other).toEqual({ command: 'foo' });
    expect(cfg.unrelated).toBe(true);
    expect(cfg.mcpServers.nansen.url).toBe(NANSEN_MCP_URL);
    expect(fs.readFileSync(`${cursorPath()}.bak`, 'utf8')).toBe(original);
    expect(fs.statSync(`${cursorPath()}.bak`).mode & 0o777).toBe(0o600);
  });

  it('re-running install is idempotent and reports an update', async () => {
    await run(['install', 'cursor']);
    logs.length = 0;
    await run(['install', 'cursor']);
    expect(logs.join('\n')).toContain('Updated existing Nansen MCP entry');
    expect(readCursor().mcpServers.nansen).toEqual(buildServerEntry('cursor', API_KEY));
  });

  it('refuses to touch unparseable JSON', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), '{ not json');
    await expect(run(['install', 'cursor'])).rejects.toThrow(/Could not parse/);
    expect(fs.readFileSync(cursorPath(), 'utf8')).toBe('{ not json'); // untouched
    expect(fs.existsSync(`${cursorPath()}.bak`)).toBe(false);
  });

  it('reports config read failures without calling them parse errors', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), '{}');
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const { mcp: unreadableMcp } = buildMcpCommands({
      log: () => {},
      fsOverride: { ...fs, readFileSync: () => { throw readError; } },
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
    });

    await expect(unreadableMcp(['install', 'cursor'], api, {}, {}))
      .rejects.toThrow(/Could not read.*permission denied/);
  });

  it('removes the secret temp file when the atomic rename fails', async () => {
    const { mcp: failingMcp } = buildMcpCommands({
      log: () => {},
      fsOverride: { ...fs, renameSync: () => { throw new Error('rename failed'); } },
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
    });

    await expect(failingMcp(['install', 'cursor'], api, {}, {})).rejects.toThrow('rename failed');
    expect(fs.readdirSync(path.dirname(cursorPath()))).toEqual([]);
  });

  it('requires login and writes nothing without a key', async () => {
    await expect(run(['install', 'cursor'], { apiInstance: { apiKey: null } }))
      .rejects.toThrow('Not logged in. Run: nansen login');
    expect(fs.existsSync(cursorPath())).toBe(false);
  });

  it('--dry-run writes nothing and never prints the key', async () => {
    await run(['install', 'cursor'], { flags: { 'dry-run': true } });
    expect(fs.existsSync(cursorPath())).toBe(false);
    const out = logs.join('\n');
    expect(out).toContain(cursorPath());
    expect(out).toContain('<redacted>');
    expect(out).not.toContain(API_KEY);
  });

  it('install output never contains the key', async () => {
    await run(['install', 'cursor']);
    expect(logs.join('\n')).not.toContain(API_KEY);
  });

  it('uninstall removes only the nansen entry', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ mcpServers: { nansen: { url: 'x' }, other: { command: 'foo' } } }));
    await run(['uninstall', 'cursor']);
    expect(readCursor().mcpServers).toEqual({ other: { command: 'foo' } });
  });

  it('uninstall --dry-run leaves the config unchanged', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const original = JSON.stringify({ mcpServers: { nansen: { url: 'x' } } });
    fs.writeFileSync(cursorPath(), original);
    await run(['uninstall', 'cursor'], { flags: { 'dry-run': true } });
    expect(fs.readFileSync(cursorPath(), 'utf8')).toBe(original);
    expect(logs.join('\n')).toContain('Would remove "nansen" entry');
  });

  it('uninstall with no entry is a friendly no-op', async () => {
    await run(['uninstall', 'cursor']);
    expect(logs.join('\n')).toContain('Nothing to do');
  });

  it('uninstall works without an API key', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ mcpServers: { nansen: { url: 'x' } } }));
    await run(['uninstall', 'cursor'], { apiInstance: { apiKey: null } });
    expect(readCursor().mcpServers).toEqual({});
  });

  it('bare `mcp` and `mcp --help` print usage; bad inputs throw actionable errors', async () => {
    await run([]);
    expect(logs.join('\n')).toContain('nansen mcp install <client>');
    await expect(run(['frobnicate'])).rejects.toThrow(/Unknown subcommand/);
    await expect(run(['install'])).rejects.toThrow(/claude-code, claude-desktop, cursor/);
    await expect(run(['install', 'vscode'])).rejects.toThrow(/claude-code, claude-desktop, cursor/);
  });

  it('follows a symlinked config instead of replacing the link', async () => {
    const realDir = path.join(tempDir, 'dotfiles');
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const realFile = path.join(realDir, 'mcp.json');
    fs.writeFileSync(realFile, '{}');
    fs.symlinkSync(realFile, cursorPath());

    await run(['install', 'cursor']);

    expect(fs.lstatSync(cursorPath()).isSymbolicLink()).toBe(true); // link survives
    expect(JSON.parse(fs.readFileSync(realFile, 'utf8')).mcpServers.nansen.url).toBe(NANSEN_MCP_URL);
  });

  it('verifies login credentials with the authenticated token_info request', async () => {
    fetchFn.mockResolvedValue(response(successBody));

    await run(['verify']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(NANSEN_MCP_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.headers).toEqual({
      'NANSEN-API-KEY': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    });
    expect(JSON.parse(init.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'token_info',
        arguments: { request: { chain: 'ethereum', tokenAddress: TOKEN_ADDRESS } },
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(logs.join('\n')).toContain('Authenticated MCP data call succeeded');
    expect(logs.join('\n')).toContain('consumes a small number of API credits');
    expect(logs.join('\n')).not.toContain(API_KEY);
  });

  it('uses the installed cursor credential and claude-desktop env credential', async () => {
    fetchFn.mockResolvedValue(response(successBody));
    await run(['install', 'cursor']);
    logs.length = 0;
    fetchFn.mockClear();

    await run(['verify', 'cursor']);
    expect(fetchFn.mock.calls[0][1].headers['NANSEN-API-KEY']).toBe(API_KEY);

    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-desktop-test-'));
    try {
      const desktopPath = resolveClientConfigPath('claude-desktop', { platform: 'darwin', homedir: desktopDir, env: {} });
      fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
      fs.writeFileSync(desktopPath, JSON.stringify({ mcpServers: { nansen: buildServerEntry('claude-desktop', API_KEY) } }));
      const { mcp: desktopMcp } = buildMcpCommands({
        log: (...a) => logs.push(a.join(' ')),
        platform: 'darwin',
        homedirFn: () => desktopDir,
        env: {},
        fetchFn,
      });

      fetchFn.mockClear();
      await desktopMcp(['verify', 'claude-desktop'], api, {}, {});
      expect(fetchFn.mock.calls[0][1].headers['NANSEN-API-KEY']).toBe(API_KEY);
    } finally {
      fs.rmSync(desktopDir, { recursive: true, force: true });
    }
  });

  it('rejects missing and drifted client entries without a network call', async () => {
    await expect(run(['verify', 'cursor'])).rejects.toThrow(/not installed.*nansen mcp install cursor/);
    expect(fetchFn).not.toHaveBeenCalled();

    for (const [client, entry] of [
      ['cursor', { ...buildServerEntry('cursor', API_KEY), url: 'https://evil.example/mcp' }],
      ['claude-code', { url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': API_KEY } }],
      ['cursor', { ...buildServerEntry('cursor', API_KEY), headers: { 'NANSEN-API-KEY': API_KEY, 'X-Edited': 'true' } }],
    ]) {
      fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
      const configPath = client === 'claude-code'
        ? resolveClientConfigPath(client, { platform: 'linux', homedir: tempDir, env: {} })
        : cursorPath();
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { nansen: entry } }));
      await expect(run(['verify', client])).rejects.toThrow(/does not match.*re-run install/);
      expect(fetchFn).not.toHaveBeenCalled();
    }

    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-drift-test-'));
    try {
      const desktopPath = resolveClientConfigPath('claude-desktop', { platform: 'darwin', homedir: desktopDir, env: {} });
      const entry = buildServerEntry('claude-desktop', API_KEY);
      entry.args[1] = 'mcp-remote@0.0.0';
      fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
      fs.writeFileSync(desktopPath, JSON.stringify({ mcpServers: { nansen: entry } }));
      const { mcp: desktopMcp } = buildMcpCommands({
        log: () => {}, platform: 'darwin', homedirFn: () => desktopDir, env: {}, fetchFn,
      });
      await expect(desktopMcp(['verify', 'claude-desktop'], api, {}, {})).rejects.toThrow(/does not match.*re-run install/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(desktopDir, { recursive: true, force: true });
    }
  });

  it('requires login, rejects dry-run, and never exposes the key', async () => {
    await expect(run(['verify'], { apiInstance: { apiKey: null } })).rejects.toThrow('Not logged in. Run: nansen login');
    await expect(run(['verify'], { flags: { 'dry-run': true } })).rejects.toThrow(/real authenticated data call.*no dry run/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain(API_KEY);
  });

  it('handles SSE, plain JSON, and malformed successful responses', async () => {
    const sse = [
      'data: {"id":99,"result":{"content":[{"type":"text","text":"wrong"}]}}',
      'data: {"id":1,"result":{"content":[{"type":"text","text":"right"}]}}',
    ].join('\n');
    fetchFn.mockResolvedValueOnce(response(sse)).mockResolvedValueOnce(response(successBody)).mockResolvedValueOnce(response('not json'));

    await run(['verify']);
    await run(['verify']);
    await expect(run(['verify'])).rejects.toThrow(/Unexpected response from the MCP server/);
    expect(logs.filter(log => log.includes('Authenticated MCP data call succeeded'))).toHaveLength(2);
  });

  it.each([
    [401, /rejected the API key.*HTTP 401/],
    [403, /rejected the API key.*HTTP 403/],
    [429, /rate limited.*429/],
    [500, /returned HTTP 500/],
    [503, /returned HTTP 503/],
    [400, /Unexpected response.*HTTP 400.*bad request/],
  ])('maps HTTP %s to actionable guidance', async (status, expected) => {
    fetchFn.mockResolvedValue(response(status === 400 ? 'bad request' : '', status));
    await expect(run(['verify'])).rejects.toThrow(expected);
    expect(logs).toEqual([]);
  });

  it('maps connectivity, redirect, and timeout failures without logging first', async () => {
    fetchFn.mockRejectedValueOnce(new TypeError('redirect')).mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    await expect(run(['verify'])).rejects.toThrow(/Could not connect.*network\/proxy/);
    await expect(run(['verify'])).rejects.toThrow(/timed out after 15 seconds/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1].redirect).toBe('error');
    expect(logs).toEqual([]);
  });
});

describe('schema + CLI registration', () => {
  it('schema.json documents mcp install/uninstall', async () => {
    const { fileURLToPath } = await import('url');
    const schema = JSON.parse(fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.json'), 'utf8'));
    expect(Object.keys(schema.commands)).toContain('mcp');
    expect(Object.keys(schema.commands.mcp.subcommands).sort()).toEqual(['install', 'uninstall', 'verify']);
    expect(schema.commands.mcp.subcommands.verify.description).toContain('credits');
    expect(schema.commands.mcp.subcommands.verify.examples).toContain('nansen mcp verify cursor');
    expect(schema.commands.mcp.subcommands.uninstall.options['dry-run'].type).toBe('boolean');
  });

  it('runCLI routes `mcp` and parses --dry-run as a boolean flag', async () => {
    const { runCLI, parseArgs } = await import('../cli.js');
    expect(parseArgs(['mcp', 'install', '--dry-run', 'cursor'])._).toEqual(['mcp', 'install', 'cursor']);

    const outputs = [];
    const logs = [];
    const result = await runCLI(['mcp'], {
      output: (m) => outputs.push(m),
      log: (m) => logs.push(m),
      errorOutput: () => {},
      exit: () => {},
    });
    expect(result.type).toBe('no-output');
    expect(logs.join('\n')).toContain('nansen mcp install <client>');
  });

  it('routes mcp verify and exposes it in top-level help', async () => {
    const { runCLI, parseArgs, HELP } = await import('../cli.js');
    expect(parseArgs(['mcp', 'verify', '--dry-run'])._).toEqual(['mcp', 'verify']);
    expect(HELP).toContain('install/uninstall/verify the Nansen MCP server');

    const outputs = [];
    const result = await runCLI(['mcp', 'verify'], {
      output: (m) => outputs.push(m),
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
      commandOverrides: { mcp: async () => undefined },
    });
    expect(result.type).toBe('no-output');
  });
});
