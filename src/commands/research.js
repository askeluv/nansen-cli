/**
 * Nansen CLI - Research command
 *
 * Direct API analytics, including historical/point-in-time research.
 */

import { NansenError, ErrorCode } from '../api.js';
import { parseSort } from '../query-options.js';

// Research subcommands validate --page strictly. The shared helper in
// src/query-options.js clamps an invalid page to 1 for the category commands,
// so keep a local variant here that rejects it instead.
function buildPagination(options) {
  if (options.limit === undefined && options.page === undefined) return undefined;
  const pagination = { page: 1 };
  if (options.page !== undefined) {
    const page = Number(options.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new NansenError('--page must be a positive integer', ErrorCode.INVALID_PARAMS);
    }
    pagination.page = page;
  }
  if (options.limit !== undefined) {
    const perPage = Number(options.limit);
    if (!Number.isInteger(perPage) || perPage < 1) {
      throw new NansenError('--limit must be a positive integer', ErrorCode.INVALID_PARAMS);
    }
    pagination.per_page = perPage;
  }
  return pagination;
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
  'historical-token-ohlcv',
];

export const RESEARCH_HISTORICAL_SUBCOMMANDS = new Set(SUBCOMMANDS);
export const RESEARCH_SUBCOMMANDS = new Set(['chain-rank', 'token-sectors', 'address-premium-labels', 'smart-money-pnl-leaderboard', 'position-intelligence', 'perp-pnl-summary', 'transaction-with-token-transfer-lookup', ...SUBCOMMANDS]);

const CHAIN_RANK_TIMEFRAMES = new Set([7, 30, 365]);
const CHAIN_RANK_CHAIN_TYPES = new Set(['all', 'evm']);

const SM_PNL_TIMEFRAME_DAYS = [1, 7, 30, 90, 180];

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
  const trimmed = String(value).trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new NansenError('--timeframe-days must be a positive integer', ErrorCode.INVALID_PARAMS);
  }
  return parseInt(trimmed, 10);
}

function parseBooleanOption(options, flags, key) {
  const value = options[key] ?? flags[key];
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new NansenError(`--${key} must be true or false`, ErrorCode.INVALID_PARAMS);
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

const HELP_TOP = `nansen research — Direct API analytics

SUBCOMMANDS:
  chain-rank                       Rank chains by growth metrics
  token-sectors                     List token sectors available for filtering
  address-premium-labels            Get all labels for an address, including premium labels
  smart-money-pnl-leaderboard       Rank smart money wallets by PnL
  position-intelligence             Aggregate Hyperliquid positions by trader cohort
  perp-pnl-summary                  Summarize realized Hyperliquid PnL for an address
  transaction-with-token-transfer-lookup
                                   Look up a transaction and its token/NFT transfers
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
  historical-token-ohlcv            Historical token OHLCV candles

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
  'chain-rank': `nansen research chain-rank — Rank chains by growth metrics

USAGE:
  nansen research chain-rank [--timeframe-days 7|30|365] [--chain-type all|evm]`,
  'token-sectors': `nansen research token-sectors — List token sectors available for filtering

USAGE:
  nansen research token-sectors`,
  'address-premium-labels': `nansen research address-premium-labels — Get all labels for an address, including premium labels

USAGE:
  nansen research address-premium-labels --address <addr> [--chain <chain>] [--page <n>] [--limit <n>]`,
  'smart-money-pnl-leaderboard': `nansen research smart-money-pnl-leaderboard — Rank smart money wallets by PnL

USAGE:
  nansen research smart-money-pnl-leaderboard [--chains c1,c2] [--timeframe-days 1|7|30|90|180] [--filters '<json>'] [--sort <field[:asc|desc]>] [--page <n>] [--limit <n>]`,
  'position-intelligence': `nansen research position-intelligence — Aggregate Hyperliquid positions by trader cohort

USAGE:
  nansen research position-intelligence --symbol <symbol>

NOTE: --token-address is accepted as an alias for --symbol (the API request field is token_address).`,
  'perp-pnl-summary': `nansen research perp-pnl-summary — Summarize realized Hyperliquid PnL for an address

USAGE:
  nansen research perp-pnl-summary --address <addr> --from-date <date> --to-date <date>`,
  'transaction-with-token-transfer-lookup': `nansen research transaction-with-token-transfer-lookup — Look up a transaction and its token/NFT transfers

USAGE:
  nansen research transaction-with-token-transfer-lookup --transaction-hash <hash> [--chain <chain>] [--block-timestamp "YYYY-MM-DD HH:MM:SS"]

NOTE: --block-timestamp is required for bitcoin, tron, ton, starknet, and sui.`,
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
  'historical-token-ohlcv': `nansen research historical-token-ohlcv — Historical token OHLCV candles

USAGE:
  nansen research historical-token-ohlcv --token-address <addr> --from-date <date> --timeframe <5m|15m|30m|1h|1d|1w> (--as-of-date <date> | --as-of-ts <timestamp>) [--chain <chain>] [--apply-blacklist-filter <true|false>]`,
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

      if (!RESEARCH_SUBCOMMANDS.has(sub)) {
        throw new NansenError(
          `Unknown research subcommand: ${sub}. Available: ${[...RESEARCH_SUBCOMMANDS].join(', ')}`,
          ErrorCode.UNKNOWN,
        );
      }

      if (flags.help || flags.h || args[1] === 'help') {
        log(SUB_HELP[sub] || HELP_TOP);
        return;
      }

      if (sub === 'token-sectors') return apiInstance.tokenSectors();

      const orderBy = parseSort(options.sort, options['order-by']);
      const pagination = buildPagination(options);
      const filters = options.filters || {};
      const { fromDate, toDate } = resolveDateRange(options);
      const asOfDate = options['as-of-date'];

      if (sub === 'chain-rank') {
        const timeFrame = parseTimeframeDays(options['timeframe-days']) ?? 7;
        if (!CHAIN_RANK_TIMEFRAMES.has(timeFrame)) {
          throw new NansenError(
            `--timeframe-days must be one of: ${[...CHAIN_RANK_TIMEFRAMES].join(', ')}`,
            ErrorCode.INVALID_PARAMS,
          );
        }
        const chainType = options['chain-type'] || 'all';
        if (!CHAIN_RANK_CHAIN_TYPES.has(chainType)) {
          throw new NansenError(
            `--chain-type must be one of: ${[...CHAIN_RANK_CHAIN_TYPES].join(', ')}`,
            ErrorCode.INVALID_PARAMS,
          );
        }
        return apiInstance.chainRank({ timeFrame, chainType });
      }

      if (sub === 'address-premium-labels') {
        requireOptions({ address: options.address }, ['address']);
        return apiInstance.addressPremiumLabels({
          address: options.address,
          chain: options.chain || 'all',
          pagination,
        });
      }

      if (sub === 'smart-money-pnl-leaderboard') {
        const timeframe = parseTimeframeDays(options['timeframe-days']) ?? 7;
        if (!SM_PNL_TIMEFRAME_DAYS.includes(timeframe)) {
          throw new NansenError(
            `--timeframe-days must be one of: ${SM_PNL_TIMEFRAME_DAYS.join(', ')}`,
            ErrorCode.INVALID_PARAMS,
          );
        }
        return apiInstance.smartMoneyPnlLeaderboard({
          chains: parseChains(options) || ['solana'],
          timeframe,
          filters, orderBy, pagination,
        });
      }

      if (sub === 'position-intelligence') {
        const symbol = String(options.symbol || options['token-address'] || options.token || '').trim();
        if (!symbol) {
          throw new NansenError(
            'Required: --symbol (or --token-address)',
            ErrorCode.MISSING_PARAM,
          );
        }
        return apiInstance.tokenPositionIntelligence({ tokenAddress: symbol });
      }

      if (sub === 'perp-pnl-summary') {
        requireOptions(
          { address: options.address, 'from-date': fromDate, 'to-date': toDate },
          ['address', 'from-date', 'to-date'],
        );
        return apiInstance.addressPerpPnlSummary({ address: options.address, fromDate, toDate });
      }

      if (sub === 'historical-token-ohlcv') {
        const tokenAddress = options['token-address'] || options.token;
        const asOfTs = options['as-of-ts'];
        requireOptions(
          { 'token-address': tokenAddress, 'from-date': fromDate, timeframe: options.timeframe },
          ['token-address', 'from-date', 'timeframe'],
        );
        if (!asOfDate && !asOfTs) {
          throw new NansenError(
            'Provide one of --as-of-date or --as-of-ts',
            ErrorCode.MISSING_PARAM,
          );
        }
        if (asOfDate && asOfTs) {
          throw new NansenError(
            '--as-of-date and --as-of-ts are mutually exclusive',
            ErrorCode.INVALID_PARAMS,
          );
        }
        return apiInstance.researchHistoricalTokenOhlcv({
          tokenAddress,
          chain: options.chain || 'solana',
          fromDate,
          asOfDate,
          asOfTs,
          timeframe: options.timeframe,
          applyBlacklistFilter: parseBooleanOption(options, flags, 'apply-blacklist-filter'),
        });
      }

      if (sub === 'transaction-with-token-transfer-lookup') {
        const chain = options.chain || 'ethereum';
        const blockTimestamp = options['block-timestamp'];
        requireOptions({ 'transaction-hash': options['transaction-hash'] }, ['transaction-hash']);
        // Chains the API rejects without block_timestamp. Every other enum value,
        // including 'all', near, and injective, accepts a timestamp-less lookup.
        if (['bitcoin', 'tron', 'ton', 'starknet', 'sui'].includes(chain)) {
          requireOptions({ 'block-timestamp': blockTimestamp }, ['block-timestamp']);
        }
        return apiInstance.transactionWithTokenTransferLookup({
          transactionHash: options['transaction-hash'],
          chain,
          blockTimestamp,
        });
      }

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
