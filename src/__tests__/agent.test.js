/**
 * Agent command tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAgentCommands, consumeSSEStream } from '../commands/agent.js';
import { NansenError, ErrorCode } from '../api.js';

// ── Helpers ──

/** Create a mock ReadableStream from SSE string chunks. */
function mockSSEBody(chunks) {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield encoder.encode(chunk);
      }
    },
  };
}

/** Build a mock Response with an SSE body. */
function mockSSEResponse(sseText) {
  const chunks = Array.isArray(sseText) ? sseText : [sseText];
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: mockSSEBody(chunks),
  };
}

/** Build a mock apiInstance. */
function mockApi(overrides = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.nansen.ai',
    defaultHeaders: {},
    ...overrides,
  };
}

// ── Tests ──

describe('agent command', () => {
  let log, errorLog, write, cmd;

  afterEach(() => { vi.restoreAllMocks(); });

  beforeEach(() => {
    log = vi.fn();
    errorLog = vi.fn();
    write = vi.fn();
    cmd = buildAgentCommands({ log, errorLog, write })['agent'];
  });

  // ── Help output ──

  describe('help output', () => {
    it('shows help with no args', async () => {
      await cmd([], mockApi(), {}, {});
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('nansen agent');
      expect(log.mock.calls[0][0]).toContain('USAGE');
    });

    it('shows help with --help flag', async () => {
      await cmd([], mockApi(), { help: true }, {});
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('nansen agent');
    });

    it('shows help with "help" subcommand', async () => {
      await cmd(['help'], mockApi(), {}, {});
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('nansen agent');
    });
  });

  // ── Auth guard ──

  describe('auth guard', () => {
    it('throws UNAUTHORIZED when no API key', async () => {
      const api = mockApi({ apiKey: null });
      await expect(cmd(['test question'], api, {}, {}))
        .rejects.toThrow('Not logged in. Run: nansen login');
    });

    it('throws with correct error code', async () => {
      const api = mockApi({ apiKey: '' });
      try {
        await cmd(['test question'], api, {}, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
        expect(err.status).toBe(401);
      }
    });
  });

  // ── Flag handling ──

  describe('flag handling', () => {
    it('--expert sets expert endpoint', async () => {
      const api = mockApi();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], api, { expert: true }, {});

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0];
      expect(url).toContain('/api/v1/agent/expert');
    });

    it('defaults to fast endpoint without --expert', async () => {
      const api = mockApi();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], api, {}, {});

      const url = fetchSpy.mock.calls[0][0];
      expect(url).toContain('/api/v1/agent/fast');
    });
  });

  // ── --conversation-id validation ──

  describe('conversation-id validation', () => {
    it('uses provided valid UUID conversation-id', async () => {
      const api = mockApi();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], api, {}, { 'conversation-id': '550e8400-e29b-41d4-a716-446655440000' });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.conversation_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('rejects non-UUID conversation-id', async () => {
      await expect(cmd(['test'], mockApi(), {}, { 'conversation-id': 'my-conv-123' }))
        .rejects.toThrow('Invalid --conversation-id');
    });

    it('falls back to UUID when conversation-id is empty string', async () => {
      const api = mockApi();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], api, {}, { 'conversation-id': '' });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.conversation_id).toMatch(/^[0-9a-f]{8}-/);
    });
  });

  // ── --json output ──

  describe('--json output', () => {
    it('returns structured JSON object', async () => {
      const api = mockApi();
      const sseData = [
        'data: {"type":"delta","text":"Hello "}\n\n',
        'data: {"type":"tool_call","name":"search"}\n\n',
        'data: {"type":"delta","text":"world"}\n\n',
        'data: {"type":"finish","conversation_id":"conv-42"}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse(sseData)
      );

      const result = await cmd(['test'], api, { json: true }, {});

      expect(result).toEqual({
        conversation_id: 'conv-42',
        mode: 'fast',
        text: 'Hello world',
        tool_calls: ['search'],
      });
    });

    it('returns expert mode in JSON output', async () => {
      const api = mockApi();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      const result = await cmd(['test'], api, { json: true, expert: true }, {});
      expect(result.mode).toBe('expert');
    });
  });

  // ── HTTP error responses ──

  describe('HTTP error responses', () => {
    it('throws UNAUTHORIZED on 401', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'API key required' }),
      });

      try {
        await cmd(['test'], mockApi(), {}, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.message).toBe('Not logged in. Run: nansen login');
        expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
      }
    });

    it('throws RATE_LIMITED on 429', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'Too many requests' }),
      });

      try {
        await cmd(['test'], mockApi(), {}, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.message).toBe('Rate limited. Try again in a few seconds.');
        expect(err.code).toBe(ErrorCode.RATE_LIMITED);
      }
    });

    it('extracts detail from 500 JSON body', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'Internal agent failure' }),
      });

      try {
        await cmd(['test'], mockApi(), {}, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.code).toBe(ErrorCode.SERVER_ERROR);
        expect(err.details.detail).toBe('Internal agent failure');
      }
    });
  });

  // ── Network error ──

  describe('network error', () => {
    it('throws NETWORK_ERROR when fetch rejects', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      try {
        await cmd(['test'], mockApi(), {}, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.code).toBe(ErrorCode.NETWORK_ERROR);
        expect(err.message).toContain('ECONNREFUSED');
      }
    });
  });

  // ── Streaming output ──

  describe('streaming output', () => {
    function mockSSEStream(events) {
      const encoder = new TextEncoder();
      const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    }

    it('streams text and tool calls to stdout', async () => {
      const api = mockApi();
      const sseEvents = [
        { type: 'delta', text: 'Hello ' },
        { type: 'tool_call', name: 'token_search' },
        { type: 'delta', text: 'world' },
        { type: 'finish', conversation_id: 'conv-stream' },
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: mockSSEStream(sseEvents),
      });

      await cmd(['test question'], api, {}, {});

      // write receives the delta text chunks
      expect(write).toHaveBeenCalledWith('Hello ');
      expect(write).toHaveBeenCalledWith('world');

      // errorLog receives tool call names with ⚙ prefix (stderr)
      expect(errorLog).toHaveBeenCalledWith('⚙ token_search');

      // errorLog receives conversation continuation hint (stderr)
      const allErrorCalls = errorLog.mock.calls.map(c => c[0]);
      expect(allErrorCalls.some(c => c.includes('nansen agent') && c.includes('conv-stream'))).toBe(true);
    });

    it('does not emit a blank line between consecutive tool calls separated by a newline delta', async () => {
      const api = mockApi();
      const sseEvents = [
        { type: 'tool_call', name: 'token_ohlcv' },
        { type: 'delta', text: '\n' },
        { type: 'tool_call', name: 'token_current_top_holders' },
        { type: 'finish', conversation_id: 'conv-tools' },
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: mockSSEStream(sseEvents),
      });

      await cmd(['test question'], api, {}, {});

      // The newline delta between tool calls must be suppressed
      expect(write).not.toHaveBeenCalledWith('\n');
      expect(errorLog).toHaveBeenCalledWith('⚙ token_ohlcv');
      expect(errorLog).toHaveBeenCalledWith('⚙ token_current_top_holders');
    });
  });

  // ── Timeout ──

  describe('timeout', () => {
    it('throws TIMEOUT on AbortError for fast mode', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

      try {
        await cmd(['test'], mockApi(), {}, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.code).toBe(ErrorCode.TIMEOUT);
        expect(err.message).toContain('120s');
      }
    });

    it('throws TIMEOUT with 300s for expert mode', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

      try {
        await cmd(['test'], mockApi(), { expert: true }, {});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.code).toBe(ErrorCode.TIMEOUT);
        expect(err.message).toContain('300s');
      }
    });

    it('passes AbortController signal to fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], mockApi(), {}, {});

      const fetchOptions = fetchSpy.mock.calls[0][1];
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── Conversation ID validation ──

  describe('conversation-id strict UUID validation', () => {
    it('throws INVALID_PARAMS when conversation-id is not a UUID', async () => {
      try {
        await cmd(['test'], mockApi(), {}, { 'conversation-id': 'what are the top tokens' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NansenError);
        expect(err.code).toBe(ErrorCode.INVALID_PARAMS);
        expect(err.message).toContain('Invalid --conversation-id');
      }
    });

    it('throws for non-UUID strings like "abc-123"', async () => {
      await expect(cmd(['test'], mockApi(), {}, { 'conversation-id': 'abc-123-def' }))
        .rejects.toThrow('Invalid --conversation-id');
    });

    it('accepts a valid UUID v4', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], mockApi(), {}, { 'conversation-id': '550e8400-e29b-41d4-a716-446655440000' });

      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.conversation_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('accepts uppercase UUIDs', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], mockApi(), {}, { 'conversation-id': '550E8400-E29B-41D4-A716-446655440000' });

      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.conversation_id).toBe('550E8400-E29B-41D4-A716-446655440000');
    });
  });

  // ── No response goes to stderr ──

  describe('no response output', () => {
    it('sends "(no response from agent)" to stdout', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockSSEResponse('data: {"type":"finish","conversation_id":"c1"}\n\ndata: [DONE]\n\n')
      );

      await cmd(['test'], mockApi(), {}, {});

      expect(log).toHaveBeenCalledWith('(no response from agent)');
    });
  });
});

// ── consumeSSEStream tests ──

describe('consumeSSEStream', () => {
  it('collects delta text chunks', async () => {
    const response = mockSSEResponse([
      'data: {"type":"delta","text":"Hello "}\n\ndata: {"type":"delta","text":"world"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const result = await consumeSSEStream(response);
    expect(result.text).toBe('Hello world');
  });

  it('collects tool calls', async () => {
    const response = mockSSEResponse([
      'data: {"type":"tool_call","name":"token_search"}\n\n',
      'data: {"type":"tool_call","name":"wallet_profiler"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const result = await consumeSSEStream(response);
    expect(result.toolCalls).toEqual(['token_search', 'wallet_profiler']);
  });

  it('captures conversation_id from finish event', async () => {
    const response = mockSSEResponse(
      'data: {"type":"finish","conversation_id":"abc-123"}\n\ndata: [DONE]\n\n'
    );
    const result = await consumeSSEStream(response);
    expect(result.conversationId).toBe('abc-123');
  });

  it('throws on error event', async () => {
    const response = mockSSEResponse(
      'data: {"type":"error","error":"Something broke","status_code":500}\n\ndata: [DONE]\n\n'
    );
    await expect(consumeSSEStream(response)).rejects.toThrow();
  });

  it('invokes onDelta callback for each text chunk', async () => {
    const onDelta = vi.fn();
    const response = mockSSEResponse([
      'data: {"type":"delta","text":"A"}\n\n',
      'data: {"type":"delta","text":"B"}\n\n',
      'data: [DONE]\n\n',
    ]);
    await consumeSSEStream(response, { onDelta });
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onDelta).toHaveBeenCalledWith('A');
    expect(onDelta).toHaveBeenCalledWith('B');
  });

  it('invokes onToolCall callback', async () => {
    const onToolCall = vi.fn();
    const response = mockSSEResponse(
      'data: {"type":"tool_call","name":"lookup"}\n\ndata: [DONE]\n\n'
    );
    await consumeSSEStream(response, { onToolCall });
    expect(onToolCall).toHaveBeenCalledWith('lookup');
  });

  it('handles [DONE] correctly and stops processing', async () => {
    // After [DONE], no more events should be processed
    const onDelta = vi.fn();
    const response = mockSSEResponse(
      'data: {"type":"delta","text":"before"}\n\ndata: [DONE]\n\ndata: {"type":"delta","text":"after"}\n\n'
    );
    const result = await consumeSSEStream(response, { onDelta });
    expect(result.text).toBe('before');
    expect(onDelta).toHaveBeenCalledTimes(1);
  });

  it('handles partial SSE frames across chunks', async () => {
    const response = mockSSEResponse([
      'data: {"type":"del',
      'ta","text":"split"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const result = await consumeSSEStream(response);
    expect(result.text).toBe('split');
  });

  it('skips non-data lines', async () => {
    const response = mockSSEResponse(
      'event: message\ndata: {"type":"delta","text":"ok"}\n\ndata: [DONE]\n\n'
    );
    const result = await consumeSSEStream(response);
    expect(result.text).toBe('ok');
  });

  it('handles \\r\\n line endings in SSE frames', async () => {
    const response = mockSSEResponse([
      'data: {"type":"delta","text":"crlf"}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]);
    const result = await consumeSSEStream(response);
    expect(result.text).toBe('crlf');
  });

  it('handles mixed \\r\\n and \\n line endings', async () => {
    const response = mockSSEResponse([
      'data: {"type":"delta","text":"mixed"}\r\n\r\ndata: {"type":"finish","conversation_id":"m1"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const result = await consumeSSEStream(response);
    expect(result.text).toBe('mixed');
    expect(result.conversationId).toBe('m1');
  });

  it('skips malformed JSON gracefully', async () => {
    const response = mockSSEResponse(
      'data: {not json}\n\ndata: {"type":"delta","text":"ok"}\n\ndata: [DONE]\n\n'
    );
    const result = await consumeSSEStream(response);
    expect(result.text).toBe('ok');
  });
});
