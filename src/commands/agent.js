/**
 * Nansen CLI - Agent command
 * Interactive research agent with fast/expert modes via SSE streaming.
 */

import crypto from 'crypto';
import { NansenError, ErrorCode, statusToErrorCode, telemetryHeaders, packageVersion } from '../api.js';
import { getCostForEndpoint } from '../cost-cache.js';

/**
 * Build standard request headers, matching apiInstance.request() conventions.
 */
function buildHeaders(apiInstance) {
  return {
    'Content-Type': 'application/json',
    'X-Client-Type': 'nansen-cli',
    'X-Client-Version': packageVersion,
    ...telemetryHeaders(),
    ...(apiInstance.apiKey ? { 'apikey': apiInstance.apiKey } : {}),
    ...(apiInstance.defaultHeaders || {}),
  };
}

/**
 * Throw a NansenError with the same structure as apiInstance.request() errors.
 * Includes `details` field for consistency with other commands.
 */
function throwApiError(message, status, serverDetail) {
  // Match the friendly wrapper messages from apiInstance.request()
  let friendlyMessage = message;
  if (status === 401) {
    friendlyMessage = 'Not logged in. Run: nansen login';
  } else if (status === 429) {
    friendlyMessage = 'Rate limited. Try again in a few seconds.';
  }

  throw new NansenError(
    friendlyMessage,
    statusToErrorCode(status),
    status,
    { detail: serverDetail || message, attempt: 1, retryAfterMs: null },
  );
}

/**
 * Process an SSE response from the agent endpoint.
 *
 * In buffered mode (no callbacks), collects everything and returns it.
 * In streaming mode (callbacks provided), invokes them as events arrive.
 *
 * @param {Response} response   – fetch Response with SSE body
 * @param {object}   [callbacks]
 * @param {Function} [callbacks.onDelta]    – called with each text chunk
 * @param {Function} [callbacks.onToolCall] – called with each tool name
 * @returns {{ text: string, toolCalls: string[], conversationId: string|null }}
 */
export async function consumeSSEStream(response, callbacks = {}) {
  const { onDelta, onToolCall } = callbacks;
  const chunks = [];
  const toolCalls = [];
  let conversationId = null;
  let errorPayload = null;

  const reader = response.body;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const raw of reader) {
    buffer += decoder.decode(raw, { stream: true });

    // Normalize \r\n and \r to \n (SSE spec allows all three line terminators)
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // SSE: split on double-newline boundaries
    let boundary;
    let done = false;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') { done = true; break; }

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'delta':
            if (event.text) {
              chunks.push(event.text);
              if (onDelta) onDelta(event.text);
            }
            break;
          case 'tool_call':
            if (event.name) {
              toolCalls.push(event.name);
              if (onToolCall) onToolCall(event.name);
            }
            break;
          case 'finish':
            conversationId = event.conversation_id ?? null;
            break;
          case 'error':
            errorPayload = event;
            break;
        }
      }
      if (done) break;
    }
    if (done) break;
  }

  if (errorPayload) {
    const status = errorPayload.status_code || 502;
    throwApiError(
      errorPayload.error || 'Agent request failed',
      status,
      errorPayload.error,
    );
  }

  return { text: chunks.join(''), toolCalls, conversationId };
}

/**
 * Build the `agent` command handler.
 *
 * @param {object} [deps]
 * @param {Function} [deps.log]      – stdout line output (default: console.log)
 * @param {Function} [deps.errorLog] – stderr line output (default: console.error)
 * @param {Function} [deps.write]    – raw stdout writer, no trailing newline (default: process.stdout.write)
 * @returns {object} command map
 */
export function buildAgentCommands(deps = {}) {
  const {
    log = console.log,
    errorLog = console.error,
    write = (s) => process.stdout.write(s),
  } = deps;

  return {
    'agent': async (args, apiInstance, flags, options) => {
      // ── Help ──
      if (flags.help || flags.h || args[0] === 'help' || args.length === 0) {
        const fmtCost = (c) => `${c.free} credit${c.free === 1 ? '' : 's'} (Free tier) / ${c.pro} credit${c.pro === 1 ? '' : 's'} (Pro tier)`;
        const fastCost = getCostForEndpoint('/api/v1/agent/fast');
        const expertCost = getCostForEndpoint('/api/v1/agent/expert');
        const costSection = (fastCost || expertCost)
          ? `\nCOST:\n${fastCost ? `  fast:   ${fmtCost(fastCost)}\n` : ''}${expertCost ? `  expert: ${fmtCost(expertCost)}\n` : ''}`
          : '';
        log(`nansen agent — Nansen Research Agent

Ask the Nansen AI agent research questions about crypto wallets, tokens,
smart money flows, and on-chain activity. The agent uses Nansen's full
data platform to answer your questions.

MODES:
  fast      Faster responses, best for simple lookups (default)
  expert    Deeper analysis, uses a more capable model

USAGE:
  nansen agent "<question>"
  nansen agent "<question>" --expert
  nansen agent "<question>" --conversation-id <id>

OPTIONS:
  --expert                     Use expert mode (default: fast)
  --conversation-id <uuid>     Continue a previous conversation (UUID v4)
  --json                       Output raw JSON instead of formatted text
${costSection}
CONVERSATION FLOW:
  Each request generates a UUID v4 conversation ID. To continue a
  multi-turn conversation, pass it back with --conversation-id. The ID
  and a ready-to-copy follow-up command are printed to stderr after each
  response.

EXAMPLES:
  nansen agent "What are the top smart money inflows on Ethereum today?"
  nansen agent "Show me the largest whale wallets on Solana"
  nansen agent "Analyze wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" --expert
  nansen agent "Tell me more about their DeFi positions" --conversation-id 550e8400-e29b-41d4-a716-446655440000`);
        return;
      }

      // ── Parse question ──
      const question = args.join(' ').trim();
      if (!question) {
        throw new NansenError(
          'Query cannot be empty. Usage: nansen agent "<question>"',
          ErrorCode.INVALID_PARAMS,
          null,
          { detail: 'Empty query string' },
        );
      }

      // ── Mode ──
      const expert = !!flags.expert;
      const endpoint = expert ? '/api/v1/agent/expert' : '/api/v1/agent/fast';
      const modeName = expert ? 'expert' : 'fast';

      // ── Conversation ID (must be UUID v4) ──
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const rawConvId = options['conversation-id'];
      let conversationId;
      if (typeof rawConvId === 'string' && rawConvId) {
        if (!UUID_RE.test(rawConvId)) {
          throw new NansenError(
            `Invalid --conversation-id: expected a UUID (e.g. 550e8400-e29b-41d4-a716-446655440000), got "${rawConvId.slice(0, 60)}${rawConvId.length > 60 ? '...' : ''}"`,
            ErrorCode.INVALID_PARAMS,
            null,
            { detail: 'conversation-id must be a UUID v4' },
          );
        }
        conversationId = rawConvId;
      } else {
        conversationId = crypto.randomUUID();
      }

      // ── Auth guard ──
      if (!apiInstance.apiKey) {
        throw new NansenError(
          'Not logged in. Run: nansen login',
          ErrorCode.UNAUTHORIZED,
          401,
          { detail: 'No API key configured' },
        );
      }

      // ── Request (no retry — SSE streams are not idempotent) ──
      const url = `${apiInstance.baseUrl}${endpoint}`;
      const body = {
        text: question,
        conversation_id: conversationId,
      };

      // ── Timeout ──
      const timeoutMs = expert ? 300_000 : 120_000; // 5min expert, 2min fast
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(apiInstance),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new NansenError(
            `Request timed out after ${timeoutMs / 1000}s`,
            ErrorCode.TIMEOUT,
            504,
            { detail: `${modeName} mode timeout (${timeoutMs / 1000}s)` },
          );
        }
        throw new NansenError(
          `Network error: ${err.message}`,
          ErrorCode.NETWORK_ERROR,
          null,
          { originalError: err.message },
        );
      }

      if (!response.ok) {
        clearTimeout(timer);
        let serverDetail;
        if (response.headers.get('content-type')?.includes('application/json')) {
          try {
            const errData = await response.json();
            serverDetail = errData.detail || errData.message;
          } catch { /* ignore parse failure */ }
        }
        throwApiError(
          serverDetail || `Agent returned ${response.status}`,
          response.status,
          serverDetail,
        );
      }

      // ── JSON mode: buffer everything, return structured data ──
      if (flags.json) {
        let result;
        try {
          result = await consumeSSEStream(response);
        } finally {
          clearTimeout(timer);
        }
        return {
          conversation_id: result.conversationId || conversationId,
          mode: modeName,
          text: result.text,
          tool_calls: result.toolCalls,
        };
      }

      // ── Streaming output mode ──
      let hasOutput = false;
      let midLine = false; // true when write() was called without a trailing newline
      let result;
      try {
        result = await consumeSSEStream(response, {
          onDelta(text) {
            if (!midLine && text.trim() === '') return;
            write(text);
            hasOutput = true;
            midLine = text.length > 0 && !text.endsWith('\n');
          },
          onToolCall(name) {
            if (midLine) { write('\n'); midLine = false; }
            errorLog(`⚙ ${name}`);
          },
        });
      } finally {
        clearTimeout(timer);
      }

      // Ensure a trailing newline after streamed text
      if (midLine) {
        write('\n');
      }

      if (!hasOutput) {
        log('(no response from agent)');
      }

      // Print conversation continuation hint
      const effectiveConvId = result.conversationId || conversationId;
      const expertFlag = expert ? ' --expert' : '';
      errorLog(`\nTo continue this conversation:`);
      errorLog(`  nansen agent "<follow-up>" --conversation-id "${effectiveConvId}"${expertFlag}`);

      return;
    },
  };
}
