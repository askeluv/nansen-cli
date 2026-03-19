/**
 * Nansen CLI - Agent command
 * Interactive research agent with fast/expert modes via SSE streaming.
 */

import crypto from 'crypto';
import { NansenError, ErrorCode, telemetryHeaders, packageVersion } from '../api.js';

/** Map HTTP status to the most appropriate ErrorCode. */
function errorCodeForStatus(status) {
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 504) return ErrorCode.TIMEOUT;
  if (status >= 500) return ErrorCode.SERVER_ERROR;
  return ErrorCode.UNKNOWN;
}

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
    ...apiInstance.defaultHeaders,
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
    errorCodeForStatus(status),
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
async function consumeSSEStream(response, callbacks = {}) {
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

    // SSE: split on double-newline boundaries
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break;

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
    }
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
 * @param {Function} [deps.log]     – stdout line output (default: console.log)
 * @param {Function} [deps.errLog]  – stderr line output (default: console.error)
 * @param {Function} [deps.write]   – raw stdout writer, no trailing newline (default: process.stdout.write)
 * @returns {object} command map
 */
export function buildAgentCommands(deps = {}) {
  const {
    log = console.log,
    errLog = console.error,
    write = (s) => process.stdout.write(s),
  } = deps;

  return {
    'agent': async (args, apiInstance, flags, options) => {
      const HELP = {
        _top: `nansen agent — Nansen Research Agent

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
  --conversation-id <id>       Continue a previous conversation
  --json                       Output raw JSON instead of formatted text

CONVERSATION FLOW:
  Each request generates a conversation ID. To continue a multi-turn
  conversation, pass it back with --conversation-id. The ID and a
  ready-to-copy follow-up command are printed to stderr after each response.

EXAMPLES:
  nansen agent "What are the top smart money inflows on Ethereum today?"
  nansen agent "Show me the largest whale wallets on Solana"
  nansen agent "Analyze wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" --expert
  nansen agent "Tell me more about their DeFi positions" --conversation-id abc123

NOTE: This endpoint is currently internal-only (requires a Nansen internal account).`,
      };

      // ── Help ──
      if (flags.help || flags.h || args[0] === 'help' || args.length === 0) {
        log(HELP._top);
        return;
      }

      // ── Parse question ──
      const question = args.join(' ').trim();
      if (!question) {
        log(HELP._top);
        return;
      }

      // ── Mode ──
      const expert = !!flags.expert;
      const endpoint = expert ? '/api/v1/agent/expert' : '/api/v1/agent/fast';
      const modeName = expert ? 'expert' : 'fast';

      // ── Conversation ID ──
      const conversationId = options['conversation-id'] || crypto.randomUUID();

      // ── Request ──
      const url = `${apiInstance.baseUrl}${endpoint}`;
      const body = {
        text: question,
        conversation_id: conversationId,
      };

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(apiInstance),
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new NansenError(
          `Network error: ${err.message}`,
          ErrorCode.NETWORK_ERROR,
          null,
          { originalError: err.message },
        );
      }

      if (!response.ok) {
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
        const result = await consumeSSEStream(response);
        return {
          conversation_id: result.conversationId || conversationId,
          mode: modeName,
          text: result.text,
          tool_calls: result.toolCalls,
        };
      }

      // ── Streaming output mode ──
      errLog(`Thinking... (mode: ${modeName})`);

      let hasOutput = false;
      const result = await consumeSSEStream(response, {
        onDelta(text) {
          write(text);
          hasOutput = true;
        },
        onToolCall(name) {
          errLog(`⚙ ${name}`);
        },
      });

      // Ensure a trailing newline after streamed text
      if (hasOutput) {
        write('\n');
      }

      // Summarize tool calls after the response
      if (result.toolCalls.length > 0) {
        errLog(`tools used: ${result.toolCalls.join(', ')}`);
      }

      if (!hasOutput) {
        log('(no response from agent)');
      }

      // Print conversation continuation hint
      const effectiveConvId = result.conversationId || conversationId;
      const expertFlag = expert ? ' --expert' : '';
      errLog(`\nTo continue this conversation:`);
      errLog(`  nansen agent "<follow-up>" --conversation-id ${effectiveConvId}${expertFlag}`);

      return;
    },
  };
}
