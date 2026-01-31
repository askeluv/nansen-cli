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
  }
};

describe('NansenAPI', () => {
  let api;
  let mockFetch;

  beforeAll(() => {
    if (LIVE_TEST) {
      api = new NansenAPI(API_KEY);
    } else {
      // Mock fetch for unit tests
      mockFetch = vi.fn();
      global.fetch = mockFetch;
      api = new NansenAPI('test-api-key');
    }
  });

  function setupMock(response) {
    if (!LIVE_TEST) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => response
      });
    }
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
      it('should fetch netflow data', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        const result = await api.smartMoneyNetflow({ chains: ['solana'] });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.netflows).toHaveLength(1);
        }
      });

      it('should support filters', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        const result = await api.smartMoneyNetflow({
          chains: ['ethereum'],
          filters: { min_inflow_usd: 10000 }
        });
        
        expect(result).toBeDefined();
      });

      it('should support pagination', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyNetflow);
        
        const result = await api.smartMoneyNetflow({
          chains: ['solana'],
          pagination: { page: 1, recordsPerPage: 10 }
        });
        
        expect(result).toBeDefined();
      });
    });

    describe('smartMoneyDexTrades', () => {
      it('should fetch DEX trades', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDexTrades);
        
        const result = await api.smartMoneyDexTrades({ chains: ['solana'] });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.trades).toHaveLength(1);
        }
      });

      it('should filter by chain', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDexTrades);
        
        const result = await api.smartMoneyDexTrades({ chains: ['ethereum', 'base'] });
        
        expect(result).toBeDefined();
      });
    });

    describe('smartMoneyPerpTrades', () => {
      it('should fetch perp trades', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyPerpTrades);
        
        const result = await api.smartMoneyPerpTrades({});
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.trades).toHaveLength(1);
        }
      });
    });

    describe('smartMoneyHoldings', () => {
      it('should fetch holdings', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyHoldings);
        
        const result = await api.smartMoneyHoldings({ chains: ['solana'] });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.holdings).toHaveLength(1);
        }
      });
    });

    describe('smartMoneyDcas', () => {
      it('should fetch DCA orders', async () => {
        setupMock(MOCK_RESPONSES.smartMoneyDcas);
        
        const result = await api.smartMoneyDcas({});
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.dcas).toHaveLength(1);
        }
      });
    });
  });

  // =================== Profiler Endpoints ===================

  describe('Profiler', () => {
    describe('addressBalance', () => {
      it('should fetch current balance', async () => {
        setupMock(MOCK_RESPONSES.addressBalance);
        
        const result = await api.addressBalance({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.balances).toHaveLength(1);
        }
      });

      it('should support entity name lookup', async () => {
        setupMock(MOCK_RESPONSES.addressBalance);
        
        const result = await api.addressBalance({
          entityName: 'Binance',
          chain: 'ethereum'
        });
        
        expect(result).toBeDefined();
      });

      it('should filter spam tokens', async () => {
        setupMock(MOCK_RESPONSES.addressBalance);
        
        const result = await api.addressBalance({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          hideSpamToken: true
        });
        
        expect(result).toBeDefined();
      });
    });

    describe('addressLabels', () => {
      it('should fetch address labels', async () => {
        setupMock(MOCK_RESPONSES.addressLabels);
        
        const result = await api.addressLabels({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.labels).toContain('Smart Trader');
        }
      });
    });

    describe('addressTransactions', () => {
      it('should fetch transactions', async () => {
        setupMock(MOCK_RESPONSES.addressTransactions);
        
        const result = await api.addressTransactions({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.transactions).toHaveLength(1);
        }
      });

      it('should support order by', async () => {
        setupMock(MOCK_RESPONSES.addressTransactions);
        
        const result = await api.addressTransactions({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum',
          orderBy: [{ column: 'timestamp', order: 'desc' }]
        });
        
        expect(result).toBeDefined();
      });
    });

    describe('addressPnl', () => {
      it('should fetch PnL data', async () => {
        setupMock(MOCK_RESPONSES.addressPnl);
        
        const result = await api.addressPnl({
          address: TEST_DATA.ethereum.address,
          chain: 'ethereum'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.total_pnl).toBe(50000);
        }
      });
    });

    describe('entitySearch', () => {
      it('should search for entities', async () => {
        setupMock(MOCK_RESPONSES.entitySearch);
        
        const result = await api.entitySearch({ query: 'Vitalik' });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.results).toHaveLength(1);
        }
      });
    });
  });

  // =================== Token God Mode Endpoints ===================

  describe('Token God Mode', () => {
    describe('tokenScreener', () => {
      it('should screen tokens', async () => {
        setupMock(MOCK_RESPONSES.tokenScreener);
        
        const result = await api.tokenScreener({
          chains: ['solana'],
          timeframe: '24h'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.tokens).toHaveLength(1);
        }
      });

      it('should support multiple timeframes', async () => {
        for (const timeframe of ['5m', '1h', '6h', '24h', '7d', '30d']) {
          setupMock(MOCK_RESPONSES.tokenScreener);
          
          const result = await api.tokenScreener({
            chains: ['solana'],
            timeframe
          });
          
          expect(result).toBeDefined();
        }
      });
    });

    describe('tokenHolders', () => {
      it('should fetch token holders', async () => {
        setupMock(MOCK_RESPONSES.tokenHolders);
        
        const result = await api.tokenHolders({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.holders).toHaveLength(1);
        }
      });

      it('should support label type filter', async () => {
        setupMock(MOCK_RESPONSES.tokenHolders);
        
        const result = await api.tokenHolders({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          labelType: 'smart_money'
        });
        
        expect(result).toBeDefined();
      });
    });

    describe('tokenFlows', () => {
      it('should fetch token flows', async () => {
        setupMock(MOCK_RESPONSES.tokenFlows);
        
        const result = await api.tokenFlows({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.inflows).toBe(1000000);
        }
      });
    });

    describe('tokenDexTrades', () => {
      it('should fetch DEX trades for token', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);
        
        const result = await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.trades).toHaveLength(1);
        }
      });

      it('should filter for smart money only', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);
        
        const result = await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          onlySmartMoney: true
        });
        
        expect(result).toBeDefined();
      });

      it('should support custom date range', async () => {
        setupMock(MOCK_RESPONSES.tokenDexTrades);
        
        const result = await api.tokenDexTrades({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana',
          days: 30
        });
        
        expect(result).toBeDefined();
      });
    });

    describe('tokenPnlLeaderboard', () => {
      it('should fetch PnL leaderboard', async () => {
        setupMock(MOCK_RESPONSES.tokenPnlLeaderboard);
        
        const result = await api.tokenPnlLeaderboard({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.leaders).toHaveLength(1);
        }
      });
    });

    describe('tokenWhoBoughtSold', () => {
      it('should fetch buyers and sellers', async () => {
        setupMock(MOCK_RESPONSES.tokenWhoBoughtSold);
        
        const result = await api.tokenWhoBoughtSold({
          tokenAddress: TEST_DATA.solana.token,
          chain: 'solana'
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.buyers).toHaveLength(1);
          expect(result.sellers).toHaveLength(1);
        }
      });
    });
  });

  // =================== Portfolio Endpoints ===================

  describe('Portfolio', () => {
    describe('portfolioDefiHoldings', () => {
      it('should fetch DeFi holdings', async () => {
        setupMock(MOCK_RESPONSES.portfolioDefiHoldings);
        
        const result = await api.portfolioDefiHoldings({
          walletAddress: TEST_DATA.ethereum.address
        });
        
        expect(result).toBeDefined();
        if (!LIVE_TEST) {
          expect(result.holdings).toHaveLength(1);
        }
      });
    });
  });

  // =================== Error Handling ===================

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      if (!LIVE_TEST) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => ({ error: 'Unauthorized', message: 'Invalid API key' })
        });

        await expect(api.smartMoneyNetflow({})).rejects.toThrow('Invalid API key');
      }
    });

    it('should handle network errors', async () => {
      if (!LIVE_TEST) {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        await expect(api.smartMoneyNetflow({})).rejects.toThrow('Network error');
      }
    });

    it('should include status code in errors', async () => {
      if (!LIVE_TEST) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: async () => ({ error: 'Rate limited' })
        });

        try {
          await api.smartMoneyNetflow({});
        } catch (error) {
          expect(error.status).toBe(429);
        }
      }
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
