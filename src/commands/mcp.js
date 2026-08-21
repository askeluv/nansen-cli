/**
 * Nansen CLI - MCP client configuration
 * Installs and verifies the Nansen MCP server entry in local MCP clients (Cursor first).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { NansenAPI, NansenError, CommandError, ErrorCode } from '../api.js';

export const MCP_URL = 'https://mcp.nansen.ai/ra/mcp';
export const MCP_SERVER_NAME = 'nansen';
export const MCP_HEADER = 'NANSEN-API-KEY';

// Per-client config locations. Every supported client reads the standard
// `mcpServers` map and supports native url+headers entries (no stdio bridge).
export const MCP_CLIENTS = {
  cursor: {
    configPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    restartHint: 'Restart Cursor (or toggle the server in Cursor Settings > MCP) to pick up the change.',
  },
};

/**
 * Parse a streamable-HTTP MCP response body: either plain JSON or an SSE
 * stream whose first `data:` line carries the JSON-RPC message.
 */
export function parseMcpResponseBody(text, contentType = '') {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        return JSON.parse(line.slice(5).trim());
      }
    }
    throw new NansenError('MCP server returned an event stream with no data', ErrorCode.UNKNOWN);
  }
  return JSON.parse(text);
}

function resolveClient(subArgs, action) {
  const client = subArgs[0];
  const supported = Object.keys(MCP_CLIENTS).join(', ');
  if (!client) {
    throw new NansenError(`Client is required. Usage: nansen mcp ${action} cursor. Supported: ${supported}`, ErrorCode.MISSING_PARAM);
  }
  if (!MCP_CLIENTS[client]) {
    throw new NansenError(`Unknown MCP client: ${client}. Supported: ${supported}`, ErrorCode.INVALID_PARAMS);
  }
  return client;
}

function resolveConfigPath(client, options) {
  return options['config-path'] || MCP_CLIENTS[client].configPath();
}

/**
 * Read and parse the client's mcp.json. Returns null when the file does not
 * exist; throws (rather than clobbering) when it exists but is invalid JSON.
 */
function readClientConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (_e) {
    throw new NansenError(`Existing ${configPath} is not valid JSON. Fix or remove it, then re-run.`, ErrorCode.INVALID_PARAMS);
  }
}

export function buildMcpCommands(deps = {}) {
  const {
    NansenAPIClass = NansenAPI,
    fetchFn = fetch,
    timeoutMs = 10000,
  } = deps;

  return {
    'mcp': async (args, apiInstance, _flags, options) => {
      const subcommand = args[0] || 'help';
      const subArgs = args.slice(1);

      const handlers = {
        'install': async () => {
          const client = resolveClient(subArgs, 'install');
          const apiKey = (options['api-key'] || apiInstance.apiKey || '').trim();
          if (!apiKey) {
            throw new CommandError('No API key found.', 'API_KEY_REQUIRED', {
              error: 'API_KEY_REQUIRED',
              message: 'No API key found.',
              resolution: [
                'Run: nansen login --api-key <key>',
                'Or pass --api-key <key>',
                'Get your API key at: https://app.nansen.ai/auth/agent-setup',
              ],
            });
          }

          const configPath = resolveConfigPath(client, options);
          const config = readClientConfig(configPath) || {};
          if (config.mcpServers !== undefined && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
            throw new NansenError(`Existing ${configPath} has a non-object "mcpServers" field. Fix or remove it, then re-run.`, ErrorCode.INVALID_PARAMS);
          }
          config.mcpServers = config.mcpServers || {};
          const existed = Boolean(config.mcpServers[MCP_SERVER_NAME]);
          config.mcpServers[MCP_SERVER_NAME] = {
            url: MCP_URL,
            headers: { [MCP_HEADER]: apiKey },
          };

          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          // The file now contains a credential; owner-only on POSIX, no-op on Windows.
          try { fs.chmodSync(configPath, 0o600); } catch (_e) { /* ignore */ }

          return {
            client,
            config_path: configPath,
            server: MCP_SERVER_NAME,
            url: MCP_URL,
            action: existed ? 'updated' : 'created',
            next_steps: [
              MCP_CLIENTS[client].restartHint,
              `Run: nansen mcp verify ${client}`,
            ],
          };
        },

        'verify': async () => {
          const client = resolveClient(subArgs, 'verify');
          const configPath = resolveConfigPath(client, options);
          const config = readClientConfig(configPath);
          const entry = config?.mcpServers?.[MCP_SERVER_NAME];
          if (!entry) {
            throw new CommandError(`No "${MCP_SERVER_NAME}" MCP server configured in ${configPath}.`, 'MCP_NOT_INSTALLED', {
              error: 'MCP_NOT_INSTALLED',
              message: `No "${MCP_SERVER_NAME}" MCP server configured in ${configPath}.`,
              resolution: [`Run: nansen mcp install ${client}`],
            });
          }
          const url = entry.url;
          const apiKey = entry.headers?.[MCP_HEADER];
          if (!url || !apiKey) {
            throw new CommandError(`The "${MCP_SERVER_NAME}" entry in ${configPath} is missing its url or ${MCP_HEADER} header.`, 'MCP_CONFIG_INVALID', {
              error: 'MCP_CONFIG_INVALID',
              message: `The "${MCP_SERVER_NAME}" entry in ${configPath} is missing its url or ${MCP_HEADER} header.`,
              resolution: [`Run: nansen mcp install ${client}`],
            });
          }

          // Step 1 - transport: a streamable-HTTP initialize handshake proves the
          // endpoint is reachable and speaks MCP. It does NOT prove the key works:
          // the server accepts initialize and tools/list unauthenticated.
          let serverInfo;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetchFn(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                [MCP_HEADER]: apiKey,
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                  protocolVersion: '2025-03-26',
                  capabilities: {},
                  clientInfo: { name: 'nansen-cli', version: 'verify' },
                },
              }),
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new NansenError(`MCP handshake failed: ${url} returned HTTP ${response.status}`, ErrorCode.UNKNOWN, response.status);
            }
            const message = parseMcpResponseBody(await response.text(), response.headers.get('content-type') || '');
            serverInfo = message?.result?.serverInfo || null;
            if (!serverInfo) {
              throw new NansenError(`MCP handshake failed: ${url} did not return a server identity`, ErrorCode.UNKNOWN);
            }
          } catch (error) {
            if (error instanceof NansenError) throw error;
            const reason = error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (error.cause?.code || error.message);
            throw new NansenError(`MCP endpoint unreachable: ${url} (${reason})`, ErrorCode.NETWORK_ERROR);
          } finally {
            clearTimeout(timer);
          }

          // Step 2 - auth: validate the configured key with a credit-free account
          // check against the API the MCP server fronts.
          let account;
          try {
            const api = new NansenAPIClass(apiKey, undefined, { retry: { maxRetries: 1 }, cache: { enabled: false } });
            account = await api.getAccount();
          } catch (error) {
            if (error.code === ErrorCode.UNAUTHORIZED) {
              throw new CommandError(`The API key configured in ${configPath} is not valid.`, 'INVALID_API_KEY', {
                error: 'INVALID_API_KEY',
                message: `The API key configured in ${configPath} is not valid.`,
                resolution: [
                  'Get your API key at: https://app.nansen.ai/auth/agent-setup',
                  `Then run: nansen mcp install ${client} --api-key <key>`,
                ],
              });
            }
            throw error;
          }

          return {
            client,
            config_path: configPath,
            url,
            transport: 'ok',
            server: serverInfo.name,
            server_version: serverInfo.version,
            auth: 'ok',
            ...(account?.plan ? { plan: account.plan } : {}),
          };
        },

        'help': async () => ({
          subcommands: ['install', 'verify'],
          description: 'Install and verify the Nansen MCP server in local MCP clients',
          examples: [
            'nansen mcp install cursor',
            'nansen mcp install cursor --api-key <key>',
            'nansen mcp verify cursor',
          ],
        }),
      };

      if (!handlers[subcommand]) {
        throw new NansenError(`Unknown mcp subcommand: ${subcommand}. Available: install, verify`, ErrorCode.UNKNOWN);
      }

      return handlers[subcommand]();
    },
  };
}
