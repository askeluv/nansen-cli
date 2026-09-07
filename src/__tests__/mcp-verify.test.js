import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatMcpVerifyReport, runMcpVerifyChecks } from '../mcp-verify.js';
import { runCLI, SCHEMA } from '../cli.js';

const API_KEY = 'nk_test_1234567890abcdef';

function response(message, contentType = 'application/json', status = 200) {
  return {
    status,
    headers: { get: () => contentType },
    text: vi.fn().mockResolvedValue(typeof message === 'string' ? message : JSON.stringify(message)),
  };
}

function rpcResult(result, contentType = 'application/json') {
  return response({ jsonrpc: '2.0', id: 1, result }, contentType);
}

function rpcError(message, contentType = 'application/json', status = 200) {
  return response({ jsonrpc: '2.0', id: 1, error: message }, contentType, status);
}

function sse(message) {
  return response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, 'text/event-stream');
}

function listResponse(contentType = 'application/json') {
  const message = { tools: [{ name: 'nansen_score_top_tokens' }] };
  return contentType === 'text/event-stream' ? sse({ jsonrpc: '2.0', id: 1, result: message }) : rpcResult(message);
}

function authSuccessResponse(contentType = 'application/json') {
  const message = { content: [{ type: 'text', text: 'ok' }] };
  return contentType === 'text/event-stream' ? sse({ jsonrpc: '2.0', id: 1, result: message }) : rpcResult(message);
}

describe('remediation URLs (API-390)', () => {
  // The auth-failure and missing-key remediations must point at the key
  // MANAGEMENT view, not /auth/agent-setup: that page auto-mints a key on load
  // and is plan-capped (Free = 1), so a user who already has one either gets a
  // duplicate or a 403 -- a second failure on top of the one that sent them there.
  // Matches nansen-ra src/nansen_mcp/api/utils/common.py and the Kong 401 in
  // nansen-api kubernetes/nansen-api-wrapper/manifest.yaml.
  it('uses the key management URL and none of the rejected alternatives', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../mcp-verify.js', import.meta.url), 'utf8'));
    expect(src).toContain('https://app.nansen.ai/api?tab=api');
    expect(src).not.toContain('/account?tab=api');
    expect(src).not.toContain('/auth/agent-setup');
  });
});

describe('mcp verify', () => {
  let tempHome;
  let env;
  let devConfigPath;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-verify-test-'));
    env = { HOME: tempHome };
    devConfigPath = path.join(tempHome, 'missing-dev-config.json');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const runChecks = (fetchFn, overrides = {}) => runMcpVerifyChecks({
    apiKey: API_KEY,
    env,
    devConfigPath,
    fetchFn,
    ...overrides,
  });

  const findCheck = (checks, id) => checks.find(check => check.id === id);

  it('verifies an SSE-framed server and paid data call', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse('text/event-stream'))
      .mockResolvedValueOnce(authSuccessResponse('text/event-stream'));

    const checks = await runChecks(fetchFn);

    expect(findCheck(checks, 'mcp-server')).toMatchObject({ id: 'mcp-server', status: 'ok' });
    expect(findCheck(checks, 'mcp-auth')).toMatchObject({ id: 'mcp-auth', status: 'ok' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [listCall, authCall] = fetchFn.mock.calls;
    expect(listCall[1].headers).not.toHaveProperty('NANSEN-API-KEY');
    // The authenticated canary carries NANSEN-API-KEY; both calls must refuse
    // redirects so the key can't be relayed to a redirect target.
    expect(listCall[1].redirect).toBe('error');
    expect(authCall[1].redirect).toBe('error');
    expect(JSON.parse(authCall[1].body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'nansen_score_top_tokens', arguments: { request: {} } },
    });
    expect(authCall[1].headers['NANSEN-API-KEY']).toBe(API_KEY);
  });

  it('classifies 403 insufficient-credits as credits, not key rejection (Codier P1)', async () => {
    // The gateway maps 403 + "insufficient"/"credit" to CREDITS_EXHAUSTED. A
    // zero-balance user must not be told to create/rotate a key -- on
    // key-capped plans that remedy can itself fail.
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcError({ code: 403, message: 'Insufficient credits remaining for this request' }, 'application/json', 403));

    const checks = await runChecks(fetchFn);
    const auth = findCheck(checks, 'mcp-auth');
    expect(auth.status).toBe('error');
    expect(auth.message).toMatch(/insufficient credits/i);
    expect(auth.message).not.toMatch(/rejected the API key/i);
    expect(auth.fix).toMatch(/top up/i);
  });

  it('still classifies a bare 403 forbidden as key rejection', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcError({ code: 403, message: 'Forbidden' }, 'application/json', 403));

    const checks = await runChecks(fetchFn);
    expect(findCheck(checks, 'mcp-auth').message).toMatch(/rejected the API key/i);
  });

  it('keeps "credit rate limit" texts as a rate-limit warn, not credits', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcError({ code: 429, message: 'credit rate limit exceeded' }, 'application/json', 429));

    const checks = await runChecks(fetchFn);
    const auth = findCheck(checks, 'mcp-auth');
    expect(auth.status).toBe('warn');
    expect(auth.message).toMatch(/rate limited/i);
  });

  it('verifies a plain JSON response body', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(authSuccessResponse());

    const checks = await runChecks(fetchFn);

    expect(findCheck(checks, 'mcp-auth').status).toBe('ok');
  });

  it('skips the paid call when the key is missing', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(listResponse());
    const checks = await runChecks(fetchFn, { apiKey: null });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(findCheck(checks, 'mcp-api-key')).toMatchObject({ status: 'error' });
    expect(findCheck(checks, 'mcp-auth')).toMatchObject({ status: 'info' });
  });

  it.each([
    ['401 rejected key', 'failed with status 401: Unauthorized', 'error', /rejected the API key/, /exact key/],
    ['missing key response', 'NANSEN-API-KEY header is required', 'error', /rejected the API key/, /exact key/],
    ['402 credits', '402 Payment Required: insufficient credits', 'error', /insufficient credits/, /Top up/],
    ['429 rate limit', '429 Too Many Requests', 'warn', /rate limited/, /Retry/],
  ])('maps %s auth text to an actionable check', async (_name, text, status, message, fix) => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcResult({ isError: true, content: [{ type: 'text', text }] }));

    const check = findCheck(await runChecks(fetchFn), 'mcp-auth');

    expect(check.status).toBe(status);
    expect(check.message).toMatch(message);
    expect(check.fix).toMatch(fix);
  });

  it('does not verify the key on a malformed tools/call result', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcResult({ tools: [{ name: 'nansen_score_top_tokens' }] }));

    const check = findCheck(await runChecks(fetchFn), 'mcp-auth');

    expect(check.status).toBe('error');
    expect(check.message).toContain('malformed');
  });

  it('turns a network failure into a server check', async () => {
    const error = new Error('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    const fetchFn = vi.fn().mockRejectedValue(error);

    const checks = await runChecks(fetchFn);

    expect(findCheck(checks, 'mcp-server')).toMatchObject({ status: 'error' });
    expect(findCheck(checks, 'mcp-server').message).toContain('ECONNREFUSED');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('turns a hung request into a timeout check via the abort signal', async () => {
    const fetchFn = vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));

    const checks = await runChecks(fetchFn, { timeoutMs: 5 });

    expect(findCheck(checks, 'mcp-server')).toMatchObject({ status: 'error' });
    expect(findCheck(checks, 'mcp-server').message).toContain('timed out');
  });

  it('classifies a mixed credit/rate-limit text as a rate-limit warn, not a credits error', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcResult({
        isError: true,
        content: [{ type: 'text', text: 'Rate limit exceeded: credit rate limit reached, too many requests' }],
      }));

    const check = findCheck(await runChecks(fetchFn), 'mcp-auth');

    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/rate limited/);
  });

  it('classifies an HTTP 401 with a parseable error body as a rejected key', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcError({ code: -32603, message: 'nope' }, 'application/json', 401));

    const check = findCheck(await runChecks(fetchFn), 'mcp-auth');

    expect(check.status).toBe('error');
    expect(check.message).toMatch(/rejected the API key/);
  });

  it('parses an SSE message whose JSON-RPC id is a string', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sse({ jsonrpc: '2.0', id: '1', result: { tools: [] } }))
      .mockResolvedValueOnce(authSuccessResponse());

    const checks = await runChecks(fetchFn);

    expect(findCheck(checks, 'mcp-server').status).toBe('ok');
  });

  it('warns when a non-default URL will receive the API key', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(authSuccessResponse());

    const checks = await runChecks(fetchFn, { url: 'https://mcp.example.dev/ra/mcp' });

    expect(findCheck(checks, 'mcp-url')).toMatchObject({ status: 'warn' });
    expect(findCheck(checks, 'mcp-url').message).toContain('mcp.example.dev');
  });

  it('reports an unparseable server response', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response('<!doctype html>', 'text/html'));

    const checks = await runChecks(fetchFn);

    expect(findCheck(checks, 'mcp-server')).toMatchObject({ status: 'error' });
    expect(findCheck(checks, 'mcp-server').message).toContain('unexpected response');
  });

  it('reports a tools/list JSON-RPC failure and does not pay-call afterward', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(rpcError({ code: -32000, message: 'tools unavailable' }));

    const checks = await runChecks(fetchFn);

    expect(findCheck(checks, 'mcp-server')).toMatchObject({ status: 'error' });
    expect(findCheck(checks, 'mcp-server').message).toContain('tools unavailable');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('uses the custom URL and gives the explicit API-key option precedence', async () => {
    env.NANSEN_API_KEY = 'nk_env_1234567890abcdef';
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(authSuccessResponse());

    const checks = await runChecks(fetchFn, { apiKey: API_KEY, url: 'https://mcp.example.dev/ra/mcp' });

    expect(findCheck(checks, 'mcp-auth').status).toBe('ok');
    expect(fetchFn.mock.calls.every(([url]) => url === 'https://mcp.example.dev/ra/mcp')).toBe(true);
    expect(fetchFn.mock.calls[1][1].headers['NANSEN-API-KEY']).toBe(API_KEY);
  });

  describe('saved-key disclosure guard', () => {
    const SAVED_KEY = 'nk_saved_1234567890abcdef';

    it('withholds a saved key from a custom https URL without --send-api-key', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const fetchFn = vi.fn().mockResolvedValueOnce(listResponse());

      const checks = await runChecks(fetchFn, { apiKey: undefined, url: 'https://mcp.evil.example/ra/mcp' });

      expect(findCheck(checks, 'mcp-url')).toMatchObject({ status: 'error' });
      expect(findCheck(checks, 'mcp-url').message).toContain('withheld');
      expect(findCheck(checks, 'mcp-auth').status).toBe('info');
      // Only the unauthenticated tools/list ran; no authenticated tools/call.
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls.every(([, opts]) => !opts.headers['NANSEN-API-KEY'])).toBe(true);
    });

    it('withholds a saved key even from a loopback URL without --send-api-key', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const fetchFn = vi.fn().mockResolvedValueOnce(listResponse());

      const checks = await runChecks(fetchFn, { apiKey: undefined, url: 'http://127.0.0.1:8787/ra/mcp' });

      expect(findCheck(checks, 'mcp-url')).toMatchObject({ status: 'error' });
      expect(findCheck(checks, 'mcp-url').message).toContain('withheld');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('sends a saved key to a custom https URL when --send-api-key is given', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce(authSuccessResponse());

      const checks = await runChecks(fetchFn, {
        apiKey: undefined,
        url: 'https://mcp.example.dev/ra/mcp',
        sendApiKey: true,
      });

      expect(findCheck(checks, 'mcp-url').status).toBe('warn');
      expect(findCheck(checks, 'mcp-auth').status).toBe('ok');
      expect(fetchFn.mock.calls[1][1].headers['NANSEN-API-KEY']).toBe(SAVED_KEY);
    });

    it('allows a saved key over http to a loopback host with --send-api-key', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce(authSuccessResponse());

      const checks = await runChecks(fetchFn, {
        apiKey: undefined,
        url: 'http://localhost:8787/ra/mcp',
        sendApiKey: true,
      });

      expect(findCheck(checks, 'mcp-auth').status).toBe('ok');
      expect(fetchFn.mock.calls[1][1].headers['NANSEN-API-KEY']).toBe(SAVED_KEY);
    });

    it('refuses to send any key over plain HTTP to a non-loopback host, even with --send-api-key', async () => {
      // Uses the explicit API_KEY (runChecks default): the HTTPS hard block
      // applies to every key, not just saved ones.
      const fetchFn = vi.fn().mockResolvedValueOnce(listResponse());

      const checks = await runChecks(fetchFn, { url: 'http://mcp.example.dev/ra/mcp', sendApiKey: true });

      expect(findCheck(checks, 'mcp-url')).toMatchObject({ status: 'error' });
      expect(findCheck(checks, 'mcp-url').message).toMatch(/plain HTTP/i);
      expect(findCheck(checks, 'mcp-auth').status).toBe('info');
      expect(fetchFn.mock.calls.every(([, opts]) => !opts.headers['NANSEN-API-KEY'])).toBe(true);
    });

    it('still sends an explicit --api-key to a custom https URL without --send-api-key', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce(authSuccessResponse());

      // apiKey defaults to the explicit API_KEY in runChecks.
      const checks = await runChecks(fetchFn, { url: 'https://mcp.example.dev/ra/mcp' });

      expect(findCheck(checks, 'mcp-auth').status).toBe('ok');
      expect(fetchFn.mock.calls[1][1].headers['NANSEN-API-KEY']).toBe(API_KEY);
    });

    it('withholds the key from an unparseable or non-https custom URL (fail-safe)', async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(listResponse());

      // An invalid IPv4 octet is rejected by URL parsing, so this exercises the
      // fail-safe path rather than being (wrongly) classified as loopback.
      const checks = await runChecks(fetchFn, { url: 'http://127.999.999.999:8787/ra/mcp', sendApiKey: true });

      expect(findCheck(checks, 'mcp-url')).toMatchObject({ status: 'error' });
      expect(findCheck(checks, 'mcp-url').message).toMatch(/unsupported MCP URL/i);
      expect(fetchFn.mock.calls.every(([, opts]) => !opts.headers['NANSEN-API-KEY'])).toBe(true);
    });

    it('rejects `--send-api-key false` instead of authorizing on flag presence', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const output = [];
      const fetchFn = vi.fn();

      const result = await runCLI(
        ['mcp', 'verify', '--json', '--url', 'https://mcp.example.dev/ra/mcp', '--send-api-key', 'false'],
        {
          output: value => output.push(value),
          errorOutput: () => {},
          exit: vi.fn(),
          NansenAPIClass: class {},
          fetchFn,
          env,
          devConfigPath,
          isTTY: false,
        },
      );

      expect(result.type).toBe('error');
      // The command must fail before any network call, so the key is never sent.
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('threads --send-api-key through the CLI to authorize a saved key', async () => {
      env.NANSEN_API_KEY = SAVED_KEY;
      const output = [];
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(listResponse())
        .mockResolvedValueOnce(authSuccessResponse());

      const result = await runCLI(
        ['mcp', 'verify', '--json', '--url', 'https://mcp.example.dev/ra/mcp', '--send-api-key'],
        {
          output: value => output.push(value),
          errorOutput: () => {},
          exit: vi.fn(),
          NansenAPIClass: class {},
          fetchFn,
          env,
          devConfigPath,
          isTTY: false,
        },
      );

      expect(result.type).not.toBe('error');
      expect(fetchFn.mock.calls[1][1].headers['NANSEN-API-KEY']).toBe(SAVED_KEY);
    });
  });

  it('formats a report with check lines, fixes, and the verification summary', () => {
    const report = formatMcpVerifyReport([
      { id: 'mcp-api-key', status: 'ok', message: 'API key found (nk_t…cdef)' },
      { id: 'mcp-auth', status: 'ok', message: 'Authenticated MCP data call succeeded (~1 credit consumed).' },
    ], 'https://mcp.example.dev/ra/mcp', true);

    expect(report).toContain('Nansen MCP verify — https://mcp.example.dev/ra/mcp');
    expect(report).toContain('✓ API key found');
    expect(report).toContain('Verified:');
    expect(report).toContain('NANSEN-API-KEY header');
  });

  it('wires mcp verify JSON failures through the non-zero CLI error envelope', async () => {
    const output = [];
    const exits = [];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcResult({
        isError: true,
        content: [{ type: 'text', text: 'failed with status 401: Unauthorized' }],
      }));
    const originalCI = process.env.CI;
    process.env.CI = '1';
    try {
      const result = await runCLI(['mcp', 'verify', '--json', '--api-key', API_KEY], {
        output: value => output.push(value),
        errorOutput: () => {},
        exit: code => exits.push(code),
        NansenAPIClass: class {},
        fetchFn,
        env,
        devConfigPath,
        isTTY: false,
      });

      expect(result.type).toBe('error');
      expect(exits).toEqual([1]);
      expect(output).toHaveLength(1);
      const envelope = JSON.parse(output[0]);
      expect(envelope).toMatchObject({ success: false, code: 'MCP_VERIFY_FAILED' });
      expect(envelope.details.verified).toBe(false);
      expect(envelope.details.checks.find(check => check.id === 'mcp-auth').status).toBe('error');
    } finally {
      if (originalCI === undefined) delete process.env.CI;
      else process.env.CI = originalCI;
    }
  });

  it('non-JSON failure prints the report once, no JSON envelope (Codier P2)', async () => {
    const output = [];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcError({ code: 401, message: 'Invalid API key' }, 'application/json', 401));

    const result = await runCLI(['mcp', 'verify', '--api-key', API_KEY], {
      output: value => output.push(value),
      log: value => output.push(value),
      exit: vi.fn(),
      fetchFn,
      env,
      isTTY: true,
    });

    const text = output.join('\n');
    expect(result.type).toBe('error');
    expect(text).toMatch(/Nansen MCP verify — /);            // the human report header
    expect(text).toMatch(/MCP setup is not verified/);        // and its verdict line
    expect(text).not.toContain('"success": false');          // no envelope (pretty)
    expect(text).not.toContain('"success":false');           // no envelope (compact)
    expect(text).not.toContain('MCP_VERIFY_FAILED');         // envelope code never printed
  });

  it('--json failure still emits exactly the envelope, no human report (P2 counterpart)', async () => {
    const output = [];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(rpcError({ code: 401, message: 'Invalid API key' }, 'application/json', 401));

    await runCLI(['mcp', 'verify', '--json', '--api-key', API_KEY], {
      output: value => output.push(value),
      log: value => output.push(value),
      exit: vi.fn(),
      fetchFn,
      env,
      isTTY: true,
    });

    const text = output.join('\n');
    expect(text).toContain('MCP_VERIFY_FAILED');
    expect(text).not.toMatch(/✗|✓/);                          // no human report glyphs
  });

  it('rejects a repeated --url instead of fetching a joined string (Codier P3)', async () => {
    const output = [];
    const fetchFn = vi.fn();
    const result = await runCLI(['mcp', 'verify', '--api-key', API_KEY, '--url', 'https://a.example/mcp', '--url', 'https://b.example/mcp'], {
      output: value => output.push(value),
      exit: vi.fn(),
      fetchFn,
      env,
      isTTY: true,
    });

    expect(result.type).toBe('error');
    expect(output.join('\n')).toMatch(/--url must be a single URL string/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a valueless --url instead of silently using the default (Codier P3)', async () => {
    const output = [];
    const fetchFn = vi.fn();
    const result = await runCLI(['mcp', 'verify', '--api-key', API_KEY, '--url'], {
      output: value => output.push(value),
      exit: vi.fn(),
      fetchFn,
      env,
      isTTY: true,
    });

    expect(result.type).toBe('error');
    expect(output.join('\n')).toMatch(/--url requires a value/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a valueless --api-key instead of falling back to a saved key', async () => {
    const output = [];
    const exits = [];
    const fetchFn = vi.fn();
    const result = await runCLI(['mcp', 'verify', '--api-key'], {
      output: value => output.push(value),
      errorOutput: () => {},
      exit: code => exits.push(code),
      NansenAPIClass: class {},
      fetchFn,
      env,
      devConfigPath,
      isTTY: false,
    });

    expect(result.type).toBe('error');
    expect(exits).toEqual([1]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--api-key requires a value');
  });

  it('rejects a non-string --api-key value such as the literal null', async () => {
    const output = [];
    const exits = [];
    const fetchFn = vi.fn();
    const result = await runCLI(['mcp', 'verify', '--api-key', 'null'], {
      output: value => output.push(value),
      errorOutput: () => {},
      exit: code => exits.push(code),
      NansenAPIClass: class {},
      fetchFn,
      env,
      devConfigPath,
      isTTY: false,
    });

    expect(result.type).toBe('error');
    expect(exits).toEqual([1]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--api-key must be a single key string');
  });

  it('documents the mcp verify command in the schema', () => {
    expect(SCHEMA.commands.mcp.subcommands.verify.options).toEqual(expect.objectContaining({
      'api-key': expect.any(Object),
      url: expect.any(Object),
      json: expect.any(Object),
    }));
  });
});
