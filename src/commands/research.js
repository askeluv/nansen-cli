/**
 * Nansen CLI - Research command
 *
 * Historical/point-in-time analytics. Each subcommand resolves labels and
 * metrics at the requested date rather than current state — useful for
 * backtesting and historical research.
 */

import { NansenError, ErrorCode } from '../api.js';

// Local copies of CLI helpers to avoid a circular import with src/cli.js.
function buildPagination(options) {
  if (!options.limit && !options.page) return undefined;
  return {
    page: Math.max(1, parseInt(options.page, 10) || 1),
    per_page: options.limit,
  };
}

function parseSort(sortOption, orderByOption) {
  if (orderByOption) return orderByOption;
  if (!sortOption) return undefined;
  const parts = String(sortOption).split(':');
  const field = parts[0];
  const direction = (parts[1] || 'desc').toUpperCase();
  return [{ field, direction }];
}

const SUBCOMMANDS = [
  'historical-dex-trades',
  'historical-pnl-leaderboard',
  'historical-token-flow-summary',
  'historical-token-quant-scores',
  'historical-top-holders',
  'historical-who-bought-sold',
  'historical-smart-money-balances',
  'historical-token-screener',
  'historical-wallet-balances',
  'historical-tx-lookup',
  'historical-wallet-transactions',
];

export const RESEARCH_HISTORICAL_SUBCOMMANDS = new Set(SUBCOMMANDS);

function requireOptions(options, required) {
  const missing = required.filter(name => !options[name]);
  if (missing.length > 0) {
    throw new NansenError(
      `Required: ${missing.map(n => '--' + n).join(', ')}`,
      ErrorCode.MISSING_PARAM,
    );
  }
}

function resolveDateRange(options) {
  return { fromDate: options['from-date'], toDate: options['to-date'] };
}

function parseTimeframeDays(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new NansenError('--timeframe-days must be an integer', ErrorCode.INVALID_PARAMS);
  }
  return n;
}

function parseChains(options) {
  if (options.chains) {
    return Array.isArray(options.chains)
      ? options.chains
      : String(options.chains).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (options.chain) return [options.chain];
  return undefined;
}

const HELP_TOP = `nansen research — Historical/point-in-time analytics

SUBCOMMANDS:
  historical-dex-trades             Historical DEX trades for a token
  historical-pnl-leaderboard        Historical PnL leaderboard for a token
  historical-token-flow-summary     Historical token flow summary
  historical-token-quant-scores     Historical token quantitative scores
  historical-top-holders            Historical top holders of a token
  historical-who-bought-sold        Historical buyers/sellers of a token
  historical-smart-money-balances   Historical smart money token balances
  historical-token-screener         Historical token screener
  historical-wallet-balances        Historical token balances for a wallet
  historical-tx-lookup              Lookup a historical transaction by hash
  historical-wallet-transactions    Historical transactions for a wallet

COMMON OPTIONS:
  --from-date <YYYY-MM-DD>   Start of date range (for range-based subcommands)
  --to-date <YYYY-MM-DD>     End of date range (for range-based subcommands)
  --as-of-date <YYYY-MM-DD>  Snapshot date (for as-of-date subcommands)
  --chain <chain>            Chain (default: solana for tokens, ethereum for wallets)
  --page <n> --limit <n>     Pagination (not supported by historical-token-flow-summary)
  --sort <field[:asc|desc]>  Sort order (not supported by historical-smart-money-balances)
  --filters '<json>'         Filters as JSON object

Run: nansen research <subcommand> --help`;

const SUB_HELP = {
  'historical-dex-trades': `nansen research historical-dex-trades — Historical DEX trades for a token

USAGE:
  nansen research historical-dex-trades --token-address <addr> --from-date <YYYY-MM-DD> --to-date <YYYY-MM-DD> [--chain <chain>]`,
  'historical-pnl-leaderboard': `nansen research historical-pnl-leaderboard — Historical PnL leaderboard for a token

USAGE:
  nansen research historical-pnl-leaderboard --token-address <addr> --from-date <YYYY-MM-DD> --to-date <YYYY-MM-DD> [--chain <chain>]`,
  'historical-token-flow-summary': `nansen research historical-token-flow-summary — Historical token flow summary

USAGE:
  nansen research historical-token-flow-summary --token-address <addr> --from-date <YYYY-MM-DD> --to-date <YYYY-MM-DD> [--chain <chain>]

NOTE: This endpoint does not support pagination.`,
  'historical-token-quant-scores': `nansen research historical-token-quant-scores — Historical token quantitative scores

USAGE:
  nansen research historical-token-quant-scores --token-address <addr> --as-of-date <YYYY-MM-DD> [--chain <chain>]`,
  'historical-top-holders': `nansen research historical-top-holders — Historical top holders of a token

USAGE:
  nansen research historical-top-holders --token-address <addr> --as-of-date <YYYY-MM-DD> [--chain <chain>]`,
  'historical-who-bought-sold': `nansen research historical-who-bought-sold — Historical buyers/sellers of a token

USAGE:
  nansen research historical-who-bought-sold --token-address <addr> --from-date <YYYY-MM-DD> --to-date <YYYY-MM-DD> [--buy-or-sell BUY|SELL] [--chain <chain>]`,
  'historical-smart-money-balances': `nansen research historical-smart-money-balances — Historical smart money token balances

USAGE:
  nansen research historical-smart-money-balances --as-of-date <YYYY-MM-DD> [--chains c1,c2]

NOTE: This endpoint does not support order_by.`,
  'historical-token-screener': `nansen research historical-token-screener — Historical token screener

USAGE:
  nansen research historical-token-screener --timeframe-days <n> --to-date <YYYY-MM-DD> [--chains c1,c2]`,
  'historical-wallet-balances': `nansen research historical-wallet-balances — Historical token balances for a wallet

USAGE:
  nansen research historical-wallet-balances --address <addr> --as-of-date <YYYY-MM-DD> [--chain <chain>]`,
  'historical-tx-lookup': `nansen research historical-tx-lookup — Lookup a historical transaction by hash

USAGE:
  nansen research historical-tx-lookup --transaction-hash <hash> --as-of-date <YYYY-MM-DD> [--chain <chain>] [--block-timestamp "YYYY-MM-DD HH:MM:SS"]

NOTE: Providing --block-timestamp skips a slow hash-resolution step and returns results much faster.`,
  'historical-wallet-transactions': `nansen research historical-wallet-transactions — Historical transactions for a wallet

USAGE:
  nansen research historical-wallet-transactions --address <addr> --as-of-date <YYYY-MM-DD> [--chain <chain>]`,
};

export function buildResearchCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'research': async (args, apiInstance, flags, options) => {
      const sub = args[0];

      if (!sub || sub === 'help') {
        log(HELP_TOP);
        return;
      }

      if (!RESEARCH_HISTORICAL_SUBCOMMANDS.has(sub)) {
        throw new NansenError(
          `Unknown research subcommand: ${sub}. Available: ${SUBCOMMANDS.join(', ')}`,
          ErrorCode.UNKNOWN,
        );
      }

      if (flags.help || flags.h || args[1] === 'help') {
        log(SUB_HELP[sub] || HELP_TOP);
        return;
      }

      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const filters = options.filters || {};
      const { fromDate, toDate } = resolveDateRange(options);
      const asOfDate = options['as-of-date'];

      // Range-based token endpoints (require --from-date + --to-date)
      const rangeTokenHandlers = {
        'historical-dex-trades': () => apiInstance.researchDexTrades({
          tokenAddress: options['token-address'] || options.token,
          chain: options.chain,
          fromDate, toDate, filters, orderBy, pagination,
        }),
        'historical-pnl-leaderboard': () => apiInstance.researchPnlLeaderboard({
          tokenAddress: options['token-address'] || options.token,
          chain: options.chain,
          fromDate, toDate, filters, orderBy, pagination,
        }),
        'historical-token-flow-summary': () => apiInstance.researchTokenFlowSummary({
          tokenAddress: options['token-address'] || options.token,
          chain: options.chain,
          fromDate, toDate, filters, orderBy,
        }),
        'historical-who-bought-sold': () => apiInstance.researchWhoBoughtSold({
          tokenAddress: options['token-address'] || options.token,
          chain: options.chain,
          buyOrSell: options['buy-or-sell'],
          fromDate, toDate, filters, orderBy, pagination,
        }),
      };

      if (rangeTokenHandlers[sub]) {
        requireOptions(
          { 'token-address': options['token-address'] || options.token, 'from-date': fromDate, 'to-date': toDate },
          ['token-address', 'from-date', 'to-date'],
        );
        if (sub === 'historical-token-flow-summary' && (options.page || options.limit)) {
          throw new NansenError(
            'historical-token-flow-summary does not support --page or --limit (endpoint returns a single aggregated row)',
            ErrorCode.INVALID_PARAMS,
          );
        }
        return rangeTokenHandlers[sub]();
      }

      // As-of-date token endpoints (require --as-of-date)
      const asOfTokenHandlers = {
        'historical-token-quant-scores': () => apiInstance.researchTokenQuantScores({
          tokenAddress: options['token-address'] || options.token,
          chain: options.chain,
          asOfDate, filters, orderBy, pagination,
        }),
        'historical-top-holders': () => apiInstance.researchTopHolders({
          tokenAddress: options['token-address'] || options.token,
          chain: options.chain,
          asOfDate, filters, orderBy, pagination,
        }),
      };

      if (asOfTokenHandlers[sub]) {
        requireOptions(
          { 'token-address': options['token-address'] || options.token, 'as-of-date': asOfDate },
          ['token-address', 'as-of-date'],
        );
        return asOfTokenHandlers[sub]();
      }

      if (sub === 'historical-smart-money-balances') {
        if (options.sort || options['order-by']) {
          throw new NansenError(
            'historical-smart-money-balances does not support --sort or --order-by (endpoint does not support ordering)',
            ErrorCode.INVALID_PARAMS,
          );
        }
        requireOptions({ 'as-of-date': asOfDate }, ['as-of-date']);
        return apiInstance.researchSmartMoneyBalances({
          chains: parseChains(options),
          asOfDate, filters, pagination,
        });
      }

      if (sub === 'historical-token-screener') {
        const timeframeDays = parseTimeframeDays(options['timeframe-days']);
        requireOptions({ 'timeframe-days': timeframeDays, 'to-date': options['to-date'] }, ['timeframe-days', 'to-date']);
        return apiInstance.researchTokenScreener({
          chains: parseChains(options),
          timeframeDays,
          toDate: options['to-date'],
          filters, orderBy, pagination,
        });
      }

      if (sub === 'historical-wallet-balances') {
        requireOptions(
          { address: options.address, 'as-of-date': asOfDate },
          ['address', 'as-of-date'],
        );
        return apiInstance.researchWalletBalances({
          address: options.address,
          chain: options.chain,
          asOfDate, filters, orderBy, pagination,
        });
      }

      if (sub === 'historical-tx-lookup') {
        requireOptions(
          { 'transaction-hash': options['transaction-hash'], 'as-of-date': asOfDate },
          ['transaction-hash', 'as-of-date'],
        );
        return apiInstance.researchTxLookup({
          txHash: options['transaction-hash'],
          chain: options.chain,
          asOfDate,
          blockTimestamp: options['block-timestamp'],
        });
      }

      if (sub === 'historical-wallet-transactions') {
        requireOptions(
          { address: options.address, 'as-of-date': asOfDate },
          ['address', 'as-of-date'],
        );
        return apiInstance.researchWalletTransactions({
          address: options.address,
          chain: options.chain,
          asOfDate, filters, orderBy, pagination,
        });
      }

      // Should be unreachable because SUBCOMMANDS guarded above.
      throw new NansenError(`Unknown research subcommand: ${sub}`, ErrorCode.UNKNOWN);
    },
  };
}
