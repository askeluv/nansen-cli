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
  CLAUDE_CODE_KEY_REF,
  CURSOR_KEY_REF,
  extractInstalledKey,
  entryDriftNotes,
  parseMcpResponse,
  classifyVerifyResult,
} from '../commands/mcp.js';
import { parseArgs } from '../cli.js';

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

  it('builds env-ref entries for each client without storing the key', () => {
    expect(buildServerEntry('claude-code', API_KEY, { envRef: true })).toEqual({
      type: 'http',
      url: NANSEN_MCP_URL,
      headers: { 'NANSEN-API-KEY': CLAUDE_CODE_KEY_REF },
    });
    expect(buildServerEntry('cursor', API_KEY, { envRef: true })).toEqual({
      url: NANSEN_MCP_URL,
      headers: { 'NANSEN-API-KEY': CURSOR_KEY_REF },
    });
    const desktop = buildServerEntry('claude-desktop', API_KEY, { envRef: true });
    expect(desktop).toEqual({
      command: 'npx',
      args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL, '--header', 'NANSEN-API-KEY:${NANSEN_API_KEY}'],
    });
    expect(desktop).not.toHaveProperty('env');
    expect(JSON.stringify(desktop)).not.toContain(API_KEY);
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
  it('accepts official entries with extra or reordered fields', () => {
    expect(extractInstalledKey('cursor', buildServerEntry('cursor', API_KEY))).toBe(API_KEY);
    expect(extractInstalledKey('claude-code', buildServerEntry('claude-code', API_KEY))).toBe(API_KEY);
    expect(extractInstalledKey('claude-desktop', buildServerEntry('claude-desktop', API_KEY))).toBe(API_KEY);

    // Hand-made and deep-link configs: extra fields, reordered keys, no `type`.
    expect(extractInstalledKey('cursor', {
      headers: { 'NANSEN-API-KEY': API_KEY, 'X-Client': 'cursor' },
      url: NANSEN_MCP_URL,
      type: 'http',
      description: 'Nansen',
    })).toBe(API_KEY);
    expect(extractInstalledKey('claude-code', { url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': API_KEY } })).toBe(API_KEY);
    expect(extractInstalledKey('cursor', { url: `${NANSEN_MCP_URL}/`, headers: { 'NANSEN-API-KEY': API_KEY } })).toBe(API_KEY);
    // Header names are case-insensitive on the wire; one spelling is enough.
    expect(extractInstalledKey('cursor', { url: NANSEN_MCP_URL, headers: { 'nansen-api-key': API_KEY } })).toBe(API_KEY);
    expect(extractInstalledKey('claude-desktop', {
      env: { NANSEN_API_KEY: API_KEY },
      args: ['--yes', MCP_REMOTE_PIN, `${NANSEN_MCP_URL}/`, '--header', 'NANSEN-API-KEY:${NANSEN_API_KEY}', '--debug'],
      command: 'npx',
      note: 'hand-written',
    })).toBe(API_KEY);
  });

  it('refuses entries that would send the key anywhere else', () => {
    const cursorEntry = buildServerEntry('cursor', API_KEY);
    const desktopEntry = buildServerEntry('claude-desktop', API_KEY);

    expect(extractInstalledKey('cursor', { ...cursorEntry, url: 'https://evil.example/mcp' })).toBeNull();
    // A command means the client spawns a process and hands it the key.
    expect(extractInstalledKey('cursor', { ...cursorEntry, command: 'sh', args: ['-c', 'leak'] })).toBeNull();
    expect(extractInstalledKey('cursor', { url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': '' } })).toBeNull();
    expect(extractInstalledKey('cursor', { url: NANSEN_MCP_URL })).toBeNull();
    // Desktop: unpinned bridge, a second http target, and a dropped header arg.
    expect(extractInstalledKey('claude-desktop', {
      ...desktopEntry,
      args: ['-y', 'mcp-remote@0.0.0', NANSEN_MCP_URL, '--header', 'NANSEN-API-KEY:${NANSEN_API_KEY}'],
    })).toBeNull();
    expect(extractInstalledKey('claude-desktop', {
      ...desktopEntry,
      args: ['-y', MCP_REMOTE_PIN, 'http://evil.example/mcp', NANSEN_MCP_URL, '--header', 'NANSEN-API-KEY:${NANSEN_API_KEY}'],
    })).toBeNull();
    expect(extractInstalledKey('claude-desktop', { ...desktopEntry, args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL] })).toBeNull();
    expect(extractInstalledKey('claude-desktop', { ...desktopEntry, env: {} })).toBeNull();
    // npx execution overrides keep every required token but run another binary.
    for (const override of [['--package=evil-pkg', 'evil-bin'], ['-p', 'evil-pkg', 'evil-bin'], ['--call', 'evil-bin']]) {
      expect(extractInstalledKey('claude-desktop', { ...desktopEntry, args: [...override, ...desktopEntry.args] })).toBeNull();
    }
    expect(extractInstalledKey('claude-desktop', { ...desktopEntry, args: [{ evil: true }, ...desktopEntry.args] })).toBeNull();
    // env is npx's execution surface: npm_config_registry redirects where the
    // "pinned" package — and so the key's process — comes from.
    expect(extractInstalledKey('claude-desktop', {
      ...desktopEntry,
      env: { NANSEN_API_KEY: API_KEY, npm_config_registry: 'https://evil.example' },
    })).toBeNull();
    // An inline key is not the key verify would test, so it cannot be verified.
    expect(extractInstalledKey('claude-desktop', {
      ...desktopEntry,
      args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL, '--header', `NANSEN-API-KEY:${API_KEY}`],
    })).toBeNull();
    expect(extractInstalledKey('claude-desktop', {
      ...desktopEntry,
      args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL, '--other', 'NANSEN-API-KEY:${NANSEN_API_KEY}'],
    })).toBeNull();

    // Two spellings of the key header: the client may send the other one.
    expect(extractInstalledKey('cursor', {
      url: NANSEN_MCP_URL,
      headers: { 'NANSEN-API-KEY': API_KEY, 'nansen-api-key': 'wrong' },
    })).toBeNull();
    expect(extractInstalledKey('cursor', { url: NANSEN_MCP_URL, headers: 'NANSEN-API-KEY: k' })).toBeNull();
    // A second --header assignment wins in mcp-remote, so the client would send it.
    expect(extractInstalledKey('claude-desktop', {
      ...desktopEntry,
      args: [...desktopEntry.args, '--header', 'NANSEN-API-KEY:wrong'],
    })).toBeNull();

    expect(extractInstalledKey('cursor', null)).toBeNull();
    expect(extractInstalledKey('cursor', [])).toBeNull();
    expect(extractInstalledKey('vscode', buildServerEntry('cursor', API_KEY))).toBeNull();
  });

  it('resolves exact env refs, refuses near-misses, and treats empty env as unset', () => {
    const env = { NANSEN_API_KEY: API_KEY };
    expect(extractInstalledKey('claude-code', buildServerEntry('claude-code', API_KEY, { envRef: true }), { env }))
      .toBe(API_KEY);
    expect(extractInstalledKey('cursor', buildServerEntry('cursor', API_KEY, { envRef: true }), { env }))
      .toBe(API_KEY);
    expect(extractInstalledKey('claude-desktop', buildServerEntry('claude-desktop', API_KEY, { envRef: true }), { env }))
      .toBe(API_KEY);

    expect(extractInstalledKey('claude-code', {
      url: NANSEN_MCP_URL,
      headers: { 'NANSEN-API-KEY': '${NANSEN_API_KEY}:suffix' },
    }, { env })).toBeNull();
    expect(extractInstalledKey('cursor', {
      url: NANSEN_MCP_URL,
      headers: { 'NANSEN-API-KEY': CLAUDE_CODE_KEY_REF },
    }, { env })).toBeNull();
    const desktopNearMiss = buildServerEntry('claude-desktop', API_KEY);
    desktopNearMiss.env.NANSEN_API_KEY = '${OTHER_KEY}';
    expect(extractInstalledKey('claude-desktop', desktopNearMiss, { env })).toBeNull();

    const emptyEnv = { NANSEN_API_KEY: '' };
    for (const client of ['claude-code', 'cursor', 'claude-desktop']) {
      expect(extractInstalledKey(client, buildServerEntry(client, API_KEY, { envRef: true }), { env: emptyEnv })).toBeNull();
    }
  });

  it('names missing, changed, and extra fields without ever quoting a value', () => {
    for (const client of ['cursor', 'claude-code', 'claude-desktop']) {
      expect(entryDriftNotes(client, buildServerEntry(client, API_KEY))).toEqual([]);
      expect(entryDriftNotes(client, buildServerEntry(client, API_KEY, { envRef: true }))).toEqual([]);
    }
    expect(entryDriftNotes('claude-code', { url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': API_KEY } }))
      .toEqual(['missing "type"']);
    // A value change the client would choke on still warns, name-only.
    expect(entryDriftNotes('claude-code', { ...buildServerEntry('claude-code', API_KEY), type: 'stdio' }))
      .toEqual(['changed "type"']);
    expect(entryDriftNotes('claude-desktop', {
      ...buildServerEntry('claude-desktop', API_KEY),
      args: ['-y', MCP_REMOTE_PIN, `${NANSEN_MCP_URL}/`, '--header', 'NANSEN-API-KEY:${NANSEN_API_KEY}', '--debug'],
    })).toEqual(['changed "args"']);
    const notes = entryDriftNotes('cursor', {
      url: NANSEN_MCP_URL,
      note: 'mine',
      headers: { 'NANSEN-API-KEY': API_KEY, 'X-Edited': 'true' },
    });
    expect(notes).toEqual(['changed "headers"', 'unexpected "note"']);
    expect(notes.join(' ')).not.toContain(API_KEY);
    expect(entryDriftNotes('vscode', {})).toEqual([]);
    expect(entryDriftNotes('cursor', null)).toEqual([]);
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

  it('redacts the nansen credential in the backup when replacing an existing entry', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({
      mcpServers: { nansen: buildServerEntry('cursor', API_KEY), other: { command: 'foo' } },
      unrelated: true,
    }));

    await run(['install', 'cursor'], { flags: { 'env-ref': true } });

    const bakText = fs.readFileSync(`${cursorPath()}.bak`, 'utf8');
    expect(bakText).not.toContain(API_KEY);
    const bak = JSON.parse(bakText);
    expect(bak.mcpServers.nansen.headers['NANSEN-API-KEY']).toBe('<redacted>');
    expect(bak.mcpServers.other).toEqual({ command: 'foo' });
    expect(bak.unrelated).toBe(true);
    expect(fs.statSync(`${cursorPath()}.bak`).mode & 0o777).toBe(0o600);
    expect(readCursor().mcpServers.nansen.headers['NANSEN-API-KEY']).toBe(CURSOR_KEY_REF);
    expect(logs.join('\n')).toContain('Nansen credential redacted');
  });

  it('redacts an inline --header key in a hand-written desktop entry', async () => {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-bak-test-'));
    try {
      const desktopPath = resolveClientConfigPath('claude-desktop', { platform: 'darwin', homedir: desktopDir, env: {} });
      fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
      fs.writeFileSync(desktopPath, JSON.stringify({
        mcpServers: {
          nansen: { command: 'npx', args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL, '--header', `NANSEN-API-KEY:${API_KEY}`] },
        },
      }));
      const desktopLogs = [];
      const { mcp: desktopMcp } = buildMcpCommands({
        log: (...a) => desktopLogs.push(a.join(' ')), platform: 'darwin', homedirFn: () => desktopDir, env: {}, fetchFn,
      });

      await desktopMcp(['install', 'claude-desktop'], api, {}, {});

      const bakText = fs.readFileSync(`${desktopPath}.bak`, 'utf8');
      expect(bakText).not.toContain(API_KEY);
      expect(JSON.parse(bakText).mcpServers.nansen.args).toContain('NANSEN-API-KEY:<redacted>');
      expect(desktopLogs.join('\n')).toContain('Nansen credential redacted');
    } finally {
      fs.rmSync(desktopDir, { recursive: true, force: true });
    }
  });

  it('keeps an env-ref backup intact and claims no redaction it did not make', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({
      mcpServers: { nansen: buildServerEntry('cursor', undefined, { envRef: true }) },
    }));

    await run(['install', 'cursor']);

    const bak = JSON.parse(fs.readFileSync(`${cursorPath()}.bak`, 'utf8'));
    expect(bak.mcpServers.nansen.headers['NANSEN-API-KEY']).toBe(CURSOR_KEY_REF);
    expect(logs.join('\n')).toContain('Backed up existing config');
    expect(logs.join('\n')).not.toContain('redacted');
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

  it('installs env-ref entries while logged out in either flag position', async () => {
    for (const rawArgs of [
      ['install', '--env-ref', 'cursor'],
      ['install', 'cursor', '--env-ref'],
    ]) {
      const parsed = parseArgs(['mcp', ...rawArgs]);
      expect(parsed._).toEqual(['mcp', 'install', 'cursor']);
      expect(parsed.flags['env-ref']).toBe(true);
      await mcp(parsed._.slice(1), null, parsed.flags, parsed.options);
    }

    const config = readCursor();
    const entry = config.mcpServers.nansen;
    expect(entry.headers['NANSEN-API-KEY']).toBe(CURSOR_KEY_REF);
    expect(JSON.stringify(config)).not.toContain(API_KEY);
    expect(logs.join('\n')).toContain('client launch environment');
    expect(logs.join('\n')).toContain('Warning: NANSEN_API_KEY is not set in this shell');
    expect(logs.join('\n')).not.toContain(API_KEY);
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
    expect(logs.join('\n')).toContain('--env-ref');
    expect(logs.join('\n')).toContain('CREDENTIALS:');
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

  it('verifies env-ref entries from the injected environment and rejects unset refs', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({
      mcpServers: { nansen: buildServerEntry('cursor', API_KEY, { envRef: true }) },
    }));
    fetchFn.mockResolvedValue(response(successBody));

    const resolvedLogs = [];
    const { mcp: resolvedMcp } = buildMcpCommands({
      log: (...a) => resolvedLogs.push(a.join(' ')),
      platform: 'linux',
      homedirFn: () => tempDir,
      env: { NANSEN_API_KEY: API_KEY },
      fetchFn,
    });
    await resolvedMcp(['verify', 'cursor'], null, {}, {});
    expect(fetchFn.mock.calls[0][1].headers['NANSEN-API-KEY']).toBe(API_KEY);
    expect(resolvedLogs.join('\n')).not.toContain(API_KEY);

    fetchFn.mockClear();
    const error = await run(['verify', 'cursor'], { apiInstance: null }).then(() => null, err => err);
    expect(error?.message).toMatch(/references NANSEN_API_KEY, which is not set in this shell/);
    expect(error?.message).not.toContain(API_KEY);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects missing entries and relocated keys without a network call', async () => {
    await expect(run(['verify', 'cursor'])).rejects.toThrow(/not installed.*nansen mcp install cursor/);
    expect(fetchFn).not.toHaveBeenCalled();

    for (const entry of [
      { ...buildServerEntry('cursor', API_KEY), url: 'https://evil.example/mcp' },
      { ...buildServerEntry('cursor', API_KEY), command: 'sh', args: ['-c', 'leak'] },
      { url: NANSEN_MCP_URL, headers: {} },
    ]) {
      fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
      fs.writeFileSync(cursorPath(), JSON.stringify({ mcpServers: { nansen: entry } }));
      await expect(run(['verify', 'cursor'])).rejects.toThrow(/does not match the official server URL\/transport.*re-run install: nansen mcp install cursor/);
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

  it('names an unsupported credential reference instead of blaming the URL', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({
      mcpServers: { nansen: { url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': CLAUDE_CODE_KEY_REF } } },
    }));

    await expect(run(['verify', 'cursor']))
      .rejects.toThrow(/environment reference cursor does not expand there.*nansen mcp install cursor --env-ref/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('verifies an official entry with extra fields, warning instead of refusing', async () => {
    fetchFn.mockResolvedValue(response(successBody));
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({
      mcpServers: {
        nansen: {
          headers: { 'NANSEN-API-KEY': API_KEY, 'X-Edited': 'true' },
          url: NANSEN_MCP_URL,
          type: 'http',
        },
      },
    }));

    await run(['verify', 'cursor']);

    expect(fetchFn.mock.calls[0][0]).toBe(NANSEN_MCP_URL);
    expect(fetchFn.mock.calls[0][1].headers['NANSEN-API-KEY']).toBe(API_KEY);
    const out = logs.join('\n');
    expect(out).toMatch(/Warning: the cursor entry differs from what install writes.*changed "headers".*unexpected "type"/);
    expect(out).toContain('nansen mcp install cursor');
    expect(out).toContain('Authenticated MCP data call succeeded');
    expect(out).not.toContain(API_KEY);
  });

  // The live failure shape for a bad key: HTTP 200 with result.isError, not a 401.
  it('fails an HTTP 200 invalid-key result with exit 1 and no key disclosure', async () => {
    await run(['install', 'cursor']);
    logs.length = 0;
    fetchFn.mockResolvedValue(response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Error calling tool token_info: Invalid API key (status 401) for ${API_KEY}` }],
      },
    })));

    const error = await run(['verify', 'cursor']).then(() => null, (err) => err);
    expect(error?.code).toBe('MCP_VERIFY_FAILED');
    expect(error.message).toMatch(/API key was rejected/);
    expect(error.message).toContain('https://app.nansen.ai/account?tab=api');
    expect(error.message).toContain('nansen mcp install cursor');
    expect(error.message).not.toContain('<client>');
    expect(error.message).not.toContain(API_KEY);
    expect(logs.join('\n')).not.toContain(API_KEY);

    // Same response through the CLI: exit 1, guidance on stdout, key never shown.
    const { runCLI } = await import('../cli.js');
    const outputs = [];
    const exits = [];
    const result = await runCLI(['mcp', 'verify', 'cursor'], {
      output: (m) => outputs.push(String(m)),
      errorOutput: (m) => outputs.push(String(m)),
      exit: (code) => exits.push(code),
      log: (m) => outputs.push(String(m)),
      NansenAPIClass: function StubAPI() { return { apiKey: null }; },
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
      fetchFn,
    });

    expect(exits).toEqual([1]);
    expect(result.type).toBe('error');
    const rendered = outputs.join('\n');
    expect(rendered).toMatch(/API key was rejected/);
    expect(rendered).toContain('MCP_VERIFY_FAILED');
    expect(rendered).not.toContain(API_KEY);
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
    expect(schema.commands.mcp.subcommands.install.options['env-ref'].type).toBe('boolean');
    expect(schema.commands.mcp.subcommands.install.examples).toContain('nansen mcp install claude-code --env-ref');
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
