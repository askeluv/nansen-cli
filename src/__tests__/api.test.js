/**
 * Nansen API Test Suite
 * 
 * Run with mocks: npm test
 * Run with live API: npm run test:live (requires NANSEN_API_KEY)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NansenAPI, ErrorCode } from '../api.js';

const LIVE_TEST = process.env.NANSEN_LIVE_TEST === '1';
const API_KEY = process.env.NANSEN_API_KEY || 'test-key';

// Test addresses/tokens
const TEST_DATA = {
  ethereum: {
    address: '0x28c6c06298d514db089934071355e5743bf21d60', // Binance hot wallet
    token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  },
  solana: {
    address: 'Gu29tjXrVr9v5n42sX1DNrMiF3BwbrTm379szgB9qXjc',
    token: 'So11111111111111111111111111111111111111112', // SOL
  },
};

// Mock responses for unit tests
const MOCK_RESPONSES = {
  account: {
    plan: 'pro',
    credits_remaining: 9800
  },
  smartMoneyNetflow: {
    netflows: [
      { token_address: 'abc', token_symbol: 'TEST', inflow_usd: 1000, outflow_usd: 500 }
    ]
  },
  smartMoneyDexTrades: {
    trades: [
      { tx_hash: '0x123', token_symbol: 'TEST', amount_usd: 1000, side: 'buy' }
    ]
  },
  smartMoneyHoldings: {
    holdings: [
      { token_address: 'abc', token_symbol: 'TEST', balance_usd: 50000 }
    ]
  },
  smartMoneyPerpTrades: {
    trades: [
      { token: 'BTC', side: 'long', size_usd: 10000 }
    ]
  },
  smartMoneyDcas: {
    dcas: [
      { token_symbol: 'SOL', total_amount: 1000 }
    ]
  },
  addressBalance: {
    balances: [
      { token_symbol: 'ETH', balance: 100, balance_usd: 300000 }
    ]
  },
  addressLabels: {
    labels: ['Smart Trader', 'Fund']
  },
  addressTransactions: {
    transactions: [
      { tx_hash: '0x123', value_usd: 1000 }
    ]
  },
  addressPnl: {
    total_pnl: 50000,
    realized_pnl: 30000,
    unrealized_pnl: 20000
  },
  entitySearch: {
    results: [
      { name: 'Vitalik Buterin', addresses: ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'] }
    ]
  },
  tokenScreener: {
    tokens: [
      { token_address: 'abc', symbol: 'TEST', price_usd: 1.5 }
    ]
  },
  tokenHolders: {
    holders: [
      { address: '0x123', balance: 1000000, percentage: 5.5 }
    ]
  },
  tokenFlows: {
    inflows: 1000000,
    outflows: 500000
  },
  tokenDexTrades: {
    trades: [
      { tx_hash: '0x123', side: 'buy', amount_usd: 5000 }
    ]
  },
  tokenPnlLeaderboard: {
    leaders: [
      { address: '0x123', pnl_usd: 100000 }
    ]
  },
  tokenWhoBoughtSold: {
    buyers: [{ address: '0x123', amount_usd: 1000 }],
    sellers: [{ address: '0x456', amount_usd: 500 }]
  },
  portfolioDefiHoldings: {
    holdings: [
      { protocol: 'Aave', value_usd: 50000 }
    ]
  },
  // New Smart Money endpoints
  smartMoneyHistoricalHoldings: {
    holdings: [
      { token_symbol: 'SOL', date: '2024-01-01', balance_usd: 100000 }
    ]
  },
  // New Profiler endpoints
  addressHistoricalBalances: {
    balances: [
      { date: '2024-01-01', balance_usd: 50000 }
    ]
  },
  addressRelatedWallets: {
    wallets: [
      { address: '0x456', relationship: 'funding_source' }
    ]
  },
  addressCounterparties: {
    counterparties: [
      { address: '0x789', volume_usd: 100000 }
    ]
  },
  addressPnlSummary: {
    total_pnl: 25000,
    win_rate: 0.65
  },
  addressPerpPositions: {
    positions: [
      { token: 'BTC', side: 'long', size_usd: 50000 }
    ]
  },
  addressPerpTrades: {
    trades: [
      { token: 'ETH', side: 'short', pnl_usd: 5000 }
    ]
  },
  tokenIndicators: {
    token_address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
    chain: 'ethereum',
    token_info: { market_cap_usd: 1500000000, market_cap_group: 'largecap', is_stablecoin: false },
    risk_indicators: [
      { indicator_type: 'liquidity-risk', score: 'low', signal: 0.2, signal_percentile: 30.5, last_trigger_on: '2025-01-15' }
    ],
    reward_indicators: [
      { indicator_type: 'price-momentum', score: 'bullish', signal: 0.75, signal_percentile: 85.5, last_trigger_on: '2025-01-10' }
    ]
  },
  tokenOhlcv: {
    candles: [
      { timestamp: '2025-01-15T00:00:00Z', open: 1.5, high: 1.8, low: 1.4, close: 1.7, volume: 1000000 }
    ]
  },
  // New Token God Mode endpoints
  tokenFlowIntelligence: {
    flows: [
      { label: 'Smart Money', net_flow_usd: 500000 }
    ]
  },
  tokenTransfers: {
    transfers: [
      { from: '0x123', to: '0x456', amount_usd: 10000 }
    ]
  },
  tokenJupDca: {
    dcas: [
      { address: '0x123', total_amount: 5000 }
    ]
  },
  tokenPerpTrades: {
    trades: [
      { address: '0x123', side: 'long', pnl_usd: 10000 }
    ]
  },
  tokenPerpPositions: {
    positions: [
      { address: '0x123', side: 'long', size_usd: 100000 }
    ]
  },
  tokenPerpPnlLeaderboard: {
    leaders: [
      { address: '0x123', pnl_usd: 500000 }
    ]
  },
  // Prediction Market endpoints
  pmOhlcv: {
    data: [
      { market_id: '654412', side: 'Yes', period_start: '2024-11-01T00:00:00', open: 0.50, high: 0.55, low: 0.48, close: 0.53, volume_usd: 12500, trade_count: 150 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmOrderbook: {
    data: [
      { market_id: '654412', outcome: 'Yes', side: 'buy', price: 0.52, size: 1000 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmTopHolders: {
    data: [
      { market_id: '654412', address: '0x1234567890abcdef1234567890abcdef12345678', side: 'Yes', position_size: 15000, unrealized_pnl_usd: 1050 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmTradesByMarket: {
    data: [
      { market_id: '654412', buyer: '0x123', seller: '0x456', side: 'Yes', size: 1000, price: 0.52, usdc_value: 520 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmTradesByAddress: {
    data: [
      { market_id: '654412', market_question: 'Will X happen?', buyer: '0x123', side: 'Yes', size: 500, price: 0.60, usdc_value: 300 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmMarketScreener: {
    data: [
      { market_id: '654412', question: 'Will X happen?', volume_24hr: 50000, liquidity: 100000, open_interest: 200000 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmEventScreener: {
    data: [
      { event_id: 'evt_1', event_title: 'US Election', market_count: 5, total_volume: 1000000, total_volume_24hr: 50000 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmPnlByMarket: {
    data: [
      { market_id: '654412', address: '0x123', total_pnl_usd: 5000, side_held: 'Yes' }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmPnlByAddress: {
    data: [
      { address: '0x123', market_id: '654412', question: 'Will X happen?', side_held: 'Yes', total_pnl_usd: 5000 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmPositionDetail: {
    data: [
      { market_id: '654412', address: '0x123', outcome: 'Yes', balance: 1000, avg_entry_price: 0.45, current_price: 0.52 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  pmCategories: {
    data: [
      { category: 'Politics', active_markets: 50, total_volume: 5000000, total_volume_24hr: 100000 }
    ],
    pagination: { page: 1, per_page: 100 }
  },
  // Smart Alert endpoints
  alertsList: [
    { id: 'alert-1', name: 'ETH SM Flows', type: 'sm-token-flows', isEnabled: true }
  ],
  alertsCreate: { id: 'alert-2', name: 'New Alert', type: 'sm-token-flows', isEnabled: true },
  alertsUpdate: { id: 'alert-1', name: 'Updated Alert', isEnabled: true },
  alertsToggle: { id: 'alert-1', isEnabled: false },
  alertsDelete: { success: true }
};

describe('NansenAPI', () => {
  let api;
  let mockFetch;
  const originalFetch = global.fetch;

  beforeAll(() => {
    if (LIVE_TEST) {
      api = new NansenAPI(API_KEY);
    } else {
      // Mock fetch for unit tests
      mockFetch = vi.fn();
      global.fetch = mockFetch;
      api = new NansenAPI('test-api-key', 'https://api.nansen.ai');
    }
  });

  afterEach(() => {
    // Reset mocks fully (clears call history AND queued mockResolvedValueOnce values)
    if (mockFetch) {
      mockFetch.mockReset();
    }
    // Always restore real timers (safety net if test fails mid-execution)
    vi.useRealTimers();
  });

  afterAll(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  function setupMock(response) {
    if (!LIVE_TEST) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => response
      });
    }
  }

  /**
   * Helper to verify fetch was called with correct URL and body
   * @param {string} expectedEndpoint - Expected API endpoint path
   * @param {object} expectedBodyContains - Object with keys/values that must be in the body
   */
  function expectFetchCalledWith(expectedEndpoint, expectedBodyContains = {}, expectedMethod = 'POST') {
    if (LIVE_TEST) return;

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];

    // Verify URL
    expect(url).toBe(`https://api.nansen.ai${expectedEndpoint}`);

    // Verify method and headers
    expect(options.method).toBe(expectedMethod);
    if (expectedMethod !== 'GET') {
      expect(options.headers['Content-Type']).toBe('application/json');
    }
    expect(options.headers['X-Client-Type']).toBe('nansen-cli');
    expect(options.headers['X-Client-Version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(options.headers['apikey']).toBe('test-api-key');

    // Verify body contains expected fields (skip for GET/DELETE)
    if (expectedMethod === 'GET' || expectedMethod === 'DELETE') {
      expect(options.body).toBeUndefined();
      return;
    }
    const body = JSON.parse(options.body);
    for (const [key, value] of Object.entries(expectedBodyContains)) {
      expect(body[key]).toEqual(value);
    }

    return body;
  }

  // =================== Constructor Tests ===================

  describe('Constructor', () => {
    it('should require API key (unless config.json exists)', () => {
      // NansenAPI falls back to config.json, so this tests the explicit undefined case
      // When config.json exists with apiKey, it will use that
      const api = new NansenAPI('explicit-key', 'https://api.nansen.ai');
      expect(api.apiKey).toBe('explicit-key');
    });

    it('should accept custom base URL', () => {
      const customApi = new NansenAPI('test-key', 'https://custom.api.com');
      expect(customApi.baseUrl).toBe('https://custom.api.com');
    });
  });

  // =================== Account Endpoint ===================

  describe('Account', () => {
    describe('getAccount', () => {
      it('should call GET /api/v1/account with no body', async () => {
        setupMock(MOCK_RESPONSES.account);

        const result = await api.getAccount();

        // Verify correct API call
        if (!LIVE_TEST) {
          expect(mockFetch).toHaveBeenCalled();
          const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];

          expect(url).toBe('https://api.nansen.ai/api/v1/account');
          expect(options.method).toBe('GET');
          expect(options.headers['Content-Type']).toBeUndefined();
          expect(options.headers['apikey']).toBe('test-api-key');
          expect(options.body).toBeUndefined();
        }

        // Verify response structure
        expect(result).toHaveProperty('plan');
        expect(result).toHaveProperty('credits_remaining');
      });
    });
  });

  // =================== Smart Money Endpoints ===================

  describe('Smart Money', () => {
    describe('smartMoneyNetflow', () => {
      it('should fetch netflow data with correct endpoint and body', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        const result = await api.smartMoneyNetflow({ chains: ['solana'] });
        
        // Verify correct API call
        expectFetchCalledWith('/api/v1/smart-money/netflow', {
          chains: ['solana']
        });
        
        // Verify response structure
        expect(result.netflows).toBeInstanceOf(Array);
        expect(result.netflows[0]).toHaveProperty('token_symbol', 'TEST');
        expect(result.netflows[0]).toHaveProperty('inflow_usd', 1000);
        expect(result.netflows[0]).toHaveProperty('outflow_usd', 500);
      });

      it('should pass filters to API', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        await api.smartMoneyNetflow({
          chains: ['ethereum'],
          filters: { min_inflow_usd: 10000 }
        });
        
        const body = expectFetchCalledWith('/api/v1/smart-money/netflow');
        expect(body.chains).toEqual(['ethereum']);
        expect(body.filters).toEqual({ min_inflow_usd: 10000 });
      });

      it('should pass pagination to API', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        await api.smartMoneyNetflow({
          chains: ['solana'],
          pagination: { page: 2, recordsPerPage: 25 }
        });
        
        const body = expectFetchCalledWith('/api/v1/smart-money/netflow');
        expect(body.pagination).toEqual({ page: 2, recordsPerPage: 25 });
      });

      it('should pass orderBy to API', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        await api.smartMoneyNetflow({
          chains: ['solana'],
          orderBy: [{ field: 'inflow_usd', direction: 'DESC' }]
        });
        
        const body = expectFetchCalledWith('/api/v1/smart-money/netflow');
        expect(body.order_by).toEqual([{ field: 'inflow_usd', direction: 'DESC' }]);
      });
    });

    describe('smartMoneyDexTrades', () => {
      it('should fetch DEX trades with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDexTrades);
        
        const result = await api.smartMoneyDexTrades({ chains: ['solana'] });
        
        expectFetchCalledWith('/api/v1/smart-money/dex-trades', {
          chains: ['solana']
        });
        
        expect(result.trades).toBeInstanceOf(Array);
        expect(result.trades[0]).toHaveProperty('tx_hash', '0x123');
        expect(result.trades[0]).toHaveProperty('side', 'buy');
      });

      it('should support multiple chains', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDexTrades);
        
        await api.smartMoneyDexTrades({ chains: ['ethereum', 'base'] });
        
        const body = expectFetchCalledWith('/api/v1/smart-money/dex-trades');
        expect(body.chains).toEqual(['ethereum', 'base']);
      });
    });

    describe('smartMoneyPerpTrades', () => {
      it('should fetch perp trades with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyPerpTrades);

        const result = await api.smartMoneyPerpTrades({});

        expectFetchCalledWith('/api/v1/smart-money/perp-trades');

        expect(result.trades).toBeInstanceOf(Array);
        expect(result.trades[0]).toHaveProperty('token', 'BTC');
        expect(result.trades[0]).toHaveProperty('side', 'long');
        expect(result.trades[0]).toHaveProperty('size_usd', 10000);
      });

      it('should pass only_new_positions parameter when true', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyPerpTrades);

        await api.smartMoneyPerpTrades({ onlyNewPositions: true });

        const body = expectFetchCalledWith('/api/v1/smart-money/perp-trades');
        expect(body.only_new_positions).toBe(true);
      });

      it('should pass only_new_positions parameter when false', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyPerpTrades);

        await api.smartMoneyPerpTrades({ onlyNewPositions: false });

        const body = expectFetchCalledWith('/api/v1/smart-money/perp-trades');
        expect(body.only_new_positions).toBe(false);
      });

      it('should omit only_new_positions when undefined', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyPerpTrades);

        await api.smartMoneyPerpTrades({ onlyNewPositions: undefined });

        const body = expectFetchCalledWith('/api/v1/smart-money/perp-trades');
        expect(body.only_new_positions).toBeUndefined();
      });

      it('should support filters with include_smart_money_labels', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyPerpTrades);

        await api.smartMoneyPerpTrades({
          filters: { include_smart_money_labels: ['Fund', 'Whale'] }
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/perp-trades');
        expect(body.filters.include_smart_money_labels).toEqual(['Fund', 'Whale']);
      });
    });

    describe('smartMoneyHoldings', () => {
      it('should fetch holdings with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHoldings);

        const result = await api.smartMoneyHoldings({ chains: ['solana'] });

        expectFetchCalledWith('/api/v1/smart-money/holdings', {
          chains: ['solana']
        });

        expect(result.holdings).toBeInstanceOf(Array);
        expect(result.holdings[0]).toHaveProperty('token_symbol', 'TEST');
        expect(result.holdings[0]).toHaveProperty('balance_usd', 50000);
      });

      it('should pass filters parameter', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHoldings);

        await api.smartMoneyHoldings({
          chains: ['solana'],
          filters: { min_balance_usd: 10000 }
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/holdings');
        expect(body.filters.min_balance_usd).toBe(10000);
      });

      it('should pass orderBy parameter', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHoldings);

        await api.smartMoneyHoldings({
          chains: ['solana'],
          orderBy: [{ field: 'balance_usd', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/holdings');
        expect(body.order_by).toEqual([{ field: 'balance_usd', direction: 'DESC' }]);
      });
    });

    describe('smartMoneyDcas', () => {
      it('should fetch DCA orders with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDcas);

        const result = await api.smartMoneyDcas({});

        expectFetchCalledWith('/api/v1/smart-money/dcas');

        expect(result.dcas).toBeInstanceOf(Array);
        expect(result.dcas[0]).toHaveProperty('token_symbol', 'SOL');
        expect(result.dcas[0]).toHaveProperty('total_amount', 1000);
      });

      it('should pass filters parameter', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDcas);

        await api.smartMoneyDcas({
          filters: { min_total_amount: 500 }
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/dcas');
        expect(body.filters.min_total_amount).toBe(500);
      });

      it('should pass orderBy parameter', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDcas);

        await api.smartMoneyDcas({
          orderBy: [{ field: 'total_amount', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/dcas');
        expect(body.order_by).toEqual([{ field: 'total_amount', direction: 'DESC' }]);
      });
    });

    describe('smartMoneyHistoricalHoldings', () => {
      it('should fetch historical holdings with date_range', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHistoricalHoldings);
        
        const result = await api.smartMoneyHistoricalHoldings({ chains: ['solana'] });
        
        const body = expectFetchCalledWith('/api/v1/smart-money/historical-holdings', {
          chains: ['solana']
        });
        
        // Verify date_range is generated (default 30 days)
        expect(body.date_range).toBeDefined();
        expect(body.date_range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(body.date_range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        
        expect(result.holdings).toBeInstanceOf(Array);
        expect(result.holdings[0]).toHaveProperty('date', '2024-01-01');
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHistoricalHoldings);

        await api.smartMoneyHistoricalHoldings({ chains: ['solana'], days: 7 });

        const body = expectFetchCalledWith('/api/v1/smart-money/historical-holdings');

        // Verify 7-day range
        const from = new Date(body.date_range.from);
        const to = new Date(body.date_range.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(7);
      });

      it('should pass filters parameter', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHistoricalHoldings);

        await api.smartMoneyHistoricalHoldings({
          chains: ['solana'],
          filters: { min_balance_usd: 50000 }
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/historical-holdings');
        expect(body.filters.min_balance_usd).toBe(50000);
      });

      it('should pass orderBy parameter', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHistoricalHoldings);

        await api.smartMoneyHistoricalHoldings({
          chains: ['solana'],
          orderBy: [{ field: 'balance_usd', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/smart-money/historical-holdings');
        expect(body.order_by).toEqual([{ field: 'balance_usd', direction: 'DESC' }]);
      });
    });
  });

  // =================== Profiler Endpoints ===================

  describe('Profiler', () => {
    describe('addressBalance', () => {
      it('should fetch current balance with correct endpoint and body', async () => {
        setupMock(MOCK_RESPONSES.addressBalance);
        
        const result = await api.addressBalance({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/current-balance');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.chain).toBe('ethereum');
        expect(body.hide_spam_token).toBe(true); // default
        
        expect(result.balances).toBeInstanceOf(Array);
        expect(result.balances[0]).toHaveProperty('token_symbol', 'ETH');
        expect(result.balances[0]).toHaveProperty('balance_usd', 300000);
      });

      it('should support entity name lookup', async () => {
        setupMock(MOCK_RESPONSES.addressBalance);
        
        await api.addressBalance({
          entityName: 'Binance',
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/current-balance');
        expect(body.entity_name).toBe('Binance');
      });

      it('should pass hideSpamToken option', async () => {
        setupMock(MOCK_RESPONSES.addressBalance);
        
        await api.addressBalance({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          hideSpamToken: false
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/current-balance');
        expect(body.hide_spam_token).toBe(false);
      });
    });

    describe('addressLabels', () => {
      it('should fetch address labels with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressLabels);
        
        const result = await api.addressLabels({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/beta/profiler/address/labels');
        expect(body.parameters.address).toBe(TEST_DATA.ethereum.address);
        expect(body.parameters.chain).toBe('ethereum');
        
        expect(result.labels).toContain('Smart Trader');
        expect(result.labels).toContain('Fund');
      });
    });

    describe('addressTransactions', () => {
      it('should fetch transactions with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressTransactions);
        
        const result = await api.addressTransactions({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/transactions');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.chain).toBe('ethereum');
        
        expect(result.transactions).toBeInstanceOf(Array);
        expect(result.transactions[0]).toHaveProperty('tx_hash', '0x123');
        expect(result.transactions[0]).toHaveProperty('value_usd', 1000);
      });

      it('should pass orderBy to API', async () => {
        setupMock(MOCK_RESPONSES.addressTransactions);

        await api.addressTransactions({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          orderBy: [{ column: 'timestamp', order: 'desc' }]
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/transactions');
        expect(body.order_by).toEqual([{ column: 'timestamp', order: 'desc' }]);
      });

      it('should include date range with default days', async () => {
        setupMock(MOCK_RESPONSES.addressTransactions);

        await api.addressTransactions({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/transactions');
        expect(body.date).toBeDefined();
        expect(body.date.from).toBeDefined();
        expect(body.date.to).toBeDefined();
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.addressTransactions);

        await api.addressTransactions({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          days: 14
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/transactions');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });
    });

    describe('addressPnl', () => {
      it('should fetch PnL data with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressPnl);
        
        const result = await api.addressPnl({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/pnl');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.chain).toBe('ethereum');
        expect(body.date).toBeDefined();
        expect(body.date.from).toBeDefined();
        expect(body.date.to).toBeDefined();
        
        expect(result.total_pnl).toBe(50000);
        expect(result.realized_pnl).toBe(30000);
        expect(result.unrealized_pnl).toBe(20000);
      });

      it('should pass filters and orderBy parameters', async () => {
        setupMock(MOCK_RESPONSES.addressPnl);

        await api.addressPnl({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          filters: { min_pnl_usd: 1000 },
          orderBy: [{ field: 'pnl_usd_realised', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/pnl');
        expect(body.filters.min_pnl_usd).toBe(1000);
        expect(body.order_by).toEqual([{ field: 'pnl_usd_realised', direction: 'DESC' }]);
      });
    });

    describe('entitySearch', () => {
      it('should search for entities with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.entitySearch);

        const result = await api.entitySearch({ query: 'Vitalik' });

        const body = expectFetchCalledWith('/api/v1/search/entity-name');
        expect(body.search_query).toBe('Vitalik');

        expect(result.results).toBeInstanceOf(Array);
        expect(result.results[0]).toHaveProperty('name', 'Vitalik Buterin');
        expect(result.results[0].addresses).toContain('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
      });
    });

    describe('addressHistoricalBalances', () => {
      it('should fetch historical balances with date range', async () => {
        setupMock(MOCK_RESPONSES.addressHistoricalBalances);
        
        const result = await api.addressHistoricalBalances({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/historical-balances');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.date).toBeDefined();
        expect(body.date.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(body.date.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        
        expect(result.balances).toBeInstanceOf(Array);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.addressHistoricalBalances);
        
        await api.addressHistoricalBalances({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          days: 14
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/historical-balances');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });
    });

    describe('addressRelatedWallets', () => {
      it('should fetch related wallets with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressRelatedWallets);

        const result = await api.addressRelatedWallets({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/related-wallets');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.chain).toBe('ethereum');

        expect(result.wallets).toBeInstanceOf(Array);
        expect(result.wallets[0]).toHaveProperty('relationship', 'funding_source');
      });

      it('should not send empty filters in body', async () => {
        setupMock(MOCK_RESPONSES.addressRelatedWallets);

        await api.addressRelatedWallets({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/related-wallets');
        expect(body.filters).toBeUndefined();
      });
    });

    describe('addressCounterparties', () => {
      it('should fetch counterparties with date range', async () => {
        setupMock(MOCK_RESPONSES.addressCounterparties);
        
        const result = await api.addressCounterparties({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/counterparties');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.date).toBeDefined();
        
        expect(result.counterparties).toBeInstanceOf(Array);
        expect(result.counterparties[0]).toHaveProperty('volume_usd', 100000);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.addressCounterparties);
        
        await api.addressCounterparties({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          days: 14
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/counterparties');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });

      it('should send per_page (not recordsPerPage) when limit is specified', async () => {
        setupMock(MOCK_RESPONSES.addressCounterparties);

        await api.addressCounterparties({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          pagination: { page: 1, per_page: 5 }
        });

        const body = expectFetchCalledWith('/api/v1/profiler/address/counterparties');
        // Assert correct pagination field name used by the API
        expect(body.pagination).toBeDefined();
        expect(body.pagination.per_page).toBe(5);
        expect(body.pagination.page).toBe(1);
        // Assert the legacy field name is NOT used
        expect(body.pagination.recordsPerPage).toBeUndefined();
      });
    });

    describe('addressPnlSummary', () => {
      it('should fetch PnL summary with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressPnlSummary);
        
        const result = await api.addressPnlSummary({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/pnl-summary');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.date).toBeDefined();
        
        expect(result.total_pnl).toBe(25000);
        expect(result.win_rate).toBe(0.65);
      });
    });

    describe('addressPerpPositions', () => {
      it('should fetch perp positions with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressPerpPositions);
        
        const result = await api.addressPerpPositions({
          address: TEST_DATA.ethereum.address
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/perp-positions');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        
        expect(result.positions).toBeInstanceOf(Array);
        expect(result.positions[0]).toHaveProperty('token', 'BTC');
        expect(result.positions[0]).toHaveProperty('side', 'long');
        expect(result.positions[0]).toHaveProperty('size_usd', 50000);
      });
    });

    describe('addressPerpTrades', () => {
      it('should fetch perp trades with date range', async () => {
        setupMock(MOCK_RESPONSES.addressPerpTrades);
        
        const result = await api.addressPerpTrades({
          address: TEST_DATA.ethereum.address
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/perp-trades');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.date).toBeDefined();
        
        expect(result.trades).toBeInstanceOf(Array);
        expect(result.trades[0]).toHaveProperty('token', 'ETH');
        expect(result.trades[0]).toHaveProperty('pnl_usd', 5000);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.addressPerpTrades);
        
        await api.addressPerpTrades({
          address: TEST_DATA.ethereum.address,
          days: 7
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/perp-trades');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(7);
      });
    });
  });

  // =================== Token God Mode Endpoints ===================

  describe('Token God Mode', () => {
    describe('tokenIndicators', () => {
      it('should fetch indicators with correct endpoint and body', async () => {
        setupMock(MOCK_RESPONSES.tokenIndicators);

        const result = await api.tokenIndicators({
          tokenAddress: TEST_DATA.ethereum.token,
          chain: 'ethereum'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/indicators');
        if (body) {
          expect(body.token_address).toBe(TEST_DATA.ethereum.token);
          expect(body.chain).toBe('ethereum');
        }

        expect(result.risk_indicators).toBeInstanceOf(Array);
        expect(result.reward_indicators).toBeInstanceOf(Array);
      });
    });

    describe('tokenOhlcv', () => {
      it('should fetch OHLCV data with correct endpoint and body', async () => {
        setupMock(MOCK_RESPONSES.tokenOhlcv);

        const result = await api.tokenOhlcv({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          timeframe: '1h'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/token-ohlcv');
        if (body) {
          expect(body.token_address).toBe(TEST_DATA.solana.token);
          expect(body.chain).toBe('solana');
          expect(body.timeframe).toBe('1h');
        }

        expect(result.candles).toBeInstanceOf(Array);
      });
    });

    describe('tokenScreener', () => {
      it('should screen tokens with correct endpoint and body', async () => {
        setupMock(MOCK_RESPONSES.tokenScreener);

        const result = await api.tokenScreener({
          chains: ['solana'],
          timeframe: '24h'
        });

        const body = expectFetchCalledWith('/api/v1/token-screener');
        expect(body.chains).toEqual(['solana']);
        expect(body.timeframe).toBe('24h');
        
        expect(result.tokens).toBeInstanceOf(Array);
        expect(result.tokens[0]).toHaveProperty('symbol', 'TEST');
        expect(result.tokens[0]).toHaveProperty('price_usd', 1.5);
      });

      it('should pass different timeframes correctly', async () => {
        for (const timeframe of ['5m', '1h', '6h', '24h', '7d', '30d']) {
          setupMock(MOCK_RESPONSES.tokenScreener);
          
          await api.tokenScreener({ chains: ['solana'], timeframe });
          
          const body = expectFetchCalledWith('/api/v1/token-screener');
          expect(body.timeframe).toBe(timeframe);
        }
      });
    });

    describe('tokenHolders', () => {
      it('should fetch token holders with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.tokenHolders);
        
        const result = await api.tokenHolders({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/holders');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.chain).toBe('solana');
        expect(body.label_type).toBe('all_holders'); // default
        
        expect(result.holders).toBeInstanceOf(Array);
        expect(result.holders[0]).toHaveProperty('balance', 1000000);
        expect(result.holders[0]).toHaveProperty('percentage', 5.5);
      });

      it('should pass label type filter', async () => {
        setupMock(MOCK_RESPONSES.tokenHolders);

        await api.tokenHolders({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          labelType: 'smart_money'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/holders');
        expect(body.label_type).toBe('smart_money');
      });

      it('should pass filters parameter', async () => {
        setupMock(MOCK_RESPONSES.tokenHolders);

        await api.tokenHolders({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          filters: { min_balance_usd: 10000 }
        });

        const body = expectFetchCalledWith('/api/v1/tgm/holders');
        expect(body.filters.min_balance_usd).toBe(10000);
      });

      it('should pass orderBy parameter', async () => {
        setupMock(MOCK_RESPONSES.tokenHolders);

        await api.tokenHolders({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          orderBy: [{ field: 'value_usd', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/tgm/holders');
        expect(body.order_by).toEqual([{ field: 'value_usd', direction: 'DESC' }]);
      });
    });

    describe('tokenFlows', () => {
      it('should fetch token flows with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.tokenFlows);

        const result = await api.tokenFlows({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/flows');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.chain).toBe('solana');
        expect(body.date).toBeDefined();

        expect(result.inflows).toBe(1000000);
        expect(result.outflows).toBe(500000);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.tokenFlows);

        await api.tokenFlows({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          days: 14
        });

        const body = expectFetchCalledWith('/api/v1/tgm/flows');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });

      it('should pass filters and orderBy parameters', async () => {
        setupMock(MOCK_RESPONSES.tokenFlows);

        await api.tokenFlows({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          filters: { min_value_usd: 1000 },
          orderBy: [{ field: 'value_usd', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/tgm/flows');
        expect(body.filters.min_value_usd).toBe(1000);
        expect(body.order_by).toEqual([{ field: 'value_usd', direction: 'DESC' }]);
      });

      it('should pass label parameter', async () => {
        setupMock(MOCK_RESPONSES.tokenFlows);
        await api.tokenFlows({ tokenAddress: TEST_DATA.solana.token, chain: 'solana', label: 'exchange' });
        const body = expectFetchCalledWith('/api/v1/tgm/flows');
        expect(body.label).toBe('exchange');
      });

      it('should omit label when not provided', async () => {
        setupMock(MOCK_RESPONSES.tokenFlows);
        await api.tokenFlows({ tokenAddress: TEST_DATA.solana.token, chain: 'solana' });
        const body = expectFetchCalledWith('/api/v1/tgm/flows');
        expect(body.label).toBeUndefined();
      });
    });

    describe('tokenDexTrades', () => {
      it('should fetch DEX trades with date range', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);
        
        const result = await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/dex-trades');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.chain).toBe('solana');
        expect(body.date).toBeDefined();
        
        expect(result.trades).toBeInstanceOf(Array);
        expect(result.trades[0]).toHaveProperty('side', 'buy');
        expect(result.trades[0]).toHaveProperty('amount_usd', 5000);
      });

      it('should add smart money filter when onlySmartMoney=true', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);
        
        await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          onlySmartMoney: true
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/dex-trades');
        expect(body.filters.include_smart_money_labels).toContain('Fund');
        expect(body.filters.include_smart_money_labels).toContain('Smart Trader');
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);

        await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          days: 14
        });

        const body = expectFetchCalledWith('/api/v1/tgm/dex-trades');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });

      it('should pass filters and orderBy parameters', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);

        await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          filters: { min_value_usd: 5000 },
          orderBy: [{ field: 'value_usd', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/tgm/dex-trades');
        expect(body.filters.min_value_usd).toBe(5000);
        expect(body.order_by).toEqual([{ field: 'value_usd', direction: 'DESC' }]);
      });
    });

    describe('tokenPnlLeaderboard', () => {
      it('should fetch PnL leaderboard with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.tokenPnlLeaderboard);

        const result = await api.tokenPnlLeaderboard({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/pnl-leaderboard');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.date).toBeDefined();

        expect(result.leaders).toBeInstanceOf(Array);
        expect(result.leaders[0]).toHaveProperty('pnl_usd', 100000);
      });

      it('should pass filters and orderBy parameters', async () => {
        setupMock(MOCK_RESPONSES.tokenPnlLeaderboard);

        await api.tokenPnlLeaderboard({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          filters: { min_total_pnl_usd: 10000 },
          orderBy: [{ field: 'total_pnl_usd', direction: 'DESC' }]
        });

        const body = expectFetchCalledWith('/api/v1/tgm/pnl-leaderboard');
        expect(body.filters.min_total_pnl_usd).toBe(10000);
        expect(body.order_by).toEqual([{ field: 'total_pnl_usd', direction: 'DESC' }]);
      });
    });

    describe('tokenWhoBoughtSold', () => {
      it('should fetch buyers and sellers with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.tokenWhoBoughtSold);

        const result = await api.tokenWhoBoughtSold({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/who-bought-sold');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.chain).toBe('solana');
        expect(body.date).toBeDefined();

        expect(result.buyers).toBeInstanceOf(Array);
        expect(result.sellers).toBeInstanceOf(Array);
        expect(result.buyers[0]).toHaveProperty('amount_usd', 1000);
        expect(result.sellers[0]).toHaveProperty('amount_usd', 500);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.tokenWhoBoughtSold);

        await api.tokenWhoBoughtSold({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          days: 14
        });

        const body = expectFetchCalledWith('/api/v1/tgm/who-bought-sold');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });
    });

    describe('tokenFlowIntelligence', () => {
      it('should fetch flow intelligence with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.tokenFlowIntelligence);

        const result = await api.tokenFlowIntelligence({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/flow-intelligence');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.date).toBeUndefined();

        expect(result.flows).toBeInstanceOf(Array);
        expect(result.flows[0]).toHaveProperty('label', 'Smart Money');
        expect(result.flows[0]).toHaveProperty('net_flow_usd', 500000);
      });

      it('should not send date or filters fields', async () => {
        setupMock(MOCK_RESPONSES.tokenFlowIntelligence);

        await api.tokenFlowIntelligence({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });

        const body = expectFetchCalledWith('/api/v1/tgm/flow-intelligence');
        expect(body.date).toBeUndefined();
        expect(body.filters).toBeUndefined();
      });
    });

    describe('tokenTransfers', () => {
      it('should fetch token transfers with date range', async () => {
        setupMock(MOCK_RESPONSES.tokenTransfers);
        
        const result = await api.tokenTransfers({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/transfers');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        expect(body.date).toBeDefined();
        
        expect(result.transfers).toBeInstanceOf(Array);
        expect(result.transfers[0]).toHaveProperty('amount_usd', 10000);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.tokenTransfers);
        
        await api.tokenTransfers({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          days: 3
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/transfers');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(3);
      });
    });

    describe('tokenJupDca', () => {
      it('should fetch Jupiter DCA orders with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.tokenJupDca);
        
        const result = await api.tokenJupDca({
          tokenAddress: TEST_DATA.solana.token
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/jup-dca');
        expect(body.token_address).toBe(TEST_DATA.solana.token);
        
        expect(result.dcas).toBeInstanceOf(Array);
        expect(result.dcas[0]).toHaveProperty('total_amount', 5000);
      });
    });

    describe('tokenPerpTrades', () => {
      it('should fetch perp trades with token symbol', async () => {
        setupMock(MOCK_RESPONSES.tokenPerpTrades);
        
        const result = await api.tokenPerpTrades({
          tokenSymbol: 'BTC'
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/perp-trades');
        expect(body.token_symbol).toBe('BTC');
        expect(body.date).toBeDefined();
        
        expect(result.trades).toBeInstanceOf(Array);
        expect(result.trades[0]).toHaveProperty('pnl_usd', 10000);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.tokenPerpTrades);
        
        await api.tokenPerpTrades({
          tokenSymbol: 'ETH',
          days: 7
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/perp-trades');
        expect(body.token_symbol).toBe('ETH');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(7);
      });
    });

    describe('tokenPerpPositions', () => {
      it('should fetch perp positions with token symbol', async () => {
        setupMock(MOCK_RESPONSES.tokenPerpPositions);
        
        const result = await api.tokenPerpPositions({
          tokenSymbol: 'BTC'
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/perp-positions');
        expect(body.token_symbol).toBe('BTC');
        
        expect(result.positions).toBeInstanceOf(Array);
        expect(result.positions[0]).toHaveProperty('size_usd', 100000);
      });
    });

    describe('tokenPerpPnlLeaderboard', () => {
      it('should fetch perp PnL leaderboard with token symbol', async () => {
        setupMock(MOCK_RESPONSES.tokenPerpPnlLeaderboard);
        
        const result = await api.tokenPerpPnlLeaderboard({
          tokenSymbol: 'BTC'
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/perp-pnl-leaderboard');
        expect(body.token_symbol).toBe('BTC');
        expect(body.date).toBeDefined();
        
        expect(result.leaders).toBeInstanceOf(Array);
        expect(result.leaders[0]).toHaveProperty('pnl_usd', 500000);
      });

      it('should calculate correct date range for custom days', async () => {
        setupMock(MOCK_RESPONSES.tokenPerpPnlLeaderboard);
        
        await api.tokenPerpPnlLeaderboard({
          tokenSymbol: 'ETH',
          days: 14
        });
        
        const body = expectFetchCalledWith('/api/v1/tgm/perp-pnl-leaderboard');
        const from = new Date(body.date.from);
        const to = new Date(body.date.to);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(14);
      });
    });
  });

  // =================== Portfolio Endpoints ===================

  describe('Portfolio', () => {
    describe('portfolioDefiHoldings', () => {
      it('should fetch DeFi holdings with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.portfolioDefiHoldings);
        
        const result = await api.portfolioDefiHoldings({
          walletAddress: TEST_DATA.ethereum.address
        });
        
        const body = expectFetchCalledWith('/api/v1/portfolio/defi-holdings');
        expect(body.wallet_address).toBe(TEST_DATA.ethereum.address);
        
        expect(result.holdings).toBeInstanceOf(Array);
        expect(result.holdings[0]).toHaveProperty('protocol', 'Aave');
        expect(result.holdings[0]).toHaveProperty('value_usd', 50000);
      });
    });
  });

  // =================== Prediction Market Endpoints ===================

  describe('Prediction Market', () => {
    describe('pmOhlcv', () => {
      it('should fetch OHLCV data with correct endpoint and body', async () => {
        setupMock(MOCK_RESPONSES.pmOhlcv);
        const result = await api.pmOhlcv({ marketId: '654412' });
        expectFetchCalledWith('/api/v1/prediction-market/ohlcv', { market_id: '654412' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('market_id', '654412');
        expect(result.data[0]).toHaveProperty('volume_usd', 12500);
      });

      it('should pass sort parameter', async () => {
        setupMock(MOCK_RESPONSES.pmOhlcv);
        await api.pmOhlcv({ marketId: '654412', sort: [{ field: 'period_start', direction: 'DESC' }] });
        const body = expectFetchCalledWith('/api/v1/prediction-market/ohlcv');
        expect(body.sort).toEqual([{ field: 'period_start', direction: 'DESC' }]);
      });

      it('should require marketId', async () => {
        await expect(api.pmOhlcv({})).rejects.toThrow('market_id is required');
      });
    });

    describe('pmOrderbook', () => {
      it('should fetch orderbook with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmOrderbook);
        const result = await api.pmOrderbook({ marketId: '654412' });
        expectFetchCalledWith('/api/v1/prediction-market/orderbook', { market_id: '654412' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('side', 'buy');
      });

      it('should require marketId', async () => {
        await expect(api.pmOrderbook({})).rejects.toThrow('market_id is required');
      });
    });

    describe('pmTopHolders', () => {
      it('should fetch top holders with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmTopHolders);
        const result = await api.pmTopHolders({ marketId: '654412' });
        expectFetchCalledWith('/api/v1/prediction-market/top-holders', { market_id: '654412' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('position_size', 15000);
      });

      it('should require marketId', async () => {
        await expect(api.pmTopHolders({})).rejects.toThrow('market_id is required');
      });
    });

    describe('pmTradesByMarket', () => {
      it('should fetch trades by market with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmTradesByMarket);
        const result = await api.pmTradesByMarket({ marketId: '654412' });
        expectFetchCalledWith('/api/v1/prediction-market/trades-by-market', { market_id: '654412' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('usdc_value', 520);
      });

      it('should require marketId', async () => {
        await expect(api.pmTradesByMarket({})).rejects.toThrow('market_id is required');
      });
    });

    describe('pmTradesByAddress', () => {
      it('should fetch trades by address with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmTradesByAddress);
        const result = await api.pmTradesByAddress({ address: '0x1234567890abcdef1234567890abcdef12345678' });
        expectFetchCalledWith('/api/v1/prediction-market/trades-by-address', { address: '0x1234567890abcdef1234567890abcdef12345678' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('market_question', 'Will X happen?');
      });

      it('should validate address format', async () => {
        try {
          await api.pmTradesByAddress({ address: 'invalid' });
        } catch (e) {
          expect(e.code).toBe(ErrorCode.INVALID_ADDRESS);
        }
      });

      it('should require address', async () => {
        try {
          await api.pmTradesByAddress({});
        } catch (e) {
          expect(e.code).toBe(ErrorCode.MISSING_PARAM);
        }
      });
    });

    describe('pmMarketScreener', () => {
      it('should fetch market screener with correct endpoint and defaults', async () => {
        setupMock(MOCK_RESPONSES.pmMarketScreener);
        const result = await api.pmMarketScreener({});
        const body = expectFetchCalledWith('/api/v1/prediction-market/market-screener');
        expect(body.sort_by).toBe('volume_24hr');
        expect(body.query).toBe('');
        expect(body.status).toBe('');
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('question', 'Will X happen?');
      });

      it('should pass sort_by, query, and status', async () => {
        setupMock(MOCK_RESPONSES.pmMarketScreener);
        await api.pmMarketScreener({ sortBy: 'liquidity', query: 'election', status: 'active' });
        const body = expectFetchCalledWith('/api/v1/prediction-market/market-screener');
        expect(body.sort_by).toBe('liquidity');
        expect(body.query).toBe('election');
        expect(body.status).toBe('active');
      });
    });

    describe('pmEventScreener', () => {
      it('should fetch event screener with correct endpoint and defaults', async () => {
        setupMock(MOCK_RESPONSES.pmEventScreener);
        const result = await api.pmEventScreener({});
        const body = expectFetchCalledWith('/api/v1/prediction-market/event-screener');
        expect(body.sort_by).toBe('volume_24hr');
        expect(body.query).toBe('');
        expect(body.status).toBe('');
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('event_title', 'US Election');
      });

      it('should pass sort_by, query, and status', async () => {
        setupMock(MOCK_RESPONSES.pmEventScreener);
        await api.pmEventScreener({ sortBy: 'open_interest', query: 'crypto', status: 'active' });
        const body = expectFetchCalledWith('/api/v1/prediction-market/event-screener');
        expect(body.sort_by).toBe('open_interest');
        expect(body.query).toBe('crypto');
        expect(body.status).toBe('active');
      });
    });

    describe('pmTopHolders (sort)', () => {
      it('should pass sort parameter', async () => {
        setupMock(MOCK_RESPONSES.pmTopHolders);
        await api.pmTopHolders({ marketId: '654412', sort: [{ field: 'position_size', direction: 'DESC' }] });
        const body = expectFetchCalledWith('/api/v1/prediction-market/top-holders');
        expect(body.sort).toEqual([{ field: 'position_size', direction: 'DESC' }]);
      });

      it('should pass pagination', async () => {
        setupMock(MOCK_RESPONSES.pmTopHolders);
        await api.pmTopHolders({ marketId: '654412', pagination: { page: 2, per_page: 10 } });
        const body = expectFetchCalledWith('/api/v1/prediction-market/top-holders');
        expect(body.pagination).toEqual({ page: 2, per_page: 10 });
      });
    });

    describe('pmTradesByMarket (pagination)', () => {
      it('should pass pagination', async () => {
        setupMock(MOCK_RESPONSES.pmTradesByMarket);
        await api.pmTradesByMarket({ marketId: '654412', pagination: { page: 3, per_page: 50 } });
        const body = expectFetchCalledWith('/api/v1/prediction-market/trades-by-market');
        expect(body.pagination).toEqual({ page: 3, per_page: 50 });
      });
    });

    describe('pmPnlByMarket', () => {
      it('should fetch PnL by market with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmPnlByMarket);
        const result = await api.pmPnlByMarket({ marketId: '654412' });
        expectFetchCalledWith('/api/v1/prediction-market/pnl-by-market', { market_id: '654412' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('total_pnl_usd', 5000);
      });

      it('should require marketId', async () => {
        await expect(api.pmPnlByMarket({})).rejects.toThrow('market_id is required');
      });
    });

    describe('pmPnlByAddress', () => {
      it('should fetch PnL by address with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmPnlByAddress);
        const result = await api.pmPnlByAddress({ address: '0x1234567890abcdef1234567890abcdef12345678' });
        expectFetchCalledWith('/api/v1/prediction-market/pnl-by-address', { address: '0x1234567890abcdef1234567890abcdef12345678' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('total_pnl_usd', 5000);
      });

      it('should validate address format', async () => {
        try {
          await api.pmPnlByAddress({ address: 'invalid' });
        } catch (e) {
          expect(e.code).toBe(ErrorCode.INVALID_ADDRESS);
        }
      });

      it('should require address', async () => {
        try {
          await api.pmPnlByAddress({});
        } catch (e) {
          expect(e.code).toBe(ErrorCode.MISSING_PARAM);
        }
      });
    });

    describe('pmPositionDetail', () => {
      it('should fetch position detail with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmPositionDetail);
        const result = await api.pmPositionDetail({ marketId: '654412' });
        expectFetchCalledWith('/api/v1/prediction-market/position-detail', { market_id: '654412' });
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('outcome', 'Yes');
      });

      it('should require marketId', async () => {
        await expect(api.pmPositionDetail({})).rejects.toThrow('market_id is required');
      });
    });

    describe('pmCategories', () => {
      it('should fetch categories with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.pmCategories);
        const result = await api.pmCategories({});
        expectFetchCalledWith('/api/v1/prediction-market/categories');
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data[0]).toHaveProperty('category', 'Politics');
        expect(result.data[0]).toHaveProperty('active_markets', 50);
      });

      it('should pass pagination', async () => {
        setupMock(MOCK_RESPONSES.pmCategories);
        await api.pmCategories({ pagination: { page: 1, per_page: 10 } });
        const body = expectFetchCalledWith('/api/v1/prediction-market/categories');
        expect(body.pagination).toEqual({ page: 1, per_page: 10 });
      });
    });
  });

  // =================== Error Handling ===================

  describe('Error Handling', () => {
    it('should throw with original message for 401 when API key exists', async () => {
      if (LIVE_TEST) return;

      const errorResponse = {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: 'Unauthorized', message: 'Invalid API key' })
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      await expect(api.smartMoneyNetflow({})).rejects.toThrow('Invalid API key');
    });

    it('should show login guidance for 401 when no API key', async () => {
      if (LIVE_TEST) return;

      const apiNoKey = new NansenAPI(null, 'https://api.nansen.ai');
      const errorResponse = {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: 'Unauthorized', message: 'Invalid API key' })
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      await expect(apiNoKey.smartMoneyNetflow({})).rejects.toThrow('Not logged in. Run: nansen login');
    });

    it('should throw on network errors after retries', async () => {
      if (LIVE_TEST) return;
      
      // Use fake timers to avoid waiting for real backoff delays
      vi.useFakeTimers();
      
      // Mock multiple failures for retry attempts
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      // Start the request and handle rejection
      let thrownError;
      const promise = api.smartMoneyNetflow({}).catch(e => { thrownError = e; });
      
      // Advance through all retry delays
      await vi.runAllTimersAsync();
      await promise;
      
      expect(thrownError).toBeDefined();
      expect(thrownError.message).toContain('Network error');
      vi.useRealTimers();
    });

    it('should include status code in error object after retries', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      // Mock multiple 429 responses for retry attempts
      const rateLimitResponse = {
        ok: false,
        status: 429,
        headers: new Map(),
        json: async () => ({ error: 'Rate limited' })
      };
      rateLimitResponse.headers.get = () => null;
      
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(rateLimitResponse);

      let thrownError;
      const promise = api.smartMoneyNetflow({}).catch(e => { thrownError = e; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(thrownError).toBeDefined();
      expect(thrownError.status).toBe(429);
      expect(thrownError.message).toContain('Rate limited');
      vi.useRealTimers();
    });

    it('should handle 500 server errors after retries', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      // Mock multiple 500 responses for retry attempts
      const serverErrorResponse = {
        ok: false,
        status: 500,
        headers: new Map(),
        json: async () => ({ error: 'Internal server error' })
      };
      serverErrorResponse.headers.get = () => null;
      
      mockFetch
        .mockResolvedValueOnce(serverErrorResponse)
        .mockResolvedValueOnce(serverErrorResponse)
        .mockResolvedValueOnce(serverErrorResponse)
        .mockResolvedValueOnce(serverErrorResponse);

      let thrownError;
      const promise = api.smartMoneyNetflow({}).catch(e => { thrownError = e; });
      await vi.runAllTimersAsync();
      await promise;

      expect(thrownError).toBeDefined();
      vi.useRealTimers();
    });

    it('should handle timeout errors after retries', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      // Mock multiple timeout errors for retry attempts
      mockFetch
        .mockRejectedValueOnce(new Error('Request timeout'))
        .mockRejectedValueOnce(new Error('Request timeout'))
        .mockRejectedValueOnce(new Error('Request timeout'))
        .mockRejectedValueOnce(new Error('Request timeout'));

      let thrownError;
      const promise = api.tokenScreener({ chains: ['solana'] }).catch(e => { thrownError = e; });
      await vi.runAllTimersAsync();
      await promise;

      expect(thrownError).toBeDefined();
      expect(thrownError.message).toContain('timeout');
      vi.useRealTimers();
    });

    it('should include original error data in thrown error', async () => {
      if (LIVE_TEST) return;
      
      const errorData = { error: 'Bad request', details: { field: 'chains', message: 'required' } };
      const errorResponse = {
        ok: false,
        status: 400,
        headers: new Map(),
        json: async () => errorData
      };
      errorResponse.headers.get = () => null;
      
      // 400 errors are not retried, so single mock is fine
      mockFetch.mockResolvedValueOnce(errorResponse);

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        thrownError = error;
      }
      
      // Check that original error data is included (with retry metadata added)
      expect(thrownError.details.error).toEqual(errorData.error);
      expect(thrownError.details.details).toEqual(errorData.details);
    });

    it('should extract message from nested detail object (FastAPI proxy errors)', async () => {
      if (LIVE_TEST) return;

      const errorData = { detail: { message: 'Common Token Transfer Alert must specify subject or tokens', error: 'Bad Request', statusCode: 400 } };
      const errorResponse = {
        ok: false,
        status: 400,
        headers: new Map(),
        json: async () => errorData
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError.message).toBe('Common Token Transfer Alert must specify subject or tokens');
    });

    it('should extract string detail (FastAPI simple errors)', async () => {
      if (LIVE_TEST) return;

      const errorData = { detail: 'Not Found' };
      const errorResponse = {
        ok: false,
        status: 404,
        headers: new Map(),
        json: async () => errorData
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError.message).toBe('Not Found');
    });

    it('should extract inner message from Python-stringified error dicts', async () => {
      if (LIVE_TEST) return;

      const errorData = {
        error: 'Bad Request',
        message: "{'message': 'Common Token Transfer Alert must specify subject or tokens', 'error': 'Bad Request', 'statusCode': 400}"
      };
      const errorResponse = {
        ok: false,
        status: 400,
        headers: new Map(),
        json: async () => errorData
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError.message).toBe('Common Token Transfer Alert must specify subject or tokens');
    });

    it('should map "Field not recognized" to UNSUPPORTED_FILTER error code', async () => {
      if (LIVE_TEST) return;

      const errorResponse = {
        ok: false,
        status: 422,
        headers: new Map(),
        json: async () => ({ message: "Field 'only_smart_money' is not recognized. Please check the API documentation for valid request fields." })
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      let thrownError;
      try {
        await api.tokenHolders({ tokenAddress: TEST_DATA.solana.token, chain: 'solana' });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.code).toBe(ErrorCode.UNSUPPORTED_FILTER);
      expect(thrownError.status).toBe(422);
      expect(thrownError.message).toContain('not supported for this token/chain');
    });

    it('should map "Insufficient credits" to CREDITS_EXHAUSTED error code', async () => {
      if (LIVE_TEST) return;

      const errorResponse = {
        ok: false,
        status: 403,
        headers: new Map(),
        json: async () => ({ message: 'Insufficient credits' })
      };
      errorResponse.headers.get = () => null;

      mockFetch.mockResolvedValueOnce(errorResponse);

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.code).toBe(ErrorCode.CREDITS_EXHAUSTED);
      expect(thrownError.status).toBe(403);
      expect(thrownError.message).toContain('No retry will help');
    });

    it('should succeed after retry on transient failure', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      // First request fails with 429, second succeeds
      const rateLimitResponse = {
        ok: false,
        status: 429,
        headers: new Map(),
        json: async () => ({ error: 'Rate limited' })
      };
      rateLimitResponse.headers.get = () => null;
      
      const successResponse = {
        ok: true,
        json: async () => ({ data: [{ token: 'TEST' }] })
      };
      
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(successResponse);

      let result;
      const promise = api.smartMoneyNetflow({ chains: ['solana'] }).then(r => { result = r; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(result.data).toEqual([{ token: 'TEST' }]);
      expect(result._meta?.retriedAttempts).toBe(1);
      vi.useRealTimers();
    });
  });

  // =================== Edge Cases ===================

  describe('Edge Cases', () => {
    it('should handle empty response arrays', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ netflows: [] })
      });

      const result = await api.smartMoneyNetflow({ chains: ['solana'] });
      
      expect(result.netflows).toEqual([]);
      expect(result.netflows).toHaveLength(0);
    });

    it('should handle response with null fields', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          holdings: [{ token_symbol: null, balance_usd: null }]
        })
      });

      const result = await api.smartMoneyHoldings({ chains: ['solana'] });
      
      expect(result.holdings[0].token_symbol).toBeNull();
      expect(result.holdings[0].balance_usd).toBeNull();
    });

    it('should handle pagination boundary (page 0)', async () => {
      if (LIVE_TEST) return;
      
      setupMock(MOCK_RESPONSES.smartMoneyNetflow);
      
      await api.smartMoneyNetflow({
        chains: ['solana'],
        pagination: { page: 0, recordsPerPage: 10 }
      });
      
      const body = expectFetchCalledWith('/api/v1/smart-money/netflow');
      expect(body.pagination.page).toBe(0);
    });

    it('should handle large pagination values', async () => {
      if (LIVE_TEST) return;
      
      setupMock(MOCK_RESPONSES.smartMoneyNetflow);
      
      await api.smartMoneyNetflow({
        chains: ['solana'],
        pagination: { page: 9999, recordsPerPage: 1000 }
      });
      
      const body = expectFetchCalledWith('/api/v1/smart-money/netflow');
      expect(body.pagination.page).toBe(9999);
      expect(body.pagination.recordsPerPage).toBe(1000);
    });

    it('should handle empty chains array', async () => {
      if (LIVE_TEST) return;
      
      setupMock(MOCK_RESPONSES.smartMoneyNetflow);
      
      await api.smartMoneyNetflow({ chains: [] });
      
      const body = expectFetchCalledWith('/api/v1/smart-money/netflow');
      expect(body.chains).toEqual([]);
    });

    it('should handle special characters in entity search query', async () => {
      if (LIVE_TEST) return;

      setupMock(MOCK_RESPONSES.entitySearch);

      await api.entitySearch({ query: 'Test & Co. <script>' });

      const body = expectFetchCalledWith('/api/v1/search/entity-name');
      expect(body.search_query).toBe('Test & Co. <script>');
    });

    it('should handle days=0', async () => {
      if (LIVE_TEST) return;
      
      setupMock(MOCK_RESPONSES.smartMoneyHistoricalHoldings);
      
      await api.smartMoneyHistoricalHoldings({ chains: ['solana'], days: 0 });
      
      const body = expectFetchCalledWith('/api/v1/smart-money/historical-holdings');
      // With days=0, from and to should be the same date
      expect(body.date_range.from).toBe(body.date_range.to);
    });

    it('should handle very large days value', async () => {
      if (LIVE_TEST) return;
      
      setupMock(MOCK_RESPONSES.addressHistoricalBalances);
      
      await api.addressHistoricalBalances({
        address: TEST_DATA.ethereum.address,
        chain: 'ethereum',
        days: 365
      });
      
      const body = expectFetchCalledWith('/api/v1/profiler/address/historical-balances');
      const from = new Date(body.date.from);
      const to = new Date(body.date.to);
      const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(365);
    });

    it('should handle response with unexpected extra fields', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          netflows: MOCK_RESPONSES.smartMoneyNetflow.netflows,
          unexpected_field: 'should be preserved',
          metadata: { version: '2.0' }
        })
      });

      const result = await api.smartMoneyNetflow({ chains: ['solana'] });
      
      expect(result.netflows).toBeDefined();
      expect(result.unexpected_field).toBe('should be preserved');
      expect(result.metadata.version).toBe('2.0');
    });
  });

  // =================== P2: Non-JSON Error Responses ===================

  describe('Non-JSON Error Responses', () => {
    it('should handle HTML error page (502 Bad Gateway)', async () => {
      if (LIVE_TEST) return;
      
      const htmlResponse = {
        ok: false,
        status: 502,
        headers: new Map(),
        json: async () => { throw new Error('Unexpected token < in JSON'); },
        text: async () => '<html><body><h1>502 Bad Gateway</h1></body></html>'
      };
      htmlResponse.headers.get = () => null;
      
      vi.useFakeTimers();
      
      mockFetch
        .mockResolvedValueOnce(htmlResponse)
        .mockResolvedValueOnce(htmlResponse)
        .mockResolvedValueOnce(htmlResponse)
        .mockResolvedValueOnce(htmlResponse);

      let thrownError;
      const promise = api.smartMoneyNetflow({}).catch(e => { thrownError = e; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(thrownError).toBeDefined();
      expect(thrownError.status).toBe(502);
      vi.useRealTimers();
    });

    it('should handle plain text error response', async () => {
      if (LIVE_TEST) return;
      
      const textResponse = {
        ok: false,
        status: 500,
        headers: new Map(),
        json: async () => { throw new Error('Not JSON'); },
        text: async () => 'Internal Server Error'
      };
      textResponse.headers.get = () => null;
      
      vi.useFakeTimers();
      
      mockFetch
        .mockResolvedValueOnce(textResponse)
        .mockResolvedValueOnce(textResponse)
        .mockResolvedValueOnce(textResponse)
        .mockResolvedValueOnce(textResponse);

      let thrownError;
      const promise = api.smartMoneyNetflow({}).catch(e => { thrownError = e; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(thrownError).toBeDefined();
      expect(thrownError.status).toBe(500);
      vi.useRealTimers();
    });

    it('should handle empty response body', async () => {
      if (LIVE_TEST) return;
      
      const emptyResponse = {
        ok: false,
        status: 503,
        headers: new Map(),
        json: async () => { throw new Error('Unexpected end of JSON input'); },
        text: async () => ''
      };
      emptyResponse.headers.get = () => null;
      
      vi.useFakeTimers();
      
      mockFetch
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(emptyResponse);

      let thrownError;
      const promise = api.smartMoneyNetflow({}).catch(e => { thrownError = e; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(thrownError).toBeDefined();
      expect(thrownError.status).toBe(503);
      vi.useRealTimers();
    });
  });

  // =================== P2: HTTP Date Retry-After Header ===================

  describe('HTTP Date Retry-After Header', () => {
    it('should parse retry-after as seconds', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      const rateLimitResponse = {
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '5']]),
        json: async () => ({ error: 'Rate limited' })
      };
      rateLimitResponse.headers.get = (name) => {
        if (name.toLowerCase() === 'retry-after') return '5';
        return null;
      };
      
      const successResponse = {
        ok: true,
        json: async () => ({ data: [] })
      };
      
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(successResponse);

      let result;
      const promise = api.smartMoneyNetflow({ chains: ['solana'] }).then(r => { result = r; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(result).toBeDefined();
      vi.useRealTimers();
    });

    it('should parse retry-after as HTTP date', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      const now = new Date();
      const futureDate = new Date(now.getTime() + 5000); // 5 seconds from now
      const httpDate = futureDate.toUTCString(); // e.g., "Thu, 06 Feb 2025 05:10:00 GMT"
      
      const rateLimitResponse = {
        ok: false,
        status: 429,
        headers: new Map([['retry-after', httpDate]]),
        json: async () => ({ error: 'Rate limited' })
      };
      rateLimitResponse.headers.get = (name) => {
        if (name.toLowerCase() === 'retry-after') return httpDate;
        return null;
      };
      
      const successResponse = {
        ok: true,
        json: async () => ({ data: [] })
      };
      
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(successResponse);

      let result;
      const promise = api.smartMoneyNetflow({ chains: ['solana'] }).then(r => { result = r; });
      await vi.runAllTimersAsync();
      await promise;
      
      expect(result).toBeDefined();
      vi.useRealTimers();
    });

    it('should handle invalid retry-after header gracefully', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      const rateLimitResponse = {
        ok: false,
        status: 429,
        headers: new Map([['retry-after', 'invalid-value']]),
        json: async () => ({ error: 'Rate limited' })
      };
      rateLimitResponse.headers.get = (name) => {
        if (name.toLowerCase() === 'retry-after') return 'invalid-value';
        return null;
      };
      
      const successResponse = {
        ok: true,
        json: async () => ({ data: [] })
      };
      
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(successResponse);

      let result;
      const promise = api.smartMoneyNetflow({ chains: ['solana'] }).then(r => { result = r; });
      await vi.runAllTimersAsync();
      await promise;
      
      // Should succeed after retry (fallback to default delay)
      expect(result).toBeDefined();
      vi.useRealTimers();
    });

    it('should handle missing retry-after header', async () => {
      if (LIVE_TEST) return;
      
      vi.useFakeTimers();
      
      const rateLimitResponse = {
        ok: false,
        status: 429,
        headers: new Map(),
        json: async () => ({ error: 'Rate limited' })
      };
      rateLimitResponse.headers.get = () => null;
      
      const successResponse = {
        ok: true,
        json: async () => ({ data: [] })
      };
      
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(successResponse);

      let result;
      const promise = api.smartMoneyNetflow({ chains: ['solana'] }).then(r => { result = r; });
      await vi.runAllTimersAsync();
      await promise;
      
      // Should succeed using default backoff
      expect(result).toBeDefined();
      vi.useRealTimers();
    });
  });

  // =================== Address Validation in API Methods ===================

  describe('Address Validation in API Methods', () => {
    it('should reject invalid EVM address in addressBalance', async () => {
      await expect(api.addressBalance({
        address: 'invalid-address',
        chain: 'ethereum'
      })).rejects.toThrow('Invalid EVM address');
    });

    it('should reject invalid Solana address in tokenHolders', async () => {
      await expect(api.tokenHolders({
        tokenAddress: 'invalid',
        chain: 'solana'
      })).rejects.toThrow('Invalid Solana address');
    });

    it('should accept valid addresses and make API call', async () => {
      if (LIVE_TEST) return;
      
      setupMock(MOCK_RESPONSES.addressBalance);
      
      // Should not throw
      await api.addressBalance({
        address: TEST_DATA.ethereum.address,
        chain: 'ethereum'
      });
      
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  // =================== Body Cleaning ===================

  describe('Body Cleaning', () => {
    it('should strip empty filters from request body', async () => {
      setupMock(MOCK_RESPONSES.addressRelatedWallets);

      await api.addressRelatedWallets({
        address: TEST_DATA.ethereum.address,
        chain: 'ethereum'
      });

      const body = expectFetchCalledWith('/api/v1/profiler/address/related-wallets');
      expect(body.filters).toBeUndefined();
      expect(body.order_by).toBeUndefined();
      expect(body.pagination).toBeUndefined();
    });

    it('should not send filters for related-wallets', async () => {
      setupMock(MOCK_RESPONSES.addressRelatedWallets);

      await api.addressRelatedWallets({
        address: TEST_DATA.ethereum.address,
        chain: 'ethereum'
      });

      const body = expectFetchCalledWith('/api/v1/profiler/address/related-wallets');
      expect(body.filters).toBeUndefined();
    });

    it('should strip undefined values from body', async () => {
      setupMock(MOCK_RESPONSES.tokenFlows);

      await api.tokenFlows({
        tokenAddress: TEST_DATA.solana.token,
        chain: 'solana'
      });

      const body = expectFetchCalledWith('/api/v1/tgm/flows');
      expect(body.order_by).toBeUndefined();
      expect(body.pagination).toBeUndefined();
    });
  });

  // =================== x402 Auto-Payment ===================

  describe('x402 Auto-Payment', () => {
    // Override HOME so the x402 handler doesn't find real wallet config on disk
    const savedHome = process.env.HOME;
    let tmpHome;
    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-api-test-'));
      process.env.HOME = tmpHome;
    });
    afterEach(() => {
      process.env.HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('should auto-pay on 402 and retry successfully', async () => {
      if (LIVE_TEST) return;

      const paymentReqs = {
        accepts: [{
          scheme: 'exact',
          asset: '0xUSDC',
          payTo: '0xRecipient',
          amount: '10000',
          network: 'base',
          maxTimeoutSeconds: 120,
          extra: { name: 'USD Coin', version: '2', chainId: 8453, symbol: 'USDC', decimals: 6 },
        }],
      };
      const paymentHeader = btoa(JSON.stringify(paymentReqs));

      const errorResponse = {
        ok: false,
        status: 402,
        json: async () => ({ message: 'Payment required' }),
        headers: { get: (h) => h === 'payment-required' ? paymentHeader : null },
      };
      const successData = { netflows: [{ token_symbol: 'TEST' }] };
      const successResponse = {
        ok: true,
        json: async () => successData,
        text: async () => JSON.stringify(successData),
      };

      mockFetch
        .mockResolvedValueOnce(errorResponse)
        .mockResolvedValueOnce(successResponse);

      const autoPayApi = new NansenAPI('test-key', 'https://api.nansen.ai');

      // Mock the dynamic import — resetModules ensures fresh resolution
      const mockHandleX402Payment = vi.fn().mockResolvedValue('mock-payment-sig');
      vi.resetModules();
      vi.doMock('../walletconnect-x402.js', () => ({ handleX402Payment: mockHandleX402Payment }));

      const result = await autoPayApi.smartMoneyNetflow({});
      expect(result.netflows).toBeDefined();

      // Verify the retry had the Payment-Signature header
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const retryCall = mockFetch.mock.calls[1];
      expect(retryCall[1].headers['Payment-Signature']).toBe('mock-payment-sig');

      vi.doUnmock('../walletconnect-x402.js');
    });

    it('should fall through when manual Payment-Signature header is set', async () => {
      if (LIVE_TEST) return;

      const paymentReqs = { accepts: [{ scheme: 'exact', asset: '0xUSDC', payTo: '0xR', amount: '1', extra: { name: 'X', version: '1', chainId: 1 } }] };
      const paymentHeader = btoa(JSON.stringify(paymentReqs));

      const errorResponse = {
        ok: false,
        status: 402,
        json: async () => ({ message: 'Payment required' }),
        headers: { get: (h) => h === 'payment-required' ? paymentHeader : null },
      };

      mockFetch.mockResolvedValueOnce(errorResponse);

      const manualApi = new NansenAPI('test-key', 'https://api.nansen.ai', {
        defaultHeaders: { 'Payment-Signature': 'manual-sig' },
      });

      let thrownError;
      try {
        await manualApi.smartMoneyNetflow({});
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.code).toBe(ErrorCode.PAYMENT_REQUIRED);
      // Should use the manual error message, not attempt auto-pay
      expect(thrownError.message).toContain('x402-payment-signature');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should propagate x402 auto-pay failure as error', async () => {
      if (LIVE_TEST) return;

      const paymentReqs = {
        accepts: [{
          scheme: 'exact',
          asset: '0xUSDC',
          payTo: '0xR',
          amount: '1',
          network: 'base',
          extra: { name: 'X', version: '1', chainId: 1 },
        }],
      };
      const paymentHeader = btoa(JSON.stringify(paymentReqs));

      const errorResponse = {
        ok: false,
        status: 402,
        json: async () => ({ message: 'Payment required' }),
        headers: { get: (h) => h === 'payment-required' ? paymentHeader : null },
      };

      mockFetch.mockResolvedValueOnce(errorResponse);

      // Mock x402 to throw — resetModules ensures fresh resolution
      vi.resetModules();
      vi.doMock('../walletconnect-x402.js', () => ({
        handleX402Payment: vi.fn().mockRejectedValue(new Error('No wallet connected')),
      }));

      const autoPayApi = new NansenAPI('test-key', 'https://api.nansen.ai');

      let thrownError;
      try {
        await autoPayApi.smartMoneyNetflow({});
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.code).toBe(ErrorCode.PAYMENT_REQUIRED);
      expect(thrownError.message).toContain('auto-payment failed');
      // With an API key, payment requirements details are included for debugging
      expect(thrownError.details).toHaveProperty('paymentRequirements');

      vi.doUnmock('../walletconnect-x402.js');
    });

    it('should show login guidance (not x402 dump) when no API key and no wallet', async () => {
      if (LIVE_TEST) return;

      const paymentReqs = {
        accepts: [{
          scheme: 'exact',
          asset: '0xUSDC',
          payTo: '0xR',
          amount: '1',
          network: 'base',
          extra: { name: 'X', version: '1', chainId: 1 },
        }],
      };
      const paymentHeader = btoa(JSON.stringify(paymentReqs));

      const errorResponse = {
        ok: false,
        status: 402,
        json: async () => ({ message: 'Payment required' }),
        headers: { get: (h) => h === 'payment-required' ? paymentHeader : null },
      };

      mockFetch.mockResolvedValueOnce(errorResponse);

      vi.resetModules();
      vi.doMock('../walletconnect-x402.js', () => ({
        handleX402Payment: vi.fn().mockRejectedValue(new Error('x402 payment required but no wallet connected')),
      }));

      // No API key — simulates a fresh install with no login
      const unauthApi = new NansenAPI(null, 'https://api.nansen.ai');

      let thrownError;
      try {
        await unauthApi.smartMoneyNetflow({});
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.code).toBe(ErrorCode.PAYMENT_REQUIRED);
      // Should guide toward login, not mention x402 internals
      expect(thrownError.message).toContain('nansen login');
      expect(thrownError.message).not.toContain('walletconnect connect');
      // Should NOT include the payment requirements blob (unhelpful noise for unauthenticated users)
      expect(thrownError.details?.paymentRequirements).toBeUndefined();

      vi.doUnmock('../walletconnect-x402.js');
    });
  });

  // =================== Smart Alert Endpoints ===================

  describe('Smart Alerts', () => {
    it('alertsList should GET /api/v1/smart-alert/list', async () => {
      setupMock(MOCK_RESPONSES.alertsList);
      const result = await api.alertsList();
      expectFetchCalledWith('/api/v1/smart-alert/list', {}, 'GET');
      expect(result).toBeInstanceOf(Array);
      expect(result[0]).toHaveProperty('id', 'alert-1');
    });

    it('alertsList should append filter params as query string', async () => {
      setupMock(MOCK_RESPONSES.alertsList);
      await api.alertsList({ type: 'sm-token-flows', isEnabled: true, limit: 10 });
      expectFetchCalledWith('/api/v1/smart-alert/list?type=sm-token-flows&isEnabled=true&limit=10', {}, 'GET');
    });

    it('alertsCreate should POST /api/v1/smart-alert', async () => {
      setupMock(MOCK_RESPONSES.alertsCreate);
      const params = { name: 'Test', type: 'sm-token-flows', timeWindow: '1h', channels: [], data: {} };
      const result = await api.alertsCreate(params);
      expectFetchCalledWith('/api/v1/smart-alert', { name: 'Test', type: 'sm-token-flows' });
      expect(result).toHaveProperty('id', 'alert-2');
    });

    it('alertsUpdate should PATCH /api/v1/smart-alert', async () => {
      setupMock(MOCK_RESPONSES.alertsUpdate);
      const result = await api.alertsUpdate({ id: 'alert-1', name: 'Updated Alert' });
      expectFetchCalledWith('/api/v1/smart-alert', { id: 'alert-1', name: 'Updated Alert' }, 'PATCH');
      expect(result).toHaveProperty('name', 'Updated Alert');
    });

    it('alertsToggle should PATCH /api/v1/smart-alert/toggle', async () => {
      setupMock(MOCK_RESPONSES.alertsToggle);
      const result = await api.alertsToggle({ id: 'alert-1', isEnabled: false });
      expectFetchCalledWith('/api/v1/smart-alert/toggle', { id: 'alert-1', isEnabled: false }, 'PATCH');
      expect(result).toHaveProperty('isEnabled', false);
    });

    it('alertsDelete should DELETE /api/v1/smart-alert/:id', async () => {
      setupMock(MOCK_RESPONSES.alertsDelete);
      const result = await api.alertsDelete('alert-1');
      expectFetchCalledWith('/api/v1/smart-alert/alert-1', {}, 'DELETE');
      expect(result).toHaveProperty('success', true);
    });

    it('alertsDelete should encode special characters in alert ID', async () => {
      setupMock(MOCK_RESPONSES.alertsDelete);
      await api.alertsDelete('alert/with/slashes');
      expectFetchCalledWith('/api/v1/smart-alert/alert%2Fwith%2Fslashes', {}, 'DELETE');
    });
  });

  // =================== Supported Chains ===================

  describe('Supported Chains', () => {
    const CHAINS = [
      'ethereum', 'solana', 'base', 'bnb', 'arbitrum',
      'polygon', 'optimism', 'avalanche', 'linea', 'scroll'
    ];

    it('should accept all documented chains', async () => {
      for (const chain of CHAINS) {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        const result = await api.smartMoneyNetflow({ chains: [chain] });
        expect(result).toBeDefined();
      }
    });
  });
});
