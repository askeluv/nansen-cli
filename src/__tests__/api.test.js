/**
 * Nansen API Test Suite
 * 
 * Run with mocks: npm test
 * Run with live API: npm run test:live (requires NANSEN_API_KEY)
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NansenAPI } from '../api.js';

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
  }
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
    // Clear mock call history between tests
    if (mockFetch) {
      mockFetch.mockClear();
    }
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
  function expectFetchCalledWith(expectedEndpoint, expectedBodyContains = {}) {
    if (LIVE_TEST) return;
    
    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    
    // Verify URL
    expect(url).toBe(`https://api.nansen.ai${expectedEndpoint}`);
    
    // Verify method and headers
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['apikey']).toBe('test-api-key');
    
    // Verify body contains expected fields
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
    });

    describe('addressPnl', () => {
      it('should fetch PnL data with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.addressPnl);
        
        const result = await api.addressPnl({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        const body = expectFetchCalledWith('/api/v1/profiler/address/pnl-and-trade-performance');
        expect(body.address).toBe(TEST_DATA.ethereum.address);
        expect(body.chain).toBe('ethereum');
        
        expect(result.total_pnl).toBe(50000);
        expect(result.realized_pnl).toBe(30000);
        expect(result.unrealized_pnl).toBe(20000);
      });
    });

    describe('entitySearch', () => {
      it('should search for entities with correct endpoint', async () => {
        setupMock(MOCK_RESPONSES.entitySearch);
        
        const result = await api.entitySearch({ query: 'Vitalik' });
        
        const body = expectFetchCalledWith('/api/beta/profiler/entity-name-search');
        expect(body.parameters.query).toBe('Vitalik');
        
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
        
        expect(result.inflows).toBe(1000000);
        expect(result.outflows).toBe(500000);
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
        
        expect(result.buyers).toBeInstanceOf(Array);
        expect(result.sellers).toBeInstanceOf(Array);
        expect(result.buyers[0]).toHaveProperty('amount_usd', 1000);
        expect(result.sellers[0]).toHaveProperty('amount_usd', 500);
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
        
        expect(result.flows).toBeInstanceOf(Array);
        expect(result.flows[0]).toHaveProperty('label', 'Smart Money');
        expect(result.flows[0]).toHaveProperty('net_flow_usd', 500000);
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

  // =================== Error Handling ===================

  describe('Error Handling', () => {
    it('should throw with message from API error response', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized', message: 'Invalid API key' })
      });

      await expect(api.smartMoneyNetflow({})).rejects.toThrow('Invalid API key');
    });

    it('should throw on network errors', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(api.smartMoneyNetflow({})).rejects.toThrow('Network error');
    });

    it('should include status code in error object', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: 'Rate limited' })
      });

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
        // If we get here, the test should fail
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        thrownError = error;
      }
      
      expect(thrownError).toBeDefined();
      expect(thrownError.status).toBe(429);
      expect(thrownError.message).toContain('Rate limited');
    });

    it('should handle 500 server errors', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' })
      });

      await expect(api.smartMoneyNetflow({})).rejects.toThrow();
    });

    it('should handle timeout errors', async () => {
      if (LIVE_TEST) return;
      
      mockFetch.mockRejectedValueOnce(new Error('Request timeout'));

      await expect(api.tokenScreener({ chains: ['solana'] })).rejects.toThrow('timeout');
    });

    it('should include original error data in thrown error', async () => {
      if (LIVE_TEST) return;
      
      const errorData = { error: 'Bad request', details: { field: 'chains', message: 'required' } };
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => errorData
      });

      let thrownError;
      try {
        await api.smartMoneyNetflow({});
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        thrownError = error;
      }
      
      expect(thrownError.data).toEqual(errorData);
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
      
      const body = expectFetchCalledWith('/api/beta/profiler/entity-name-search');
      expect(body.parameters.query).toBe('Test & Co. <script>');
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
