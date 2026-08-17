/**
 * Tests for `nansen mcp install/uninstall` (src/commands/mcp.js).
 * House pattern: real temp dir + injected deps, no fs mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
} from '../commands/mcp.js';

const API_KEY = 'test-key-123';

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
    expect(entry.args).toContain(`NANSEN-API-KEY:${API_KEY}`);
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

describe('mcp command handler', () => {
  let tempDir;
  let logs;
  let mcp;
  const api = { apiKey: API_KEY };

  const run = (args, { flags = {}, apiInstance = api } = {}) => mcp(args, apiInstance, flags, {});
  const cursorPath = () => path.join(tempDir, '.cursor', 'mcp.json');
  const readCursor = () => JSON.parse(fs.readFileSync(cursorPath(), 'utf8'));

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-test-'));
    logs = [];
    ({ mcp } = buildMcpCommands({
      log: (...a) => logs.push(a.join(' ')),
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
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
});

describe('schema + CLI registration', () => {
  it('schema.json documents mcp install/uninstall', async () => {
    const { fileURLToPath } = await import('url');
    const schema = JSON.parse(fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.json'), 'utf8'));
    expect(Object.keys(schema.commands)).toContain('mcp');
    expect(Object.keys(schema.commands.mcp.subcommands).sort()).toEqual(['install', 'uninstall']);
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
});
