/**
 * Nansen CLI - Core logic (testable)
 * Extracted from index.js for coverage
 */

import { NansenAPI, saveConfig, deleteConfig, getConfigFile } from './api.js';
import * as readline from 'readline';

// Parse command line arguments
export function parseArgs(args) {
  const result = { _: [], flags: {}, options: {} };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      
      if (key === 'pretty' || key === 'help' || key === 'table' || key === 'no-retry') {
        result.flags[key] = true;
      } else if (next && !next.startsWith('-')) {
        // Try to parse as JSON first
        try {
          result.options[key] = JSON.parse(next);
        } catch {
          result.options[key] = next;
        }
        i++;
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

// Format output data (returns string, does not print)
export function formatOutput(data, { pretty = false, table = false } = {}) {
  if (table) {
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
  return {
    success: false,
    error: error.message,
    code: error.code || 'UNKNOWN',
    status: error.status || null,
    details: error.data || null
  };
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

// Help text
export const HELP = `
Nansen CLI - Command-line interface for Nansen API
Designed for AI agents with structured JSON output.

USAGE:
  nansen <command> [subcommand] [options]

COMMANDS:
  login          Save your API key (interactive)
  logout         Remove saved API key
  smart-money    Smart Money analytics (netflow, dex-trades, holdings, dcas, historical-holdings)
  profiler       Wallet profiling (balance, labels, transactions, pnl, perp-positions, perp-trades)
  token          Token God Mode (screener, holders, flows, trades, pnl, perp-trades, perp-positions)
  portfolio      Portfolio analytics (defi-holdings)
  help           Show this help message

GLOBAL OPTIONS:
  --pretty       Format JSON output for readability
  --table        Format output as human-readable table
  --chain        Blockchain to query (ethereum, solana, base, etc.)
  --chains       Multiple chains as JSON array
  --limit        Number of results (shorthand for pagination)
  --filters      JSON object with filters
  --sort         Sort by field (e.g., --sort value_usd:desc)
  --order-by     JSON array with sort order (advanced)
  --days         Date range in days (default: 30 for most endpoints)
  --symbol       Token symbol (for perp endpoints)
  --no-retry     Disable automatic retry on rate limits/errors
  --retries <n>  Max retry attempts (default: 3)

EXAMPLES:
  # Get Smart Money netflow on Solana
  nansen smart-money netflow --chain solana

  # Get top tokens by Smart Money activity
  nansen token screener --chain solana --timeframe 24h --pretty

  # Get wallet balance
  nansen profiler balance --address 0x123... --chain ethereum

  # Get wallet labels
  nansen profiler labels --address 0x123... --chain ethereum

  # Search for entity
  nansen profiler search --query "Vitalik"

  # Get token holders with filters
  nansen token holders --token 0x123... --filters '{"only_smart_money":true}'

SMART MONEY LABELS:
  Fund, Smart Trader, 30D Smart Trader, 90D Smart Trader, 
  180D Smart Trader, Smart HL Perps Trader

SUPPORTED CHAINS:
  ethereum, solana, base, bnb, arbitrum, polygon, optimism,
  avalanche, linea, scroll, zksync, mantle, ronin, sei,
  plasma, sonic, unichain, monad, hyperevm, iotaevm

For more info: https://docs.nansen.ai
`;

// Helper to prompt for input (exported for mocking)
export async function prompt(question, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
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
          rl.close();
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
    api = null,
    promptFn = prompt,
    log = console.log,
    NansenAPIClass = NansenAPI,
    saveConfigFn = saveConfig,
    deleteConfigFn = deleteConfig,
    getConfigFileFn = getConfigFile,
    exit = process.exit
  } = deps;

  return {
    'login': async (args, apiInstance, flags, options) => {
      log('Nansen CLI Login\n');
      log('Get your API key at: https://app.nansen.ai/api\n');
      
      const apiKey = await promptFn('Enter your API key: ', true);
      
      if (!apiKey || apiKey.trim().length === 0) {
        log('\n❌ No API key provided');
        exit(1);
        return;
      }
      
      // Validate the key with a test request
      log('\nValidating API key...');
      try {
        const testApi = new NansenAPIClass(apiKey.trim());
        await testApi.tokenScreener({ chains: ['solana'], pagination: { page: 1, per_page: 1 } });
        
        // Save the config
        saveConfigFn({ 
          apiKey: apiKey.trim(), 
          baseUrl: 'https://api.nansen.ai' 
        });
        
        log('✓ API key validated');
        log(`✓ Saved to ${getConfigFileFn()}\n`);
        log('You can now use the Nansen CLI. Try:');
        log('  nansen token screener --chain solana --pretty');
      } catch (error) {
        log(`\n❌ Invalid API key: ${error.message}`);
        exit(1);
      }
    },

    'logout': async (args, apiInstance, flags, options) => {
      const deleted = deleteConfigFn();
      if (deleted) {
        log(`✓ Removed ${getConfigFileFn()}`);
      } else {
        log('No saved credentials found');
      }
    },

    'help': async (args, apiInstance, flags, options) => {
      log(HELP);
    },

    'smart-money': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';
      const chain = options.chain || 'solana';
      const chains = options.chains || [chain];
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = options.limit ? { page: 1, per_page: options.limit } : undefined;

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
        'perp-trades': () => apiInstance.smartMoneyPerpTrades({ filters, orderBy, pagination }),
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
      const address = options.address;
      const entityName = options.entity || options['entity-name'];
      const chain = options.chain || 'ethereum';
      const filters = options.filters || {};
      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = options.limit ? { page: 1, recordsPerPage: options.limit } : undefined;
      const days = options.days ? parseInt(options.days) : 30;

      const handlers = {
        'balance': () => apiInstance.addressBalance({ address, entityName, chain, filters, orderBy }),
        'labels': () => apiInstance.addressLabels({ address, chain, pagination }),
        'transactions': () => apiInstance.addressTransactions({ address, chain, filters, orderBy, pagination }),
        'pnl': () => apiInstance.addressPnl({ address, chain }),
        'search': () => apiInstance.entitySearch({ query: options.query, pagination }),
        'historical-balances': () => apiInstance.addressHistoricalBalances({ address, chain, filters, orderBy, pagination, days }),
        'related-wallets': () => apiInstance.addressRelatedWallets({ address, chain, filters, orderBy, pagination }),
        'counterparties': () => apiInstance.addressCounterparties({ address, chain, filters, orderBy, pagination, days }),
        'pnl-summary': () => apiInstance.addressPnlSummary({ address, chain, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.addressPerpPositions({ address, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.addressPerpTrades({ address, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['balance', 'labels', 'transactions', 'pnl', 'search', 'historical-balances', 'related-wallets', 'counterparties', 'pnl-summary', 'perp-positions', 'perp-trades'],
          description: 'Wallet profiling endpoints',
          example: 'nansen profiler balance --address 0x123... --chain ethereum'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
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
      const pagination = options.limit ? { page: 1, per_page: options.limit } : undefined;
      const days = options.days ? parseInt(options.days) : 30;

      // Convenience filter for smart money only
      const onlySmartMoney = options['smart-money'] || flags['smart-money'] || false;
      if (onlySmartMoney) {
        filters.only_smart_money = true;
      }

      const handlers = {
        'screener': () => apiInstance.tokenScreener({ chains, timeframe, filters, orderBy, pagination }),
        'holders': () => apiInstance.tokenHolders({ tokenAddress, chain, filters, orderBy, pagination }),
        'flows': () => apiInstance.tokenFlows({ tokenAddress, chain, filters, orderBy, pagination }),
        'dex-trades': () => apiInstance.tokenDexTrades({ tokenAddress, chain, onlySmartMoney, filters, orderBy, pagination, days }),
        'pnl': () => apiInstance.tokenPnlLeaderboard({ tokenAddress, chain, filters, orderBy, pagination, days }),
        'who-bought-sold': () => apiInstance.tokenWhoBoughtSold({ tokenAddress, chain, filters, orderBy, pagination }),
        'flow-intelligence': () => apiInstance.tokenFlowIntelligence({ tokenAddress, chain, filters, orderBy, pagination }),
        'transfers': () => apiInstance.tokenTransfers({ tokenAddress, chain, filters, orderBy, pagination, days }),
        'jup-dca': () => apiInstance.tokenJupDca({ tokenAddress, filters, orderBy, pagination }),
        'perp-trades': () => apiInstance.tokenPerpTrades({ tokenSymbol, filters, orderBy, pagination, days }),
        'perp-positions': () => apiInstance.tokenPerpPositions({ tokenSymbol, filters, orderBy, pagination }),
        'perp-pnl-leaderboard': () => apiInstance.tokenPerpPnlLeaderboard({ tokenSymbol, filters, orderBy, pagination, days }),
        'help': () => ({
          commands: ['screener', 'holders', 'flows', 'dex-trades', 'pnl', 'who-bought-sold', 'flow-intelligence', 'transfers', 'jup-dca', 'perp-trades', 'perp-positions', 'perp-pnl-leaderboard'],
          description: 'Token God Mode endpoints',
          example: 'nansen token screener --chain solana --timeframe 24h --smart-money'
        })
      };

      if (!handlers[subcommand]) {
        return { error: `Unknown subcommand: ${subcommand}`, available: Object.keys(handlers) };
      }

      return handlers[subcommand]();
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
    }
  };
}

// Commands that don't require API authentication
export const NO_AUTH_COMMANDS = ['login', 'logout', 'help'];

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
  
  const command = positional[0] || 'help';
  const subArgs = positional.slice(1);
  const pretty = flags.pretty || flags.p;
  const table = flags.table || flags.t;

  const commands = { ...buildCommands(deps), ...commandOverrides };

  if (command === 'help' || flags.help || flags.h) {
    output(HELP);
    return { type: 'help' };
  }

  if (!commands[command]) {
    const errorData = { 
      error: `Unknown command: ${command}`,
      available: Object.keys(commands)
    };
    const formatted = formatOutput(errorData, { pretty, table });
    output(formatted.text);
    exit(1);
    return { type: 'error', data: errorData };
  }

  // Commands that don't require API authentication
  if (NO_AUTH_COMMANDS.includes(command)) {
    await commands[command](subArgs, null, flags, options);
    return { type: 'no-auth', command };
  }

  try {
    // Configure retry options
    const retryOptions = flags['no-retry'] 
      ? { maxRetries: 0 } 
      : { maxRetries: options.retries || 3 };
    
    const api = new NansenAPIClass(undefined, undefined, { retry: retryOptions });
    const result = await commands[command](subArgs, api, flags, options);
    const successData = { success: true, data: result };
    const formatted = formatOutput(successData, { pretty, table });
    output(formatted.text);
    return { type: 'success', data: result };
  } catch (error) {
    const errorData = formatError(error);
    const formatted = formatOutput(errorData, { pretty, table });
    errorOutput(formatted.text);
    exit(1);
    return { type: 'error', data: errorData };
  }
}
