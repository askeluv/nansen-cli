import { check, formatChecks, maskKey, resolveAuthConfig } from './doctor.js';

export const DEFAULT_MCP_URL = 'https://mcp.nansen.ai/ra/mcp';
export const CANARY_TOOL = 'nansen_score_top_tokens';

class McpRequestError extends Error {
  constructor(message, { status = null, rpcMessage = null } = {}) {
    super(message);
    this.name = 'McpRequestError';
    this.status = status;
    this.rpcMessage = rpcMessage;
  }
}

function responseContentType(response) {
  return (
    response.headers?.get?.('content-type')
    || response.headers?.['content-type']
    || response.headers?.['Content-Type']
    || ''
  ).toLowerCase();
}

function responseText(message) {
  const content = [message?.result?.content, message?.content]
    .filter(Array.isArray)
    .flat()
    .map(item => item?.text)
    .filter(text => typeof text === 'string');
  const error = message?.error;
  const errorText = typeof error === 'string'
    ? error
    : [error?.message, error?.data].filter(value => typeof value === 'string').join(': ');
  return [...content, errorText].filter(Boolean).join('\n');
}

function parseResponseBody(body, contentType, requestId) {
  if (!contentType.includes('text/event-stream')) return JSON.parse(body);

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const message = JSON.parse(data);
      // String compare: a proxy may re-serialize the JSON-RPC id as "1".
      if (String(message?.id) === String(requestId)) return message;
    } catch {
      // Ignore non-JSON SSE data and keep looking for the JSON-RPC message.
    }
  }

  throw new Error(`no JSON-RPC message with id ${requestId} in SSE response`);
}

/**
 * Send one stateless MCP JSON-RPC request and parse either JSON or SSE output.
 */
export async function mcpRequest(url, method, params, {
  apiKey,
  fetchFn = fetch,
  timeoutMs = 30_000,
} = {}) {
  const requestId = 1;
  const controller = new AbortController();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (apiKey) headers['NANSEN-API-KEY'] = apiKey;

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let body;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      // The canary carries NANSEN-API-KEY; undici forwards that custom header
      // across a cross-origin redirect, so refuse to follow one rather than
      // relay the key to whatever host the (possibly non-default) server points at.
      redirect: 'error',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
    body = await response.text();
  } finally {
    clearTimeout(timer);
  }

  let message;
  try {
    message = parseResponseBody(body, responseContentType(response), requestId);
  } catch (error) {
    throw new McpRequestError(
      `MCP server returned an unexpected response${response?.status ? ` (HTTP ${response.status})` : ''}: ${error.message}`,
      { status: response?.status || null },
    );
  }

  if (response?.status && (response.status < 200 || response.status >= 300)) {
    throw new McpRequestError(
      `MCP server returned HTTP ${response.status}${responseText(message) ? `: ${responseText(message)}` : ''}`,
      { status: response.status, rpcMessage: message },
    );
  }

  return message;
}

function errorReason(error) {
  if (error?.name === 'AbortError') return 'timed out';
  return error?.cause?.code || error?.message || 'request failed';
}

function errorText(error) {
  return error?.rpcMessage ? responseText(error.rpcMessage) : error?.message || 'request failed';
}

function authFailureCheck(message, httpStatus = null) {
  const text = responseText(message);
  const codes = [httpStatus, message?.error?.code, message?.result?.code].filter(Boolean).join(' ');
  const combined = `${codes} ${text}`;

  // Order matters, most-specific first. Rate limit before credits: rate-limit
  // texts often say "credit rate limit" and must stay a warn. Credits before
  // auth: the gateway maps 403 + "insufficient"/"credit" to CREDITS_EXHAUSTED,
  // and a zero-balance user must not be told their key was rejected — the
  // create/rotate remedy can itself fail on key-capped plans.
  if (/\b429\b|rate[- ]?limit|too many requests/i.test(combined)) {
    return check(
      'mcp-auth',
      'warn',
      `MCP data call was rate limited; the paid data path is not verified${text ? `: ${text}` : ''}`,
      'Retry the verification shortly.',
    );
  }
  if (/\b402\b|payment required|insufficient|credits?\b/i.test(combined)) {
    return check(
      'mcp-auth',
      'error',
      `MCP server reports insufficient credits${text ? `: ${text}` : ''}`,
      'Top up credits or check your Nansen plan.',
    );
  }
  if (/\b40[13]\b|unauthorized|forbidden|api[- ]key.*(?:required|invalid|reject)|header is required/i.test(combined)) {
    return check(
      'mcp-auth',
      'error',
      `MCP server rejected the API key${text ? `: ${text}` : ''}`,
      'Check the exact key in your MCP client\'s NANSEN-API-KEY header, or create/rotate it at https://app.nansen.ai/api?tab=api',
    );
  }
  return check(
    'mcp-auth',
    'error',
    `MCP authenticated data call failed${text ? `: ${text}` : ''}`,
    'Check the MCP server response and retry.',
  );
}

function isRpcError(message) {
  return Boolean(message?.error) || message?.result?.isError === true || message?.isError === true;
}

function skippedAuth(message) {
  return check('mcp-auth', 'info', `Skipped authenticated data call: ${message}`);
}

function keySourceLabel(source) {
  if (source === 'env') return 'NANSEN_API_KEY env var';
  if (source === 'config') return 'config file';
  if (source === 'dev-config') return 'development config file';
  return '--api-key';
}

/**
 * Run the unauthenticated reachability check and the paid authenticated canary.
 * Every expected failure is represented as a check instead of escaping.
 */
export async function runMcpVerifyChecks({
  apiKey,
  url = DEFAULT_MCP_URL,
  env = process.env,
  fetchFn = fetch,
  timeoutMs = 30_000,
  devConfigPath,
} = {}) {
  const checks = [];
  const auth = resolveAuthConfig(env, devConfigPath);
  // An explicitly passed key — even a bogus null — must never silently fall
  // back to the saved key: that would verify a key the caller never supplied.
  const explicitKey = apiKey !== undefined;
  const resolvedKey = explicitKey ? apiKey : auth.apiKey;
  const key = typeof resolvedKey === 'string' ? resolvedKey.trim() : '';

  if (key) {
    checks.push(check('mcp-api-key', 'ok', `API key found (${maskKey(key)}, source: ${explicitKey ? '--api-key' : keySourceLabel(auth.apiKeySource)})`));
  } else {
    checks.push(check(
      'mcp-api-key',
      'error',
      'No API key available for the authenticated MCP data-path check',
      'Create an API key at https://app.nansen.ai/api?tab=api, then set NANSEN_API_KEY or save it with `nansen login --human`',
    ));
  }

  if (key && url !== DEFAULT_MCP_URL) {
    checks.push(check('mcp-url', 'warn', `Non-default MCP URL: ${url} — the API key will be sent to this host`));
  }

  let serverReady = false;
  try {
    const message = await mcpRequest(url, 'tools/list', {}, { fetchFn, timeoutMs });
    if (isRpcError(message) || !Array.isArray(message?.result?.tools)) {
      const text = responseText(message);
      checks.push(check(
        'mcp-server',
        'error',
        `MCP tools/list failed${text ? `: ${text}` : ''}`,
        `Check the MCP server URL and network: ${url}`,
      ));
    } else {
      serverReady = true;
      checks.push(check(
        'mcp-server',
        'ok',
        `MCP server reachable: tools/list returned ${message.result.tools.length} tools (unauthenticated; reachability only)`,
      ));
    }
  } catch (error) {
    checks.push(check(
      'mcp-server',
      'error',
      `MCP server unreachable: ${errorReason(error)}`,
      `Check your network/proxy or try --url ${url}`,
    ));
  }

  if (!key) {
    checks.push(skippedAuth('no API key was provided'));
  } else if (!serverReady) {
    checks.push(skippedAuth('tools/list did not establish server reachability'));
  } else {
    try {
      const message = await mcpRequest(
        url,
        'tools/call',
        { name: CANARY_TOOL, arguments: { request: {} } },
        { apiKey: key, fetchFn, timeoutMs },
      );
      if (isRpcError(message)) {
        checks.push(authFailureCheck(message));
      } else if (!Array.isArray(message?.result?.content)) {
        // A tools/call result always carries a content array; anything else
        // (e.g. a proxy echoing an unrelated payload) must not verify the key.
        checks.push(check(
          'mcp-auth',
          'error',
          'MCP data call returned a malformed tools/call result — the key is not verified',
          `Check the MCP server URL: ${url}`,
        ));
      } else {
        checks.push(check(
          'mcp-auth',
          'ok',
          'Authenticated MCP data call succeeded (~1 credit consumed).',
        ));
      }
    } catch (error) {
      const text = errorText(error);
      const message = error.rpcMessage || (error.status ? { error: { message: text } } : null);
      checks.push(message
        ? authFailureCheck(message, error.status)
        : check('mcp-auth', 'error', `MCP authenticated data call failed: ${errorReason(error)}`, 'Check your network/proxy or try the verification again.'));
    }
  }

  return checks;
}

export function formatMcpVerifyReport(checks, url, verified) {
  const lines = [`Nansen MCP verify — ${url}`, '', formatChecks(checks), ''];
  if (verified) {
    lines.push('Verified: the supplied API key works against the MCP server\'s paid data path (~1 credit consumed). Ensure this same key is in your client\'s NANSEN-API-KEY header.');
  } else {
    const errors = checks.filter(item => item.status === 'error').length;
    const warnings = checks.filter(item => item.status === 'warn').length;
    lines.push(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} found; MCP setup is not verified.`);
  }
  return lines.join('\n');
}
