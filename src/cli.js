/**
 * Nansen CLI - Core logic (testable)
 * Extracted from index.js for coverage
 */

import { NansenAPI, NansenError, ErrorCode, saveConfig, deleteConfig, getConfigFile, clearCache, getCacheDir, validateAddress, sleep } from './api.js';
import { buildWalletCommands } from './wallet.js';
import { buildTradingCommands } from './trading.js';
import { formatAlertsTable, buildAlertsCommands } from './commands/alerts.js';
import { resolveAddress, isEnsName } from './ens.js';
import fs from 'fs';
import { getUpdateNotification, getUpgradeNotice, scheduleUpdateCheck } from './update-check.js';
import { trackCommandSucceeded, trackCommandFailed } from './telemetry.js';
import { createRequire } from 'module';
import * as readline from 'readline';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

// ============= Schema Definition =============

const schemaDefinition = require('./schema.json');

// SCHEMA is the static definition with version injected at runtime.
// The schema.json file is the source of truth for command metadata (returns, options, etc.)
// and should be updated whenever the API changes — do not edit returns arrays here.
export const SCHEMA = { version: VERSION, ...schemaDefinition };

// ============= Pagination =============

export function buildPagination(options) {
  if (!options.limit && !options.page) return undefined;
  return {
    page: Math.max(1, parseInt(options.page, 10) || 1),
    per_page: options.limit,
  };
}

// ============= Field Filtering =============

/**
 * Filter object to include only specified fields
 * Supports nested paths with dot notation (e.g., "data.results")
 */
export function filterFields(data, fields) {
  if (!fields || fields.length === 0) return data;
  
  const fieldSet = new Set(fields);
  
  function filterObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => filterObject(item));
    }
    if (typeof obj !== 'object') return obj;
    
    const filtered = {};
    for (const key of Object.keys(obj)) {
      if (fieldSet.has(key)) {
        // Explicitly requested — include as-is
        filtered[key] = obj[key];
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        if (Array.isArray(obj[key])) {
          // Only recurse into arrays whose elements are plain objects.
          // Primitive arrays (e.g. tags: ["a","b"]) are dropped unless the
          // key was explicitly requested (handled above).
          const hasObjectElements = obj[key].length > 0 &&
            typeof obj[key][0] === 'object' && obj[key][0] !== null;
          if (hasObjectElements) {
            const nested = obj[key].map(item => filterObject(item))
              .filter(item => Object.keys(item).length > 0);
            if (nested.length > 0) {
              filtered[key] = nested;
            }
          }
        } else {
          // Plain object — always recurse in case it wraps requested fields
          const nested = filterObject(obj[key]);
          if (nested !== null && nested !== undefined && Object.keys(nested).length > 0) {
            filtered[key] = nested;
          }
        }
      }
    }
    return filtered;
  }
  
  return filterObject(data);
}

/**
 * Parse comma-separated fields string
 */
export function parseFields(fieldsOption) {
  if (!fieldsOption) return null;
  return fieldsOption.split(',').map(f => f.trim()).filter(f => f.length > 0);
}

/**
 * Produce a compact schema listing commands with params* notation.
 * Use `nansen schema --full` for the verbose version.
 */
export function compactSchema(schema) {
  function compactOptions(opts) {
    if (!opts) return '';
    return Object.entries(opts)
      .map(([name, o]) => `${name}${o.required ? '*' : ''}`)
      .join(', ');
  }

  function compactCmd(prefix, cmd) {
    const entries = [];
    if (cmd.subcommands) {
      for (const [name, sub] of Object.entries(cmd.subcommands)) {
        const path = prefix ? `${prefix} ${name}` : name;
        if (sub.subcommands) {
          entries.push(...compactCmd(path, sub));
        } else {
          const params = compactOptions(sub.options);
          entries.push({ command: path, description: sub.description, params, returns: sub.returns });
        }
      }
    } else {
      const params = compactOptions(cmd.options);
      entries.push({ command: prefix, description: cmd.description, params, returns: cmd.returns });
    }
    return entries;
  }

  const commands = [];
  for (const [name, cmd] of Object.entries(schema.commands)) {
    commands.push(...compactCmd(name, cmd));
  }

  return {
    version: schema.version,
    params_legend: '* = required',
    commands,
    globalOptions: Object.keys(schema.globalOptions).join(', '),
    chains: schema.chains,
    smartMoneyLabels: schema.smartMoneyLabels
  };
}

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM > bM ? 1 : -1;
  if (am !== bm) return am > bm ? 1 : -1;
  if (ap !== bp) return ap > bp ? 1 : -1;
  return 0;
}

export function parseArgs(args) {
  const result = { _: [], flags: {}, options: {} };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      
      if (key === 'pretty' || key === 'help' || key === 'version' || key === 'table' || key === 'no-retry' || key === 'cache' || key === 'no-cache' || key === 'stream' || key === 'enrich' || key === 'full' || key === 'human' || key === 'enabled' || key === 'disabled') {
        result.flags[key] = true;
      } else if (next && (!next.startsWith('-') || /^-\d/.test(next))) {
        // Try to parse as JSON first (for objects/arrays/booleans),
        // but keep numeric strings as strings to avoid precision loss
        // and scientific notation for large integers (e.g. 1e+21).
        let parsedValue;
        try {
          const parsed = JSON.parse(next);
          parsedValue = typeof parsed === 'number' ? next : parsed;
        } catch {
          parsedValue = next;
        }
        i++;
        // Accumulate repeated options into arrays (supports repeatable flags like --token, --subject)
        if (key in result.options) {
          if (!Array.isArray(result.options[key])) {
            result.options[key] = [result.options[key]];
          }
          result.options[key].push(parsedValue);
        } else {
          result.options[key] = parsedValue;
        }
      } else {
        result.flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      result.flags[arg.slice(1)] = true;
    } else {
      result._.push(arg);
    }
  }
  
  return result;
}

// Format a single value for table display
export function formatValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1000000) return (val / 1000000).toFixed(2) + 'M';
    if (Math.abs(val) >= 1000) return (val / 1000).toFixed(2) + 'K';
    if (Number.isInteger(val)) return val.toString();
    return val.toFixed(2);
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Table formatter for human-readable output
export function formatTable(data) {
  // Extract array of records from various response shapes
  let records = [];
  if (Array.isArray(data)) {
    records = data;
  } else if (data?.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    records = data.results;
  } else if (data?.data?.results && Array.isArray(data.data.results)) {
    records = data.data.results;
  } else if (typeof data === 'object' && data !== null) {
    // Single object - convert to array
    records = [data];
  }

  if (records.length === 0) {
    return 'No data';
  }

  // Get columns from first record, prioritize common useful fields
  const priorityFields = ['token_symbol', 'token_name', 'symbol', 'name', 'address', 'label', 'chain', 'value_usd', 'amount', 'pnl_usd', 'price_usd', 'volume_usd', 'net_flow_usd', 'timestamp', 'block_timestamp'];
  const allKeys = [...new Set(records.flatMap(r => Object.keys(r)))];

  // Sort: priority fields first, then alphabetically
  const columns = allKeys.sort((a, b) => {
    const aIdx = priorityFields.indexOf(a);
    const bIdx = priorityFields.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  }).slice(0, 8); // Limit to 8 columns for readability

  // Calculate column widths
  const widths = columns.map(col => {
    const headerLen = col.length;
    const maxDataLen = Math.max(...records.map(r => {
      const val = formatValue(r[col]);
      return val.length;
    }));
    return Math.min(Math.max(headerLen, maxDataLen), 30); // Cap at 30 chars
  });

  // Build table
  const separator = '─';
  const lines = [];

  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i])).join(' │ ');
  lines.push(header);
  lines.push(widths.map(w => separator.repeat(w)).join('─┼─'));

  // Rows
  for (const record of records.slice(0, 50)) { // Limit to 50 rows
    const row = columns.map((col, i) => {
      const val = formatValue(record[col]);
      return val.slice(0, widths[i]).padEnd(widths[i]);
    }).join(' │ ');
    lines.push(row);
  }

  if (records.length > 50) {
    lines.push(`... and ${records.length - 50} more rows`);
  }

  return lines.join('\n');
}

/**
 * Format data as CSV with header row
 */
export function formatCsv(data) {
  // Extract array of records from various response shapes
  let records = [];
  if (Array.isArray(data)) {
    records = data;
  } else if (data?.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    records = data.results;
  } else if (data?.data?.results && Array.isArray(data.data.results)) {
    records = data.data.results;
  } else if (typeof data === 'object' && data !== null) {
    records = [data];
  }

  if (records.length === 0) return '';

  const columns = [...new Set(records.flatMap(r => Object.keys(r)))];

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const lines = [columns.join(',')];
  for (const record of records) {
    lines.push(columns.map(col => escape(record[col])).join(','));
  }
  return lines.join('\n');
}

// Format output data (returns string, does not print)
export function formatOutput(data, { pretty = false, table = false, csv = false } = {}) {
  if (csv) {
    if (data.success === false) {
      return { type: 'error', text: `Error: ${data.error}` };
    }
    const csvData = data.data || data;
    return { type: 'csv', text: formatCsv(csvData) };
  } else if (table) {
    if (data.success === false) {
      return { type: 'error', text: `Error: ${data.error}` };
    } else {
      const tableData = data.data || data;
      return { type: 'table', text: formatTable(tableData) };
    }
  } else if (pretty) {
    return { type: 'json', text: JSON.stringify(data, null, 2) };
  } else {
    return { type: 'json', text: JSON.stringify(data) };
  }
}

// Format error data (returns object, does not exit)
export function formatError(error) {
  const details = error.details ?? error.data ?? null;
  const result = {
    success: false,
    error: error.message,
    code: error.code || 'UNKNOWN',
    status: error.status || null,
  };
  if (details != null && !(typeof details === 'object' && !Array.isArray(details) && Object.keys(details).length === 0)) {
    result.details = details;
  }
  return result;
}

/**
 * Format data as JSON lines (NDJSON) for streaming output
 * Each record is output as a separate JSON line
 */
export function formatStream(data) {
  // Extract array of records from various response shapes
  let records = [];
  if (Array.isArray(data)) {
    records = data;
  } else if (data?.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    records = data.results;
  } else if (data?.data?.results && Array.isArray(data.data.results)) {
    records = data.data.results;
  } else if (typeof data === 'object' && data !== null) {
    // Single object - output as single line
    records = [data];
  }

  if (records.length === 0) {
    return '';
  }

  // Output each record as a separate JSON line
  return records.map(record => JSON.stringify(record)).join('\n');
}

/**
 * Parse --date option into {from, to} object.
 * Accepts: "YYYY-MM-DD" (single date → from=date, to=date),
 *          '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' (JSON object),
 *          or already-parsed object {from, to}.
 * Falls back to days-based range if no date provided.
 */
export function parseDateOption(dateOption, days = 30) {
  if (dateOption) {
    if (typeof dateOption === 'object' && dateOption.from) {
      return dateOption;
    }
    if (typeof dateOption === 'string') {
      // Simple date string: use as both from and to
      const dateMatch = dateOption.match(/^\d{4}-\d{2}-\d{2}$/);
      if (dateMatch) {
        return { from: dateOption, to: dateOption };
      }
    }
  }
  // Default: use days-based range
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return { from, to };
}

// Parse simple sort syntax: "field:direction" or "field" (defaults to DESC)
export function parseSort(sortOption, orderByOption) {
  // If --order-by is provided, use it (full JSON control)
  if (orderByOption) return orderByOption;
  
  // If no --sort, return undefined
  if (!sortOption) return undefined;
  
  // Parse --sort field:direction or --sort field
  const parts = sortOption.split(':');
  const field = parts[0];
  const direction = (parts[1] || 'desc').toUpperCase();
  
  return [{ field, direction }];
}

// Enrich transfers with Nansen labels for from/to addresses
async function enrichTransfers(result, apiInstance, chain) {
  const transfers = result?.data?.results || result?.transfers || result?.data || [];
  if (!Array.isArray(transfers) || transfers.length === 0) return result;

  // Collect unique addresses (cap at 50)
  const addrs = new Set();
  for (const t of transfers) {
    if (t.from) addrs.add(t.from);
    if (t.to) addrs.add(t.to);
    if (addrs.size >= 50) break;
  }

  // Batch lookup labels
  const labelMap = {};
  for (const addr of addrs) {
    try {
      const labelsResult = await apiInstance.addressLabels({ address: addr, chain });
      labelMap[addr] = labelsResult?.labels || labelsResult?.data?.results || [];
    } catch {
      labelMap[addr] = [];
    }
  }

  // Merge labels into transfers
  for (const t of transfers) {
    if (t.from && labelMap[t.from]) t.from_labels = labelMap[t.from];
    if (t.to && labelMap[t.to]) t.to_labels = labelMap[t.to];
  }

  return result;
}

// ============= Address Parsing =============

/**
 * Parse an --addresses option that may arrive as:
 *  - a pre-parsed array (arg parser split it)
 *  - a JSON array string: '["0x…","0x…"]'
 *  - a comma-separated string: "0x…,0x…"
 * Non-array JSON values (objects, numbers, booleans) are rejected.
 */
export function parseAddressList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(a => String(a).trim()).filter(Boolean);
  }
  if (!raw) return [];

  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map(a => String(a).trim()).filter(Boolean);
    }
    throw new NansenError(
      '--addresses must be a comma-separated list or JSON array, got: ' + typeof parsed,
      ErrorCode.INVALID_PARAMS
    );
  } catch (e) {
    if (e instanceof NansenError) throw e;
    return s.split(',').map(a => a.trim()).filter(Boolean);
  }
}

// ============= Composite Functions =============

export async function batchProfile(api, params = {}) {
  const { addresses = [], chain = 'ethereum', include = ['labels', 'balance'], delayMs = 1000 } = params;
  const results = [];
  for (let i = 0; i < addresses.length; i++) {
    let address = addresses[i].trim();
    const entry = { address, chain };

    // Resolve ENS names
    if (isEnsName(address)) {
      try {
        const resolved = await resolveAddress(address, chain);
        entry.ensName = resolved.ensName;
        address = resolved.address;
        entry.address = address;
      } catch (err) {
        entry.error = err.message;
        results.push(entry);
        if (i < addresses.length - 1) await sleep(delayMs);
        continue;
      }
    }

    const validation = validateAddress(address, chain);
    if (!validation.valid) {
      entry.error = validation.error;
      results.push(entry);
      if (i < addresses.length - 1) await sleep(delayMs);
      continue;
    }
    try {
      if (include.includes('labels')) {
        entry.labels = await api.addressLabels({ address, chain });
      }
      if (include.includes('balance')) {
        entry.balance = await api.addressBalance({ address, chain });
      }
      if (include.includes('pnl')) {
        entry.pnl = await api.addressPnl({ address, chain });
      }
    } catch (err) {
      entry.error = err.message;
    }
    results.push(entry);
    if (i < addresses.length - 1) await sleep(delayMs);
  }
  return { results, total: addresses.length, completed: results.filter(r => !r.error).length };
}

export async function traceCounterparties(api, params = {}) {
  let { address, chain = 'ethereum', depth = 2, width = 10, days = 30, delayMs = 1000 } = params;
  if (!address) {
    throw new NansenError('address is required for trace', ErrorCode.MISSING_PARAM);
  }

  // Resolve ENS names
  if (isEnsName(address)) {
    try {
      const resolved = await resolveAddress(address, chain);
      address = resolved.address;
    } catch (err) {
      throw new NansenError(err.message, ErrorCode.INVALID_ADDRESS);
    }
  }

  const validation = validateAddress(address, chain);
  if (!validation.valid) {
    throw new NansenError(validation.error, ErrorCode.INVALID_ADDRESS);
  }
  const clampedDepth = Math.max(1, Math.min(depth, 5));
  const visited = new Set();
  const nodes = [];
  const edges = [];
  const queue = [{ addr: address, hop: 0 }];
  visited.add(address);
  nodes.push(address);

  while (queue.length > 0) {
    const { addr, hop } = queue.shift();
    if (hop >= clampedDepth) continue;

    try {
      const result = await api.addressCounterparties({
        address: addr, chain, days,
        pagination: { page: 1, per_page: width },
      });

      const counterparties = result?.data?.results || result?.counterparties || result?.data || [];
      const items = Array.isArray(counterparties) ? counterparties.slice(0, width) : [];

      for (const cp of items) {
        const cpAddr = cp.counterparty_address || cp.address || cp.counterparty;
        if (!cpAddr) continue;

        edges.push({
          from: addr, to: cpAddr,
          volume_usd: cp.volume_usd || cp.total_volume_usd || 0,
          tx_count: cp.transaction_count || cp.tx_count || 0,
          hop: hop + 1,
        });

        if (!visited.has(cpAddr)) {
          visited.add(cpAddr);
          nodes.push(cpAddr);
          queue.push({ addr: cpAddr, hop: hop + 1 });
        }
      }
    } catch {
      // Skip addresses that fail (404, etc) but continue the traversal
    }

    if (queue.length > 0) await sleep(delayMs);
  }

  return {
    root: address, chain, depth: clampedDepth,
    nodes, edges,
    stats: { nodes_visited: nodes.length, edges_found: edges.length, max_depth_reached: Math.max(0, ...edges.map(e => e.hop)) },
  };
}

export async function compareWallets(api, params = {}) {
  const { addresses = [], chain = 'ethereum', days = 30, delayMs = 1000 } = params;
  if (addresses.length !== 2) {
    throw new NansenError('Exactly 2 addresses are required for comparison', ErrorCode.INVALID_PARAMS);
  }
  const [addr1, addr2] = addresses;
  for (const addr of [addr1, addr2]) {
    const validation = validateAddress(addr, chain);
    if (!validation.valid) {
      throw new NansenError(validation.error, ErrorCode.INVALID_ADDRESS);
    }
  }

  // Fetch counterparties and balances for both addresses
  const [cp1, cp2] = await Promise.all([
    api.addressCounterparties({ address: addr1, chain, days }).catch(() => null),
    api.addressCounterparties({ address: addr2, chain, days }).catch(() => null),
  ]);
  await sleep(delayMs);
  const [bal1, bal2] = await Promise.all([
    api.addressBalance({ address: addr1, chain }).catch(() => null),
    api.addressBalance({ address: addr2, chain }).catch(() => null),
  ]);

  // Extract counterparty addresses
  const extractCps = (result) => {
    const list = result?.data?.results || result?.counterparties || result?.data || [];
    return Array.isArray(list) ? list : [];
  };
  const cps1 = extractCps(cp1);
  const cps2 = extractCps(cp2);
  const cpAddrs1 = new Set(cps1.map(c => c.counterparty_address || c.address || c.counterparty).filter(Boolean));
  const cpAddrs2 = new Set(cps2.map(c => c.counterparty_address || c.address || c.counterparty).filter(Boolean));
  const sharedCpAddrs = [...cpAddrs1].filter(a => cpAddrs2.has(a));

  // Extract token holdings
  const extractTokens = (result) => {
    const list = result?.data?.results || result?.balances || result?.data || [];
    return Array.isArray(list) ? list : [];
  };
  const tokens1 = extractTokens(bal1);
  const tokens2 = extractTokens(bal2);
  const tokenSyms1 = new Set(tokens1.map(t => t.token_symbol).filter(Boolean));
  const tokenSyms2 = new Set(tokens2.map(t => t.token_symbol).filter(Boolean));
  const sharedTokens = [...tokenSyms1].filter(s => tokenSyms2.has(s));

  return {
    addresses: [addr1, addr2], chain,
    shared_counterparties: sharedCpAddrs,
    shared_tokens: sharedTokens,
    balances: [
      { address: addr1, total_usd: tokens1.reduce((sum, t) => sum + (t.value_usd ?? t.balance_usd ?? 0), 0) },
      { address: addr2, total_usd: tokens2.reduce((sum, t) => sum + (t.value_usd ?? t.balance_usd ?? 0), 0) },
    ],
  };
}

export const BANNER = '';

export const HELP = `Nansen CLI v${VERSION} — designed for AI agents.

USAGE: nansen <command> [subcommand] [options]

COMMANDS:
  research    smart-money, profiler, token, search, perp, portfolio, points
  trade       quote, execute
  wallet      create, list, show, export, default, delete, forget-password
  alerts      list, create, update, toggle, delete
  web         search, fetch
  account     Show API key status, plan, and remaining credits
  login       Save API key (--api-key <key>, --human, or NANSEN_API_KEY env var)
  logout      Remove saved API key
  schema      JSON schema for all commands (use "nansen schema <cmd>" for one)
  cache       clear
  changelog   --since <version> to filter

OPTIONS: --chain --limit --sort field:dir --fields a,b --days N --filters '{}'
FORMAT:  --pretty --table --format csv --stream (NDJSON)
RETRY:   --no-retry --retries N --cache --cache-ttl N

EXAMPLES:
  nansen research smart-money netflow --chain solana
  nansen research token screener --chain solana --timeframe 24h
  nansen research profiler balance --address 0x... --chain ethereum
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000

DEPRECATED ALIASES (still work, will be removed in a future version):
  smart-money, profiler, token, search, perp, portfolio, points → use "nansen research <command>"
  quote, execute → use "nansen trade <command>"

Research chains: ethereum, solana, base, bnb, arbitrum, polygon, optimism, avalanche, linea, scroll, mantle, ronin, sei, plasma, sonic, monad, hyperevm, iotaevm
Trade chains: solana, base
Labels: Fund, Smart Trader, 30D/90D/180D Smart Trader, Smart HL Perps Trader

Docs: https://docs.nansen.ai
Skills: npx skills add nansen-ai/nansen-cli (agent-optimised docs per command group)

Telemetry: anonymous usage stats collected. Disable: DO_NOT_TRACK=1
`;

// Helper to prompt for input (exported for mocking)
export async function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    if (hidden && process.stdout.isTTY) {
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      
      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      
      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// Build command handlers (returns object with handler functions)
export function buildCommands(deps = {}) {
  // Allow dependency injection for testing
  const {
    api: _api = null,
    promptFn = prompt,
    log = console.log,
    errorOutput: _errorOutput = console.error,
    NansenAPIClass: _NansenAPIClass = NansenAPI,
    saveConfigFn = saveConfig,
    deleteConfigFn = deleteConfig,
    getConfigFileFn = getConfigFile,
    exit = process.exit,
    isTTY = process.stdin.isTTY
  } = deps;

  const cmds = {
    'account': async (_args, apiInstance, _flags, _options) => {
      return apiInstance.getAccount();
    },

    'web': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const subArgs = args.slice(1);

      const handlers = {
        'search': async () => {
          // Accept queries as positional args or --query (repeated)
          let queries = subArgs.length > 0 ? subArgs : [];
          if (options.query) {
            const fromOption = Array.isArray(options.query) ? options.query : [options.query];
            queries = queries.concat(fromOption);
          }
          queries = queries.filter(q => q.trim());
          if (queries.length === 0) {
            throw new NansenError('At least one query is required. Usage: nansen web search "bitcoin price" --num-results 5', ErrorCode.MISSING_PARAM);
          }
          let numResults;
          if (options['num-results'] !== undefined) {
            const numResultsRaw = parseInt(options['num-results'], 10);
            if (Number.isNaN(numResultsRaw)) {
              // Non-numeric — fall back to API default
              numResults = undefined;
            } else if (numResultsRaw >= 1 && numResultsRaw <= 20) {
              numResults = numResultsRaw;
            } else {
              throw new NansenError('--num-results must be between 1 and 20', ErrorCode.INVALID_PARAMS);
            }
          }
          return apiInstance.webSearch({ queries, numResults });
        },

        'fetch': async () => {
          // Accept URLs as positional args or --url (repeated)
          let urls = subArgs.length > 0 ? subArgs : [];
          if (options.url) {
            const fromOption = Array.isArray(options.url) ? options.url : [options.url];
            urls = urls.concat(fromOption);
          }
          if (urls.length === 0) {
            throw new NansenError('At least one URL is required. Usage: nansen web fetch https://example.com --question "What is this about?"', ErrorCode.MISSING_PARAM);
          }
          for (const u of urls) {
            try { new URL(u); } catch {
              throw new NansenError(`Invalid URL: "${u}". URLs must include a scheme, e.g. https://example.com`, ErrorCode.INVALID_PARAMS);
            }
          }
          if (!options.question || !options.question.trim()) {
            throw new NansenError('--question is required and cannot be blank. Usage: nansen web fetch https://example.com --question "What is this about?"', ErrorCode.MISSING_PARAM);
          }
          return apiInstance.webFetch({ urls, question: options.question });
        },

        'help': async () => ({
          subcommands: ['search', 'fetch'],
          description: 'Web search and fetch commands',
          examples: [
            'nansen web search "bitcoin price"',
            'nansen web search "solana news" --num-results 5',
            'nansen web fetch https://nansen.ai --question "What does Nansen do?"',
          ],
        }),
      };

      if (!handlers[subcommand]) {
        throw new NansenError(`Unknown web subcommand: ${subcommand}. Available: search, fetch`, ErrorCode.UNKNOWN);
      }

      return handlers[subcommand]();
    },

    'login': async (args, apiInstance, flags, options) => {
      if (flags.help || flags.h) {
        log('nansen login - Save your Nansen API key\n');
        log('USAGE:');
        log('  nansen login --api-key <key>');
        log('  NANSEN_API_KEY=<key> nansen login');
        log('  nansen login --human              (interactive prompt)\n');
        log('OPTIONS:');
        log('  --api-key <key>   Your Nansen API key');
        log('  --human           Enable interactive prompt');
        log('  --help            Show this help\n');
        log('Get your API key at: https://app.nansen.ai/auth/agent-setup');
        return;
      }

      let apiKey = options['api-key'] || options.apiKey;

      if (!apiKey) {
        apiKey = process.env.NANSEN_API_KEY;
      }

      if (!apiKey && flags.human) {
        if (!isTTY) {
          log(JSON.stringify({
            error: 'NOT_A_TTY',
            message: '--human requires an interactive terminal. Use --api-key or NANSEN_API_KEY env var instead.',
          }));
          exit(1);
          return;
        }
        log('Nansen CLI Login\n');
        log('Get your API key at: https://app.nansen.ai/auth/agent-setup\n');
        apiKey = await promptFn('Enter your API key: ', true);
      }

      if (!apiKey || apiKey.trim().length === 0) {
        log(JSON.stringify({
          error: 'API_KEY_REQUIRED',
          message: 'No API key provided.',
          resolution: [
            'Run: nansen login --api-key <key>',
            'Or set NANSEN_API_KEY environment variable',
            'Get your API key at: https://app.nansen.ai/auth/agent-setup',
          ],
        }));
        exit(1);
        return;
      }

      // Verify API key before saving
      const NansenAPIClass = _NansenAPIClass;
      const testApi = new NansenAPIClass(apiKey.trim(), undefined, {
        retry: { maxRetries: 2 },
        cache: { enabled: false }
      });

      let accountInfo;
      try {
        accountInfo = await testApi.getAccount();
      } catch (error) {
        if (error.code === ErrorCode.UNAUTHORIZED) {
          log(JSON.stringify({
            error: 'INVALID_API_KEY',
            message: 'The API key is not valid.',
            resolution: ['Check your key at https://app.nansen.ai/auth/agent-setup']
          }));
        } else {
          log(JSON.stringify({
            error: 'VERIFICATION_FAILED',
            message: `Could not verify API key: ${error.message}`,
            resolution: ['Check your internet connection', 'Try again']
          }));
        }
        exit(1);
        return;
      }

      // Key is valid - now save
      saveConfigFn({
        apiKey: apiKey.trim(),
        baseUrl: 'https://api.nansen.ai'
      });

      log(`✓ Saved to ${getConfigFileFn()}\n`);
      if (accountInfo?.plan) {
        log(`Plan: ${accountInfo.plan}`);
      }
      if (accountInfo?.credits_remaining !== undefined) {
        log(`Credits remaining: ${accountInfo.credits_remaining}`);
      }
      log('\nYou can now use the Nansen CLI. Try:');
      log('  nansen research token screener --chain solana --pretty');
    },

    'logout': async (_args, _apiInstance, _flags, _options) => {
      const deleted = deleteConfigFn();
      if (deleted) {
        log(`✓ Removed ${getConfigFileFn()}`);
      } else {
        log('No saved credentials found');
      }
    },

    'help': async (_args, _apiInstance, _flags, _options) => {
      log(HELP);
    },

    'changelog': async (_args, _apiInstance, _flags, _options) => {
      if (_flags.help || _flags.h) {
        log('changelog — Show release history\n\nUsage:\n  nansen changelog [--since <version>]\n\nOptions:\n  --since <version>   Show only entries for versions >= this version\n\nExamples:\n  nansen changelog\n  nansen changelog --since 1.10.0');
        return;
      }
      const changelogPath = new URL('../CHANGELOG.md', import.meta.url).pathname;
      let content;
      try {
        content = fs.readFileSync(changelogPath, 'utf8');
      } catch {
        log('CHANGELOG.md not found. Visit https://github.com/nansen-ai/nansen-cli/blob/main/CHANGELOG.md');
        return;
      }
      const since = _options.since;
      if (since) {
        // Show only entries from the given version onwards
        const lines = content.split('\n');
        const filtered = [];
        let include = false;
        for (const line of lines) {
          // Match ## [x.y.z] (Keep a Changelog format) or ## x.y.z (changeset format)
          const match = line.match(/^## \[(\d+\.\d+\.\d+)\]|^## (\d+\.\d+\.\d+)\b/);
          if (match) {
            const ver = match[1] || match[2];
            // Compare: include versions >= since, stop at versions < since
            if (compareSemver(ver, since) >= 0) {
              include = true;
            } else {
              include = false;
            }
          }
          if (include) filtered.push(line);
        }
        log(filtered.join('\n') || `No changelog entries found for versions >= ${since}`);
      } else {
        log(content);
      }
    },

    'schema': async (args, _apiInstance, flags, _options) => {
      const subcommand = args[0];
      const schemaEntry = subcommand && (SCHEMA.commands[subcommand] || SCHEMA.commands.research.subcommands[subcommand]);

      if (schemaEntry) {
        return {
          command: subcommand,
          ...schemaEntry,
          globalOptions: SCHEMA.globalOptions,
          chains: SCHEMA.chains,
          smartMoneyLabels: SCHEMA.smartMoneyLabels
        };
      }

      if (flags.full) {
        return SCHEMA;
      }

      return compactSchema(SCHEMA);
    },

    'cache': async (args, _apiInstance, _flags, _options) => {
      const subcommand = args[0] || 'help';
      
      const handlers = {
        'clear': () => {
          const count = clearCache();
          log(`✓ Cleared ${count} cached responses`);
          log(`  Cache dir: ${getCacheDir()}`);
        },
        'help': () => {
          log('Cache Management\n');
          log('USAGE:');
          log('  nansen cache clear    Clear all cached responses\n');
          log('CACHE OPTIONS (for any command):');
          log('  --cache               Enable caching for this session');
          log('  --no-cache            Bypass cache for this request');
          log('  --cache-ttl <seconds> Set cache TTL (default: 300)');
        }
      };
      
      if (!handlers[subcommand]) {
        log(`Unknown cache subcommand: ${subcommand}`);
        handlers['help']();
        return;
      }
      
      return handlers[subcommand]();
    },

    'smart-money': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const chain = options.chain || 'solana';
      const chains = options.chains || [chain];
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);

      // Add smart money label filter if specified
      if (options.labels) {
        filters.include_smart_money_labels = Array.isArray(options.labels) 
          ? options.labels 
          : [options.labels];
      }

      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'netflow': () => apiInstance.smartMoneyNetflow({ chains, filters, orderBy, pagination }),
        'dex-trades': () => apiInstance.smartMoneyDexTrades({ chains, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.smartMoneyPerpTrades({ filters, orderBy, pagination, onlyNewPositions: options['only-new-positions'] ?? flags['only-new-positions'] }),
        'holdings': () => apiInstance.smartMoneyHoldings({ chains, filters, orderBy, pagination }),
        'dcas': () => apiInstance.smartMoneyDcas({ filters, orderBy, pagination }),
        'historical-holdings': () => apiInstance.smartMoneyHistoricalHoldings({ chains, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['netflow', 'dex-trades', 'perp-trades', 'holdings', 'dcas', 'historical-holdings'],
          description: 'Smart Money analytics endpoints',
          example: 'nansen smart-money netflow --chain solana --labels Fund'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'profiler': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      let address = options.address;
      const entityName = options.entity || options['entity-name'];
      const chain = options.chain || 'ethereum';

      // Resolve ENS names (e.g. vitalik.eth → 0x...)
      let ensName;
      if (address && isEnsName(address)) {
        try {
          const resolved = await resolveAddress(address, chain);
          address = resolved.address;
          ensName = resolved.ensName;
        } catch (err) {
          throw new NansenError(err.message, ErrorCode.INVALID_ADDRESS);
        }
      }
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'balance': () => apiInstance.addressBalance({ address, entityName, chain, filters, orderBy }),
        'labels': () => apiInstance.addressLabels({ address, chain, pagination }),
        'transactions': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.addressTransactions({ address, chain, filters, orderBy, pagination, days, date });
        },
        'pnl': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.addressPnl({ address, chain, date, days, filters, orderBy, pagination });
        },
        'search': () => apiInstance.entitySearch({ query: options.query }),
        'historical-balances': () => apiInstance.addressHistoricalBalances({ address, chain, filters, orderBy, pagination, days }),
        'related-wallets': () => apiInstance.addressRelatedWallets({ address, chain, orderBy, pagination }),
        'counterparties': () => apiInstance.addressCounterparties({ address, chain, filters, orderBy, pagination, days }),
        'pnl-summary': () => apiInstance.addressPnlSummary({ address, chain, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.addressPerpPositions({ address, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.addressPerpTrades({ address, filters, orderBy, pagination, days }),
        'batch': () => {
          let addresses = [];
          if (options.addresses) {
            addresses = parseAddressList(options.addresses);
          } else if (options.file) {
            const content = fs.readFileSync(options.file, 'utf8');
            try {
              const parsed = JSON.parse(content);
              if (!Array.isArray(parsed)) {
                throw new NansenError('File must contain a JSON array of address strings or one address per line', ErrorCode.INVALID_PARAMS);
              }
              if (!parsed.every(item => typeof item === 'string')) {
                throw new NansenError('File must contain a JSON array of address strings or one address per line', ErrorCode.INVALID_PARAMS);
              }
              addresses = parsed.map(a => a.trim()).filter(Boolean);
            } catch (e) {
              if (e instanceof NansenError) throw e;
              addresses = content.split('\n').map(a => a.trim()).filter(Boolean);
            }
          }
          if (addresses.length > 100) {
            throw new NansenError('Batch is limited to 100 addresses', ErrorCode.INVALID_PARAMS);
          }
          const include = options.include ? options.include.split(',').map(s => s.trim()) : ['labels', 'balance'];
          const delayMs = options.delay ? parseInt(options.delay) : 1000;
          return batchProfile(apiInstance, { addresses, chain, include, delayMs });
        },
        'trace': () => {
          const depth = options.depth ? Math.max(1, Math.min(parseInt(options.depth), 5)) : 2;
          const width = options.width ? parseInt(options.width) : 10;
          const delayMs = options.delay ? parseInt(options.delay) : 1000;
          return traceCounterparties(apiInstance, { address, chain, depth, width, days, delayMs });
        },
        'compare': () => {
          const addrs = parseAddressList(options.addresses);
          return compareWallets(apiInstance, { addresses: addrs, chain, days });
        },
        'help': () => ({
          commands: ['balance', 'labels', 'transactions', 'pnl', 'search', 'historical-balances', 'related-wallets', 'counterparties', 'pnl-summary', 'perp-positions', 'perp-trades', 'batch', 'trace', 'compare'],
          description: 'Wallet profiling endpoints',
          example: 'nansen research profiler compare --addresses "0xABC...,0xDEF..." --chain ethereum'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      const result = await handlers[subcommand]();

      // Attach ENS metadata so the caller knows the name was resolved
      return ensName && result && typeof result === 'object'
        ? { ...result, _ens: { name: ensName, resolvedAddress: address } }
        : result;
    },

    'token': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const tokenAddress = options.token || options['token-address'];
      const tokenSymbol = options.symbol || options['token-symbol'];
      const chain = options.chain || 'solana';
      const chains = options.chains || [chain];
      const timeframe = options.timeframe || '24h';
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const days = options.days ? parseInt(options.days) : 30;

      // Convenience filter for smart money only
      const onlySmartMoney = options['smart-money'] || flags['smart-money'] || false;
      if (onlySmartMoney) {
        filters.include_smart_money_labels = filters.include_smart_money_labels || 
          ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'];
      }

      const handlers = {
        'indicators': () => apiInstance.tokenIndicators({ tokenAddress, chain }),
        'ohlcv': () => apiInstance.tokenOhlcv({ tokenAddress, chain, timeframe: options.timeframe || '1d' }),
        'info': () => apiInstance.tokenInformation({ tokenAddress, chain, timeframe: options.timeframe }),
        'screener': async () => {
          const search = options.search;
          // When searching, fetch more results to filter from (API has no server-side search)
          const searchPagination = search 
            ? { page: 1, per_page: Math.max(500, pagination?.per_page || 0) }
            : pagination;
          const result = await apiInstance.tokenScreener({ chains, timeframe, filters, orderBy, pagination: searchPagination });
          if (search) {
            const q = search.toLowerCase();
            const requestedLimit = pagination?.per_page || 100;
            const filterArr = (arr) => arr.filter(t => 
              (t.token_symbol && t.token_symbol.toLowerCase().includes(q)) ||
              (t.token_name && t.token_name.toLowerCase().includes(q)) ||
              (t.token_address && t.token_address.toLowerCase() === q)
            ).slice(0, requestedLimit);
            // Handle nested response shapes: {data: [...]} or {data: {data: [...]}}
            if (Array.isArray(result?.data)) {
              return { ...result, data: filterArr(result.data) };
            } else if (result?.data?.data && Array.isArray(result.data.data)) {
              return { ...result, data: { ...result.data, data: filterArr(result.data.data) } };
            }
          }
          return result;
        },
        'holders': () => apiInstance.tokenHolders({ tokenAddress, chain, labelType: onlySmartMoney ? 'smart_money' : 'all_holders', filters, orderBy, pagination }),
        'flows': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.tokenFlows({ tokenAddress, chain, filters, orderBy, pagination, days, date });
        },
        'dex-trades': () => apiInstance.tokenDexTrades({ tokenAddress, chain, onlySmartMoney, filters, orderBy, pagination, days }),
        'pnl': () => apiInstance.tokenPnlLeaderboard({ tokenAddress, chain, filters, orderBy, pagination, days }),
        'who-bought-sold': () => {
          const date = parseDateOption(options.date, days);
          return apiInstance.tokenWhoBoughtSold({ tokenAddress, chain, filters, orderBy, pagination, days, date });
        },
        'flow-intelligence': () => apiInstance.tokenFlowIntelligence({ tokenAddress, chain, days }),
        'transfers': () => {
          // Inject --from/--to into filters
          if (options.from) filters.from_address = options.from;
          if (options.to) filters.to_address = options.to;
          return apiInstance.tokenTransfers({ tokenAddress, chain, filters, orderBy, pagination, days });
        },
        'jup-dca': () => apiInstance.tokenJupDca({ tokenAddress, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.tokenPerpTrades({ tokenSymbol, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.tokenPerpPositions({ tokenSymbol, filters, orderBy, pagination }),
        'perp-pnl-leaderboard': () => apiInstance.tokenPerpPnlLeaderboard({ tokenSymbol, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['info', 'ohlcv', 'screener', 'holders', 'flows', 'dex-trades', 'pnl', 'who-bought-sold', 'flow-intelligence', 'transfers', 'jup-dca', 'perp-trades', 'perp-positions', 'perp-pnl-leaderboard'],
          description: 'Token God Mode endpoints',
          example: 'nansen token screener --chain solana --timeframe 24h --smart-money'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      let result = await handlers[subcommand]();

      // Warn when OHLCV price data is null (backend coverage gap)
      // Volume comes from on-chain DEX data and is always available, but price/market_cap
      // requires a price oracle — some tokens are not tracked and return all-null price fields.
      if (subcommand === 'ohlcv') {
        const candles = Array.isArray(result?.data) ? result.data : [];
        if (candles.length === 0) {
          process.stderr.write(`⚠️  No OHLCV data returned for token ${tokenAddress} on ${chain}.\n`);
        } else {
          const hasPrice = candles.some(c => c.open !== null || c.close !== null);
          const hasVolume = candles.some(c => c.volume !== null);
          if (!hasPrice && hasVolume) {
            process.stderr.write(
              `⚠️  Price data unavailable for token ${tokenAddress} on ${chain}.\n` +
              `   open/high/low/close, volume_usd, and market_cap are null.\n` +
              `   Volume (raw token units) is available. This token may not be tracked by Nansen's price oracle.\n`
            );
          } else if (!hasPrice && !hasVolume) {
            process.stderr.write(`⚠️  No OHLCV data available for token ${tokenAddress} on ${chain}.\n`);
          }
        }
      }

      // Enrich transfers with Nansen labels for from/to addresses
      if (subcommand === 'transfers' && (options.enrich || flags.enrich)) {
        result = await enrichTransfers(result, apiInstance, chain);
      }

      return result;
    },

    'portfolio': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const walletAddress = options.wallet || options.address;

      const handlers = {
        'defi': () => apiInstance.portfolioDefiHoldings({ walletAddress }),
        'defi-holdings': () => apiInstance.portfolioDefiHoldings({ walletAddress }),
        'help': () => ({
          commands: ['defi', 'defi-holdings'],
          description: 'Portfolio analytics endpoints',
          example: 'nansen portfolio defi --wallet 0x123...'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'perp': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'screener': () => apiInstance.perpScreener({ filters, orderBy, pagination, days }),
        'leaderboard': () => apiInstance.perpLeaderboard({ filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['screener', 'leaderboard'],
          description: 'Perpetual futures analytics endpoints',
          example: 'nansen perp screener --days 7 --limit 20'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'search': async (args, apiInstance, flags, options) => {
      return apiInstance.generalSearch({
        query: args[0] || options.query,
        resultType: options.type,
        chain: options.chain,
        limit: options.limit
      });
    },

    'points': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const tier = options.tier;
      const pagination = buildPagination(options);

      const handlers = {
        'leaderboard': () => apiInstance.pointsLeaderboard({ tier, pagination }),
        'help': () => ({
          commands: ['leaderboard'],
          description: 'Nansen Points analytics endpoints',
          example: 'nansen points leaderboard --limit 100'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
    },

    'prediction-market': async (args, apiInstance, flags, options) => {
      if (Date.now() < new Date('2026-03-16T00:00:00Z').getTime()) {
        process.stderr.write('⚠️  PnL data for prediction markets is temporarily unavailable while we improve accuracy. We\'ll update once resolved.\n');
      }
      const subcommand = args[0] || 'help';
      const marketId = options['market-id'];
      const address = options.address;
      const sortBy = options['sort-by'];
      const query = options.query;
      const status = options.status;
      const sort = parseSort(options.sort);
      const pagination = buildPagination(options);

      const handlers = {
        'ohlcv': () => apiInstance.pmOhlcv({ marketId, sort, pagination }),
        'orderbook': () => apiInstance.pmOrderbook({ marketId, pagination }),
        'top-holders': () => apiInstance.pmTopHolders({ marketId, sort, pagination }),
        'trades-by-market': () => apiInstance.pmTradesByMarket({ marketId, pagination }),
        'trades-by-address': () => apiInstance.pmTradesByAddress({ address, pagination }),
        'market-screener': () => apiInstance.pmMarketScreener({ sortBy, query, status, pagination }),
        'event-screener': () => apiInstance.pmEventScreener({ sortBy, query, status, pagination }),
        'pnl-by-market': () => apiInstance.pmPnlByMarket({ marketId, pagination }),
        'pnl-by-address': () => apiInstance.pmPnlByAddress({ address, pagination }),
        'position-detail': () => apiInstance.pmPositionDetail({ marketId, pagination }),
        'categories': () => apiInstance.pmCategories({ pagination }),
        'help': () => ({
          commands: ['ohlcv', 'orderbook', 'top-holders', 'trades-by-market', 'trades-by-address', 'market-screener', 'event-screener', 'pnl-by-market', 'pnl-by-address', 'position-detail', 'categories'],
          description: 'Polymarket prediction market analytics',
          example: 'nansen research pm market-screener --sort-by volume_24hr --limit 20'
        })
      };

      if (!handlers[subcommand]) {
        throw new NansenError(`Unknown subcommand: ${subcommand}. Available: ${Object.keys(handlers).filter(k => k !== 'help').join(', ')}`, ErrorCode.UNKNOWN);
      }

      return handlers[subcommand]();
    }
  };

  // 'research' delegates to the category handlers defined above
  const RESEARCH_CATEGORIES = new Set(['smart-money', 'profiler', 'token', 'search', 'perp', 'portfolio', 'points', 'prediction-market']);

  cmds['research'] = async (args, apiInstance, flags, options) => {
    const rawCategory = args[0];
    if (!rawCategory || rawCategory === 'help') {
      return {
        categories: [...RESEARCH_CATEGORIES],
        aliases: RESEARCH_CATEGORY_ALIASES,
        description: 'Research and analytics commands',
        example: 'nansen research smart-money netflow --chain solana'
      };
    }
    const category = RESEARCH_CATEGORY_ALIASES[rawCategory] || rawCategory;
    if (!RESEARCH_CATEGORIES.has(category)) {
      throw new NansenError(`Unknown research category: ${rawCategory}. Available: ${[...RESEARCH_CATEGORIES].join(', ')}`, ErrorCode.UNKNOWN);
    }
    return cmds[category](args.slice(1), apiInstance, flags, options);
  };

  // 'trade' delegates to quote/execute from buildTradingCommands
  const tradingCmds = buildTradingCommands(deps);
  cmds['trade'] = async (args, apiInstance, flags, options) => {
    const sub = args[0];
    if (!sub || sub === 'help') {
      log(`nansen trade — DEX trading commands

SUBCOMMANDS:
  quote       Get a swap quote (price, route, fees)
  execute     Sign and broadcast a quoted swap

USAGE:
  nansen trade quote --chain <chain> --from <token> --to <token> --amount <units> [--wallet <name>]
  nansen trade execute --quote <quoteId> [--wallet <name>]

EXAMPLES:
  nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000
  nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000 --wallet walletconnect
  nansen trade execute --quote 1708900000000-abc123

WALLET:
  --wallet <name>   Use a named wallet, or "walletconnect" / "wc" for WalletConnect (EVM only).
                    Defaults to the default local wallet if omitted.

SYMBOLS:
  Common tokens resolve automatically: SOL, ETH, USDC, USDT, WETH
  Raw addresses are also accepted.`);
      return;
    }
    if (!tradingCmds[sub]) {
      throw new NansenError(`Unknown trade subcommand: ${sub}. Available: quote, execute`, ErrorCode.UNKNOWN);
    }
    return tradingCmds[sub](args.slice(1), apiInstance, flags, options);
  };

  return cmds;
}

// Categories that moved under 'research'
export const DEPRECATED_TO_RESEARCH = new Set(['smart-money', 'profiler', 'token', 'search', 'perp', 'portfolio', 'points']);
// Subcommands that moved under 'trade'
export const DEPRECATED_TO_TRADE = new Set(['quote', 'execute']);

// Command aliases: top-level shortcuts that resolve before routing
export const COMMAND_ALIASES = {
  'tgm': 'token',           // Token God Mode
  'sm': 'smart-money',      // Smart Money
  'prof': 'profiler',       // Profiler
  'port': 'portfolio',      // Portfolio
  'pm': 'prediction-market' // Prediction Market
};

// Aliases used inside the 'research' namespace
export const RESEARCH_CATEGORY_ALIASES = {
  'tgm': 'token',
  'sm': 'smart-money',
  'prof': 'profiler',
  'port': 'portfolio',
  'pm': 'prediction-market'
};

// Generate help text for a specific subcommand using SCHEMA
export function generateSubcommandHelp(command, subcommand, prefix = null) {
  const cmdSchema = SCHEMA.commands[command] || SCHEMA.commands.research.subcommands[command];
  if (!cmdSchema) return null;

  const subSchema = cmdSchema.subcommands?.[subcommand];
  if (!subSchema) return null;

  const lines = [];
  lines.push(`${command} ${subcommand} — ${subSchema.description || 'No description'}`);

  if (subSchema.options) {
    const params = Object.entries(subSchema.options).map(([name, opt]) => {
      const parts = [`--${name}`];
      if (opt.required) parts[0] += '*';
      if (opt.default !== undefined) parts.push(`(${opt.default})`);
      if (opt.enum) parts.push(`[${opt.enum.join('|')}]`);
      return parts.join(' ');
    });
    lines.push(`Params (* required): ${params.join(', ')}`);
  }

  if (subSchema.returns?.length) {
    lines.push(`Returns: ${subSchema.returns.join(', ')}`);
  }

  const exampleValues = { address: '0x...', token: '0x...', query: '"term"', symbol: 'BTC', date: '2024-01-01' };
  const chain = subSchema.options?.chain?.default || 'solana';
  const cmdPrefix = prefix || (DEPRECATED_TO_RESEARCH.has(command) ? `research ${command}` : command);
  let example = `nansen ${cmdPrefix} ${subcommand}`;
  if (subSchema.options) {
    for (const [name, opt] of Object.entries(subSchema.options)) {
      if (opt.required) example += ` --${name} ${exampleValues[name] || '<val>'}`;
    }
  }
  if (subSchema.options?.chain && !subSchema.options.chain.required) {
    example += ` --chain ${chain}`;
  }
  lines.push(`Example: ${example}`);

  return lines.join('\n');
}

// Run CLI with given args (returns result, allows custom output/exit handlers)
export async function runCLI(rawArgs, deps = {}) {
  const {
    output = console.log,
    errorOutput = console.error,
    exit = process.exit,
    NansenAPIClass = NansenAPI,
    commandOverrides = {}
  } = deps;

  const { _: positional, flags, options } = parseArgs(rawArgs);

  // Resolve command aliases
  const rawCommand = positional[0] || 'help';
  const command = COMMAND_ALIASES[rawCommand] || rawCommand;
  const subArgs = positional.slice(1);
  const subcommand = subArgs[0];



  const pretty = flags.pretty || flags.p;
  const table = flags.table || flags.t;
  const stream = flags.stream || flags.s;
  const csv = options.format === 'csv';

  // Update check (read cached result + schedule background refresh)
  const updateNotification = getUpdateNotification(VERSION);
  const upgradeNotice = getUpgradeNotice(VERSION);
  scheduleUpdateCheck();
  const notify = () => {
    if (upgradeNotice) errorOutput(upgradeNotice);
    if (updateNotification) errorOutput(updateNotification);
  };

  // Deprecation note for help output
  const deprecationNote = (cmd) => {
    if (DEPRECATED_TO_RESEARCH.has(cmd)) return `Note: "nansen ${cmd}" is deprecated. Use "nansen research ${cmd}" instead.\n\n`;
    if (DEPRECATED_TO_TRADE.has(cmd)) return `Note: "nansen ${cmd}" is deprecated. Use "nansen trade ${cmd}" instead.\n\n`;
    return '';
  };

  const commands = { ...buildCommands(deps), ...buildWalletCommands(deps), ...buildTradingCommands(deps), ...buildAlertsCommands(deps), ...commandOverrides };

  if (flags.version || flags.v) {
    output(VERSION);
    return { type: 'version', data: VERSION };
  }

  if (command === 'help' || flags.help || flags.h) {
    // Check for subcommand-specific help: nansen <command> <subcommand> --help
    if (flags.help || flags.h) {
      // Handle 'research <category> <sub> --help' (3-level)
      if (command === 'research' && subcommand) {
        const category = RESEARCH_CATEGORY_ALIASES[subcommand] || subcommand;
        const deepSub = subArgs[1];
        if (deepSub) {
          const subHelp = generateSubcommandHelp(category, deepSub, `research ${subcommand}`);
          if (subHelp) {
            output(subHelp);
            notify();
            return { type: 'subcommand-help', command: category, subcommand: deepSub };
          }
        }
        // List category subcommands: 'nansen research smart-money --help'
        const researchCat = SCHEMA.commands.research.subcommands[category];
        if (researchCat) {
          const catSchema = researchCat;
          const lines = [`research ${category} — ${catSchema.description}`];
          if (catSchema.subcommands) {
            lines.push('Subcommands: ' + Object.keys(catSchema.subcommands).join(', '));
            lines.push(`Use: nansen research ${category} <subcommand> --help`);
          }
          output(lines.join('\n'));
          notify();
          return { type: 'command-help', command: `research ${category}` };
        }
      }
      // First try subcommand help
      // Skip for 'trade'/'alerts' — their handlers show their own rich usage
      if (command && subcommand && command !== 'trade' && command !== 'alerts') {
        const subHelp = generateSubcommandHelp(command, subcommand);
        if (subHelp) {
          output(deprecationNote(command) + subHelp);
          notify();
          return { type: 'subcommand-help', command, subcommand };
        }
      }
      // Then try command-level help (list subcommands)
      // Skip for 'trade'/'alerts' — let the handler show its own usage
      const cmdSchemaLookup = command !== 'trade' && command !== 'alerts' && (SCHEMA.commands[command] || SCHEMA.commands.research.subcommands[command]);
      if (command && cmdSchemaLookup) {
        const cmdSchema = cmdSchemaLookup;
        const lines = [`${command} — ${cmdSchema.description}`];
        if (cmdSchema.subcommands) {
          lines.push('Subcommands: ' + Object.keys(cmdSchema.subcommands).join(', '));
          lines.push(`Use: nansen ${command} <subcommand> --help`);
        }
        if (cmdSchema.options) {
          const params = Object.entries(cmdSchema.options).map(([name, opt]) => {
            const parts = [`--${name}`];
            if (opt.required) parts[0] += '*';
            if (opt.default !== undefined) parts.push(`(default: ${opt.default})`);
            if (opt.description) parts.push(`— ${opt.description}`);
            return parts.join(' ');
          });
          lines.push(`\nOptions (* required):\n  ${params.join('\n  ')}`);
        }
        if (cmdSchema.examples?.length) {
          lines.push(`\nExamples:\n  ${cmdSchema.examples.join('\n  ')}`);
        }
        output(deprecationNote(command) + lines.join('\n'));
        notify();
        return { type: 'command-help', command };
      }
    }
    // Simple commands (logout, schema, cache) — show help instead of executing
    // Prevents destructive commands like logout from running when user just wants help
    if (commands[command]) {
      const simpleHelp = {
        'logout': 'nansen logout — Remove saved API key from ~/.nansen/config.json',
        'schema': 'nansen schema [command] [--pretty] — Show JSON schema for all commands (or a specific command)',
        'cache':  'nansen cache clear — Clear the API response cache',
      };
      if (simpleHelp[command]) {
        output(simpleHelp[command]);
        notify();
        return { type: 'command-help', command };
      }
    }
    // Commands with handlers (e.g. quote, execute) show their own usage
    if (command === 'help' || !commands[command]) {
      output(BANNER + HELP);
      notify();
      return { type: 'help' };
    }
  }

  // ── Telemetry setup ──
  const startTime = Date.now();
  const fullCommand = subcommand ? `${command} ${subcommand}` : command;
  const flagNames = Object.keys(flags).filter(k => flags[k]).map(k => `--${k}`);
  const optionNames = Object.keys(options).map(k => `--${k}`);
  const usedFlags = [...flagNames, ...optionNames];
  const chain = options.chain || null;

  if (!commands[command]) {
    const errorData = {
      error: `Unknown command: ${command}`,
      available: Object.keys(commands)
    };
    const formatted = formatOutput(errorData, { pretty, table });
    output(formatted.text);
    trackCommandFailed({ command: fullCommand, duration_ms: Date.now() - startTime, error_code: 'UNKNOWN_COMMAND', flags: usedFlags, chain });
    exit(1);
    return { type: 'error', data: errorData };
  }

  try {
    // Configure retry options
    const retryOptions = flags['no-retry']
      ? { maxRetries: 0 }
      : { maxRetries: options.retries !== undefined ? (Number.isNaN(parseInt(options.retries, 10)) ? 3 : parseInt(options.retries, 10)) : 3 };

    // Configure cache options
    const cacheTtl = options['cache-ttl'] !== undefined ? parseInt(options['cache-ttl'], 10) : 300;
    const cacheOptions = {
      enabled: flags['cache'] && !flags['no-cache'],
      ttl: Number.isNaN(cacheTtl) ? 300 : cacheTtl
    };

    const defaultHeaders = {};
    if (options['x402-payment-signature']) {
      defaultHeaders['Payment-Signature'] = options['x402-payment-signature'];
    }
    const api = new NansenAPIClass(undefined, undefined, { retry: retryOptions, cache: cacheOptions, defaultHeaders });
    let result = await commands[command](subArgs, api, flags, options);

    // Commands that handle their own output return undefined
    if (result === undefined) {
      trackCommandSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, flags: usedFlags, chain });
      return { type: 'no-output', command };
    }

    // Schema returns data directly (not wrapped in { success, data })
    if (command === 'schema') {
      const formatted = formatOutput(result, { pretty, table: false });
      output(formatted.text);
      trackCommandSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, flags: usedFlags, chain });
      return { type: 'schema', data: result };
    }

    // Apply field filtering if --fields is specified
    const fields = parseFields(options.fields);
    if (fields) {
      result = filterFields(result, fields);
    }

    // Alerts list with --table uses custom table format
    if (command === 'alerts' && subcommand === 'list' && table) {
      output(formatAlertsTable(result));
      return { type: 'success', data: result };
    }

    // Output in requested format
    if (stream) {
      // Stream mode: output each record as a JSON line (NDJSON)
      const streamOutput = formatStream(result);
      if (streamOutput) {
        output(streamOutput);
      }
      trackCommandSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, from_cache: !!result?.fromCache, flags: usedFlags, chain });
      return { type: 'stream', data: result };
    }

    const successData = { success: true, data: result };
    const formatted = formatOutput(successData, { pretty, table, csv });
    output(formatted.text);
    trackCommandSucceeded({ command: fullCommand, duration_ms: Date.now() - startTime, from_cache: !!result?.fromCache, flags: usedFlags, chain });
    return { type: csv ? 'csv' : 'success', data: result };
  } catch (error) {
    const errorData = formatError(error);
    const formatted = formatOutput(errorData, { pretty, table, csv });
    output(formatted.text);
    trackCommandFailed({
      command: fullCommand,
      duration_ms: Date.now() - startTime,
      error_code: error.code || 'UNKNOWN',
      status: error.status || null,
      flags: usedFlags,
      chain,
    });
    exit(1);
    return { type: 'error', data: errorData };
  }
}
