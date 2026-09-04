/**
 * Tests for the `nansen research` historical analytics subcommands.
 *
 * Covers:
 *   1. NansenAPI methods → correct URL + request body shape (one describe block per method)
 *   2. The CLI command handler → wires options through to the right method and enforces required fields
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { NansenAPI, NansenError } from '../api.js';
import { buildResearchCommands, RESEARCH_HISTORICAL_SUBCOMMANDS, RESEARCH_SUBCOMMANDS } from '../commands/research.js';

const FROM = '2025-01-01';
const TO = '2025-01-31';
const AS_OF = '2025-01-31';

const TOKENS = {
  solana: 'So11111111111111111111111111111111111111112',
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
};

const ADDRESSES = {
  ethereum: '0x28c6c06298d514db089934071355e5743bf21d60',
};

describe('NansenAPI research (historical) methods', () => {
  let api;
  let mockFetch;
  const originalFetch = global.fetch;

  beforeAll(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    api = new NansenAPI('test-api-key', 'https://api.nansen.ai');
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function setupMock(response = { data: [] }) {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });
  }

  function lastCall(expectedEndpoint) {
    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(url).toBe(`https://api.nansen.ai${expectedEndpoint}`);
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    return JSON.parse(options.body);
  }

  it('uses the chain-rank endpoint and request shape', async () => {
    setupMock();
    await api.chainRank({ timeFrame: 30, chainType: 'evm' });
    const body = lastCall('/api/v1/chains/chain-rank');
    expect(body).toEqual({ time_frame: 30, chain_type: 'evm' });
  });

  it('uses the token-sectors endpoint with GET', async () => {
    setupMock();
    await api.tokenSectors();
    const [url, request] = mockFetch.mock.calls.at(-1);
    expect(url).toBe('https://api.nansen.ai/api/v1/search/token-sectors');
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
  });

  it('uses the premium-labels endpoint and request shape', async () => {
    setupMock();
    await api.addressPremiumLabels({
      address: ADDRESSES.ethereum,
      chain: 'ethereum',
      pagination: { page: 2, per_page: 5 },
    });
    const body = lastCall('/api/v1/profiler/address/premium-labels');
    expect(body).toEqual({
      address: ADDRESSES.ethereum,
      chain: 'ethereum',
      pagination: { page: 2, per_page: 5 },
    });
  });

  it('uses the smart money PnL leaderboard endpoint and request shape', async () => {
    setupMock();
    await api.smartMoneyPnlLeaderboard({
      chains: ['ethereum'],
      timeframe: 30,
      filters: { include_smart_money_labels: ['Fund'] },
      orderBy: [{ field: 'total_pnl_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: 10 },
    });
    const body = lastCall('/api/v1/smart-money/pnl-leaderboard');
    expect(body).toEqual({
      chains: ['ethereum'],
      timeframe: 30,
      filters: { include_smart_money_labels: ['Fund'] },
      order_by: [{ field: 'total_pnl_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: 10 },
    });
  });

  it('uses the position-intelligence endpoint and request shape', async () => {
    setupMock();
    await api.tokenPositionIntelligence({ tokenAddress: 'BTC' });
    const body = lastCall('/api/v1/tgm/position-intelligence');
    expect(body).toEqual({ token_address: 'BTC' });
  });

  it('uses the perp PnL summary endpoint and request shape', async () => {
    setupMock();
    await api.addressPerpPnlSummary({
      address: ADDRESSES.ethereum,
      fromDate: FROM,
      toDate: TO,
    });
    const body = lastCall('/api/v1/profiler/perp-pnl-summary');
    expect(body).toEqual({
      address: ADDRESSES.ethereum,
      date: { from: FROM, to: TO },
    });
  });

  it('uses the historical token OHLCV endpoint and request shape', async () => {
    setupMock();
    await api.researchHistoricalTokenOhlcv({
      tokenAddress: TOKENS.solana,
      chain: 'solana',
      fromDate: FROM,
      asOfDate: TO,
      timeframe: '1d',
      applyBlacklistFilter: false,
    });
    const body = lastCall('/api/v1beta1/tgm/historical-token-ohlcv');
    expect(body).toEqual({
      token_address: TOKENS.solana,
      chain: 'solana',
      date_from: FROM,
      as_of_date: TO,
      timeframe: '1d',
      apply_blacklist_filter: false,
    });
  });

  it('sends as_of_ts and omits as_of_date when only asOfTs is supplied', async () => {
    setupMock();
    await api.researchHistoricalTokenOhlcv({
      tokenAddress: TOKENS.solana,
      chain: 'solana',
      fromDate: FROM,
      asOfTs: `${TO}T00:00:00Z`,
      timeframe: '1h',
    });
    const body = lastCall('/api/v1beta1/tgm/historical-token-ohlcv');
    expect(body).toEqual({
      token_address: TOKENS.solana,
      chain: 'solana',
      date_from: FROM,
      as_of_ts: `${TO}T00:00:00Z`,
      timeframe: '1h',
    });
  });

  it('rejects asOfDate and asOfTs together at the API layer', async () => {
    await expect(api.researchHistoricalTokenOhlcv({
      tokenAddress: TOKENS.solana,
      chain: 'solana',
      fromDate: FROM,
      asOfDate: TO,
      asOfTs: `${TO}T00:00:00Z`,
      timeframe: '1d',
    })).rejects.toThrow(/mutually exclusive/);
  });

  describe('researchDexTrades', () => {
    it('hits historical-dex-trades with token_address, chain, and date_range {from,to}', async () => {
      setupMock();
      await api.researchDexTrades({
        tokenAddress: TOKENS.solana,
        chain: 'solana',
        fromDate: FROM,
        toDate: TO,
      });
      const body = lastCall('/api/v1beta1/tgm/historical-dex-trades');
      expect(body.token_address).toBe(TOKENS.solana);
      expect(body.chain).toBe('solana');
      expect(body.date_range).toEqual({ from: FROM, to: TO });
    });
  });

  describe('researchPnlLeaderboard', () => {
    it('hits historical-pnl-leaderboard with token_address and date_range {from,to}', async () => {
      setupMock();
      await api.researchPnlLeaderboard({
        tokenAddress: TOKENS.solana,
        fromDate: FROM,
        toDate: TO,
      });
      const body = lastCall('/api/v1beta1/tgm/historical-pnl-leaderboard');
      expect(body.token_address).toBe(TOKENS.solana);
      expect(body.chain).toBe('solana');
      expect(body.date_range).toEqual({ from: FROM, to: TO });
    });
  });

  describe('researchTokenFlowSummary', () => {
    it('hits historical-token-flow-summary and does NOT include pagination', async () => {
      setupMock();
      await api.researchTokenFlowSummary({
        tokenAddress: TOKENS.solana,
        fromDate: FROM,
        toDate: TO,
        pagination: { page: 1, per_page: 50 }, // caller-provided pagination must be dropped
      });
      const body = lastCall('/api/v1beta1/tgm/historical-token-flow-summary');
      expect(body.token_address).toBe(TOKENS.solana);
      expect(body.date_range).toEqual({ from: FROM, to: TO });
      expect(body.pagination).toBeUndefined();
    });
  });

  describe('researchTokenQuantScores', () => {
    it('hits historical-token-quant-scores with token_address and as_of_date', async () => {
      setupMock();
      await api.researchTokenQuantScores({
        tokenAddress: TOKENS.solana,
        asOfDate: AS_OF,
      });
      const body = lastCall('/api/v1beta1/tgm/historical-token-quant-scores');
      expect(body.token_address).toBe(TOKENS.solana);
      expect(body.as_of_date).toBe(AS_OF);
      expect(body.date_range).toBeUndefined();
    });
  });

  describe('researchTopHolders', () => {
    it('hits historical-top-holders with token_address and as_of_date', async () => {
      setupMock();
      await api.researchTopHolders({
        tokenAddress: TOKENS.solana,
        asOfDate: AS_OF,
      });
      const body = lastCall('/api/v1beta1/tgm/historical-top-holders');
      expect(body.token_address).toBe(TOKENS.solana);
      expect(body.as_of_date).toBe(AS_OF);
      expect(body.date_range).toBeUndefined();
    });
  });

  describe('researchWhoBoughtSold', () => {
    it('hits historical-who-bought-sold with buy_or_sell defaulting to BUY', async () => {
      setupMock();
      await api.researchWhoBoughtSold({
        tokenAddress: TOKENS.solana,
        fromDate: FROM,
        toDate: TO,
      });
      const body = lastCall('/api/v1beta1/tgm/historical-who-bought-sold');
      expect(body.token_address).toBe(TOKENS.solana);
      expect(body.buy_or_sell).toBe('BUY');
      expect(body.date_range).toEqual({ from: FROM, to: TO });
    });

    it('passes buy_or_sell when explicitly set', async () => {
      setupMock();
      await api.researchWhoBoughtSold({
        tokenAddress: TOKENS.solana,
        fromDate: FROM,
        toDate: TO,
        buyOrSell: 'SELL',
      });
      const body = lastCall('/api/v1beta1/tgm/historical-who-bought-sold');
      expect(body.buy_or_sell).toBe('SELL');
    });
  });

  describe('researchSmartMoneyBalances', () => {
    it('hits smart-money/historical-token-balances with as_of_date and does NOT include order_by', async () => {
      setupMock();
      await api.researchSmartMoneyBalances({
        chains: ['solana', 'ethereum'],
        asOfDate: AS_OF,
        orderBy: [{ field: 'value_usd', direction: 'DESC' }], // caller-provided order_by must be dropped
      });
      const body = lastCall('/api/v1beta1/smart-money/historical-token-balances');
      expect(body.chains).toEqual(['solana', 'ethereum']);
      expect(body.as_of_date).toBe(AS_OF);
      expect(body.order_by).toBeUndefined();
      expect(body.date_range).toBeUndefined();
    });
  });

  describe('researchTokenScreener', () => {
    it('hits token-screener/historical with chains and timeframe_days', async () => {
      setupMock();
      await api.researchTokenScreener({
        chains: ['solana'],
        timeframeDays: 30,
      });
      const body = lastCall('/api/v1beta1/token-screener/historical');
      expect(body.chains).toEqual(['solana']);
      expect(body.timeframe_days).toBe(30);
      expect(body.date_range).toBeUndefined();
    });

    it('includes optional to_date when provided', async () => {
      setupMock();
      await api.researchTokenScreener({
        chains: ['solana'],
        timeframeDays: 7,
        toDate: TO,
      });
      const body = lastCall('/api/v1beta1/token-screener/historical');
      expect(body.timeframe_days).toBe(7);
      expect(body.to_date).toBe(TO);
    });
  });

  describe('researchWalletBalances', () => {
    it('hits profiler/address/historical-token-balances with address and as_of_date', async () => {
      setupMock();
      await api.researchWalletBalances({
        address: ADDRESSES.ethereum,
        chain: 'ethereum',
        asOfDate: AS_OF,
      });
      const body = lastCall('/api/v1beta1/profiler/address/historical-token-balances');
      expect(body.address).toBe(ADDRESSES.ethereum);
      expect(body.chain).toBe('ethereum');
      expect(body.as_of_date).toBe(AS_OF);
      expect(body.date_range).toBeUndefined();
    });
  });

  describe('researchTxLookup', () => {
    it('hits profiler/historical-transaction-lookup with transaction_hash and as_of_date', async () => {
      setupMock();
      await api.researchTxLookup({
        txHash: '0xabc123',
        chain: 'ethereum',
        asOfDate: AS_OF,
      });
      const body = lastCall('/api/v1beta1/profiler/historical-transaction-lookup');
      expect(body.transaction_hash).toBe('0xabc123');
      expect(body.tx_hash).toBeUndefined();
      expect(body.chain).toBe('ethereum');
      expect(body.as_of_date).toBe(AS_OF);
      expect(body.date_range).toBeUndefined();
    });
  });

  describe('researchWalletTransactions', () => {
    it('hits profiler/address/historical-transactions with address and as_of_date', async () => {
      setupMock();
      await api.researchWalletTransactions({
        address: ADDRESSES.ethereum,
        chain: 'ethereum',
        asOfDate: AS_OF,
      });
      const body = lastCall('/api/v1beta1/profiler/address/historical-transactions');
      expect(body.address).toBe(ADDRESSES.ethereum);
      expect(body.chain).toBe('ethereum');
      expect(body.as_of_date).toBe(AS_OF);
      expect(body.date_range).toBeUndefined();
    });
  });
});

describe('buildResearchCommands handler', () => {
  let mockApi;
  let cmds;

  beforeAll(() => {
    cmds = buildResearchCommands({ log: () => {} });
  });

  function makeMockApi() {
    return {
      researchDexTrades: vi.fn().mockResolvedValue({ data: [] }),
      researchPnlLeaderboard: vi.fn().mockResolvedValue({ data: [] }),
      researchTokenFlowSummary: vi.fn().mockResolvedValue({ data: [] }),
      researchTokenQuantScores: vi.fn().mockResolvedValue({ data: [] }),
      researchTopHolders: vi.fn().mockResolvedValue({ data: [] }),
      researchWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] }),
      researchSmartMoneyBalances: vi.fn().mockResolvedValue({ data: [] }),
      researchTokenScreener: vi.fn().mockResolvedValue({ data: [] }),
      researchWalletBalances: vi.fn().mockResolvedValue({ data: [] }),
      researchTxLookup: vi.fn().mockResolvedValue({ data: [] }),
      researchWalletTransactions: vi.fn().mockResolvedValue({ data: [] }),
      chainRank: vi.fn().mockResolvedValue({ data: [] }),
      tokenSectors: vi.fn().mockResolvedValue({ data: [] }),
      addressPremiumLabels: vi.fn().mockResolvedValue({ data: [] }),
      smartMoneyPnlLeaderboard: vi.fn().mockResolvedValue({ data: [] }),
      tokenPositionIntelligence: vi.fn().mockResolvedValue({ data: [] }),
      addressPerpPnlSummary: vi.fn().mockResolvedValue({ data: [] }),
      researchHistoricalTokenOhlcv: vi.fn().mockResolvedValue({ data: [] }),
    };
  }

  it('exports historical and direct subcommands', () => {
    expect(RESEARCH_HISTORICAL_SUBCOMMANDS.size).toBe(12);
    expect(RESEARCH_SUBCOMMANDS.size).toBe(18);
  });

  it('dispatches chain-rank', async () => {
    mockApi = makeMockApi();
    await cmds.research(['chain-rank'], mockApi, {}, {
      'timeframe-days': '30', 'chain-type': 'evm',
    });
    expect(mockApi.chainRank).toHaveBeenCalledWith({ timeFrame: 30, chainType: 'evm' });
  });

  it('rejects chain-rank with a timeframe outside 7/30/365', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['chain-rank'], mockApi, {}, { 'timeframe-days': '99' }))
      .rejects.toThrow('--timeframe-days must be one of: 7, 30, 365');
    expect(mockApi.chainRank).not.toHaveBeenCalled();
  });

  it('rejects non-integer --timeframe-days values', async () => {
    mockApi = makeMockApi();
    for (const value of ['30.5', '30abc', '-7', '0']) {
      await expect(cmds.research(['chain-rank'], mockApi, {}, { 'timeframe-days': value }))
        .rejects.toThrow('--timeframe-days must be a positive integer');
    }
    expect(mockApi.chainRank).not.toHaveBeenCalled();
  });

  it('rejects --timeframe-days 0 on historical-token-screener (API requires at least 1)', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-token-screener'], mockApi, {}, {
      'timeframe-days': '0', 'to-date': TO,
    })).rejects.toThrow('--timeframe-days must be a positive integer');
    expect(mockApi.researchTokenScreener).not.toHaveBeenCalled();
  });

  it('prints chain-rank help without calling the API', async () => {
    mockApi = makeMockApi();
    const logged = [];
    const helpCmds = buildResearchCommands({ log: line => logged.push(line) });
    await helpCmds.research(['chain-rank', 'help'], mockApi, {}, {});
    expect(logged.join('\n')).toContain('nansen research chain-rank');
    expect(mockApi.chainRank).not.toHaveBeenCalled();
  });

  it('rejects chain-rank with an unknown chain type', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['chain-rank'], mockApi, {}, { 'chain-type': 'solana' }))
      .rejects.toThrow('--chain-type must be one of: all, evm');
    expect(mockApi.chainRank).not.toHaveBeenCalled();
  });

  it('dispatches token-sectors', async () => {
    mockApi = makeMockApi();
    await cmds.research(['token-sectors'], mockApi, {}, {});
    expect(mockApi.tokenSectors).toHaveBeenCalledWith();
  });

  it('dispatches address-premium-labels', async () => {
    mockApi = makeMockApi();
    await cmds.research(['address-premium-labels'], mockApi, {}, {
      address: ADDRESSES.ethereum, chain: 'ethereum', page: '2', limit: '5',
    });
    expect(mockApi.addressPremiumLabels).toHaveBeenCalledWith({
      address: ADDRESSES.ethereum,
      chain: 'ethereum',
      pagination: { page: 2, per_page: 5 },
    });
  });

  it('omits per_page when only --page is supplied', async () => {
    mockApi = makeMockApi();
    await cmds.research(['address-premium-labels'], mockApi, {}, {
      address: ADDRESSES.ethereum, page: '3',
    });
    expect(mockApi.addressPremiumLabels).toHaveBeenCalledWith({
      address: ADDRESSES.ethereum,
      chain: 'all',
      pagination: { page: 3 },
    });
  });

  it('rejects an invalid pagination limit', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['address-premium-labels'], mockApi, {}, {
      address: ADDRESSES.ethereum, limit: '5x',
    })).rejects.toThrow(/positive integer/);
  });

  it('rejects an invalid pagination page', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['address-premium-labels'], mockApi, {}, {
      address: ADDRESSES.ethereum, page: '0',
    })).rejects.toThrow(/--page must be a positive integer/);
  });

  it('rejects an invalid --page on historical subcommands', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-dex-trades'], mockApi, {}, {
      'token-address': TOKENS.solana, 'from-date': FROM, 'to-date': TO, page: '0',
    })).rejects.toThrow(/--page must be a positive integer/);
  });

  it('dispatches smart-money-pnl-leaderboard', async () => {
    mockApi = makeMockApi();
    await cmds.research(['smart-money-pnl-leaderboard'], mockApi, {}, {
      chains: 'ethereum,solana', 'timeframe-days': '30', page: '2', limit: '5',
    });
    expect(mockApi.smartMoneyPnlLeaderboard).toHaveBeenCalledWith(expect.objectContaining({
      chains: ['ethereum', 'solana'],
      timeframe: 30,
      pagination: { page: 2, per_page: 5 },
    }));
  });

  it('rejects an invalid smart money leaderboard limit', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['smart-money-pnl-leaderboard'], mockApi, {}, {
      limit: '5x',
    })).rejects.toThrow(/positive integer/);
  });

  it('rejects an unsupported smart money leaderboard timeframe', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['smart-money-pnl-leaderboard'], mockApi, {}, {
      'timeframe-days': '14',
    })).rejects.toThrow(/must be one of: 1, 7, 30, 90, 180/);
    expect(mockApi.smartMoneyPnlLeaderboard).not.toHaveBeenCalled();
  });

  it('dispatches position-intelligence', async () => {
    mockApi = makeMockApi();
    await cmds.research(['position-intelligence'], mockApi, {}, { symbol: 'BTC' });
    expect(mockApi.tokenPositionIntelligence).toHaveBeenCalledWith({ tokenAddress: 'BTC' });
  });

  it('dispatches position-intelligence via the --token-address alias', async () => {
    mockApi = makeMockApi();
    await cmds.research(['position-intelligence'], mockApi, {}, { 'token-address': 'BTC' });
    expect(mockApi.tokenPositionIntelligence).toHaveBeenCalledWith({ tokenAddress: 'BTC' });
  });

  it('requires a position-intelligence symbol', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['position-intelligence'], mockApi, {}, {}))
      .rejects.toThrow(/--symbol \(or --token-address\)/);
  });

  it('rejects an empty or whitespace-only position-intelligence symbol', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['position-intelligence'], mockApi, {}, { symbol: '' }))
      .rejects.toThrow(/--symbol/);
    await expect(cmds.research(['position-intelligence'], mockApi, {}, { symbol: '   ' }))
      .rejects.toThrow(/--symbol/);
    expect(mockApi.tokenPositionIntelligence).not.toHaveBeenCalled();
  });

  it('dispatches perp-pnl-summary', async () => {
    mockApi = makeMockApi();
    await cmds.research(['perp-pnl-summary'], mockApi, {}, {
      address: ADDRESSES.ethereum, 'from-date': FROM, 'to-date': TO,
    });
    expect(mockApi.addressPerpPnlSummary).toHaveBeenCalledWith({
      address: ADDRESSES.ethereum,
      fromDate: FROM,
      toDate: TO,
    });
  });

  it('requires a complete perp PnL date range', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['perp-pnl-summary'], mockApi, {}, {
      address: ADDRESSES.ethereum, 'from-date': FROM,
    })).rejects.toThrow(/to-date/);
  });

  it('requires an address for perp PnL summary', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['perp-pnl-summary'], mockApi, {}, {
      'from-date': FROM, 'to-date': TO,
    })).rejects.toThrow(/address/);
    expect(mockApi.addressPerpPnlSummary).not.toHaveBeenCalled();
  });

  it('dispatches historical-token-ohlcv', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-token-ohlcv'], mockApi, {}, {
      'token-address': TOKENS.solana,
      chain: 'solana',
      'from-date': FROM,
      'as-of-date': TO,
      timeframe: '1d',
      'apply-blacklist-filter': 'false',
    });
    expect(mockApi.researchHistoricalTokenOhlcv).toHaveBeenCalledWith({
      tokenAddress: TOKENS.solana,
      chain: 'solana',
      fromDate: FROM,
      asOfDate: TO,
      asOfTs: undefined,
      timeframe: '1d',
      applyBlacklistFilter: false,
    });
  });

  it('requires exactly one historical OHLCV snapshot anchor', async () => {
    mockApi = makeMockApi();
    const options = { 'token-address': TOKENS.solana, 'from-date': FROM, timeframe: '1d' };
    await expect(cmds.research(['historical-token-ohlcv'], mockApi, {}, options))
      .rejects.toThrow(/one of --as-of-date or --as-of-ts/);
    await expect(cmds.research(['historical-token-ohlcv'], mockApi, {}, {
      ...options, 'as-of-date': TO, 'as-of-ts': `${TO}T00:00:00Z`,
    })).rejects.toThrow(/mutually exclusive/);
  });

  it('rejects unknown subcommand', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['not-a-real-sub'], mockApi, {}, {}))
      .rejects.toThrow(NansenError);
  });

  it('dispatches historical-dex-trades with token/from-date/to-date wiring', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-dex-trades'], mockApi, {}, {
      'token-address': TOKENS.solana,
      'from-date': FROM,
      'to-date': TO,
      chain: 'solana',
    });
    expect(mockApi.researchDexTrades).toHaveBeenCalledWith(expect.objectContaining({
      tokenAddress: TOKENS.solana,
      fromDate: FROM,
      toDate: TO,
      chain: 'solana',
    }));
  });

  it('dispatches historical-pnl-leaderboard', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-pnl-leaderboard'], mockApi, {}, {
      'token-address': TOKENS.solana, 'from-date': FROM, 'to-date': TO,
    });
    expect(mockApi.researchPnlLeaderboard).toHaveBeenCalled();
  });

  it('dispatches historical-token-flow-summary', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-token-flow-summary'], mockApi, {}, {
      'token-address': TOKENS.solana, 'from-date': FROM, 'to-date': TO,
    });
    expect(mockApi.researchTokenFlowSummary).toHaveBeenCalled();
  });

  it('dispatches historical-token-quant-scores with --as-of-date', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-token-quant-scores'], mockApi, {}, {
      'token-address': TOKENS.solana, 'as-of-date': AS_OF,
    });
    expect(mockApi.researchTokenQuantScores).toHaveBeenCalledWith(expect.objectContaining({
      asOfDate: AS_OF,
    }));
  });

  it('dispatches historical-top-holders with --as-of-date', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-top-holders'], mockApi, {}, {
      'token-address': TOKENS.solana, 'as-of-date': AS_OF,
    });
    expect(mockApi.researchTopHolders).toHaveBeenCalledWith(expect.objectContaining({
      asOfDate: AS_OF,
    }));
  });

  it('dispatches historical-who-bought-sold and passes --buy-or-sell', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-who-bought-sold'], mockApi, {}, {
      'token-address': TOKENS.solana, 'from-date': FROM, 'to-date': TO, 'buy-or-sell': 'SELL',
    });
    expect(mockApi.researchWhoBoughtSold).toHaveBeenCalledWith(expect.objectContaining({
      buyOrSell: 'SELL',
    }));
  });

  it('dispatches historical-smart-money-balances with chains and --as-of-date', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-smart-money-balances'], mockApi, {}, {
      'as-of-date': AS_OF, chains: 'solana,ethereum',
    });
    expect(mockApi.researchSmartMoneyBalances).toHaveBeenCalledWith(expect.objectContaining({
      chains: ['solana', 'ethereum'],
      asOfDate: AS_OF,
    }));
  });

  it('dispatches historical-token-screener with --timeframe-days and --to-date', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-token-screener'], mockApi, {}, {
      'timeframe-days': '30', 'to-date': TO, chains: 'solana',
    });
    expect(mockApi.researchTokenScreener).toHaveBeenCalledWith(expect.objectContaining({
      chains: ['solana'],
      timeframeDays: 30,
      toDate: TO,
    }));
  });

  it('dispatches historical-wallet-balances with --as-of-date', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-wallet-balances'], mockApi, {}, {
      address: ADDRESSES.ethereum, chain: 'ethereum',
      'as-of-date': AS_OF,
    });
    expect(mockApi.researchWalletBalances).toHaveBeenCalledWith(expect.objectContaining({
      address: ADDRESSES.ethereum,
      chain: 'ethereum',
      asOfDate: AS_OF,
    }));
  });

  it('dispatches historical-tx-lookup', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-tx-lookup'], mockApi, {}, {
      'transaction-hash': '0xabc', 'as-of-date': AS_OF,
    });
    expect(mockApi.researchTxLookup).toHaveBeenCalledWith(expect.objectContaining({
      txHash: '0xabc',
      asOfDate: AS_OF,
    }));
  });

  it('dispatches historical-wallet-transactions with --as-of-date', async () => {
    mockApi = makeMockApi();
    await cmds.research(['historical-wallet-transactions'], mockApi, {}, {
      address: ADDRESSES.ethereum, 'as-of-date': AS_OF,
    });
    expect(mockApi.researchWalletTransactions).toHaveBeenCalledWith(expect.objectContaining({
      asOfDate: AS_OF,
    }));
  });

  it('errors when required token-address is missing', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-dex-trades'], mockApi, {}, { 'from-date': FROM, 'to-date': TO }))
      .rejects.toThrow(/token-address/);
  });

  it('errors when required from-date/to-date are missing on range subcommands', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-dex-trades'], mockApi, {}, { 'token-address': TOKENS.solana }))
      .rejects.toThrow(/from-date/);
  });

  it('errors when required --as-of-date is missing on snapshot subcommands', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-top-holders'], mockApi, {}, { 'token-address': TOKENS.solana }))
      .rejects.toThrow(/as-of-date/);
  });

  it('errors when --timeframe-days is missing on historical-token-screener', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-token-screener'], mockApi, {}, { chains: 'solana' }))
      .rejects.toThrow(/timeframe-days/);
  });

  it('rejects --page/--limit on historical-token-flow-summary', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-token-flow-summary'], mockApi, {}, {
      'token-address': TOKENS.solana, 'from-date': FROM, 'to-date': TO, page: 2, limit: 5,
    })).rejects.toThrow(/does not support/);
  });

  it('rejects --sort on historical-smart-money-balances', async () => {
    mockApi = makeMockApi();
    await expect(cmds.research(['historical-smart-money-balances'], mockApi, {}, {
      'as-of-date': AS_OF, sort: 'value_usd:desc',
    })).rejects.toThrow(/does not support/);
  });
});
