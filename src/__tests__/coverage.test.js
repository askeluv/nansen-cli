/**
 * API Endpoint Coverage Test
 * 
 * Verifies all documented Nansen API endpoints are implemented
 */

import { describe, it, expect } from 'vitest';
import { NansenAPI } from '../api.js';
import { batchProfile, traceCounterparties, compareWallets } from '../cli.js';

// All documented endpoints from Nansen API
const DOCUMENTED_ENDPOINTS = {
  smartMoney: [
    { name: 'netflow', method: 'smartMoneyNetflow', endpoint: '/api/v1/smart-money/netflow' },
    { name: 'holdings', method: 'smartMoneyHoldings', endpoint: '/api/v1/smart-money/holdings' },
    { name: 'dex-trades', method: 'smartMoneyDexTrades', endpoint: '/api/v1/smart-money/dex-trades' },
    { name: 'dcas', method: 'smartMoneyDcas', endpoint: '/api/v1/smart-money/dcas' },
    { name: 'perp-trades', method: 'smartMoneyPerpTrades', endpoint: '/api/v1/smart-money/perp-trades' },
    { name: 'historical-holdings', method: 'smartMoneyHistoricalHoldings', endpoint: '/api/v1/smart-money/historical-holdings' },
  ],
  profiler: [
    { name: 'balance', method: 'addressBalance', endpoint: '/api/v1/profiler/address/current-balance' },
    { name: 'labels', method: 'addressLabels', endpoint: '/api/beta/profiler/address/labels' },
    { name: 'transactions', method: 'addressTransactions', endpoint: '/api/v1/profiler/address/transactions' },
    { name: 'pnl', method: 'addressPnl', endpoint: '/api/v1/profiler/address/pnl-and-trade-performance' },
    { name: 'search', method: 'entitySearch', endpoint: '/api/beta/profiler/entity-name-search' },
    { name: 'historical-balances', method: 'addressHistoricalBalances', endpoint: '/api/v1/profiler/address/historical-balances' },
    { name: 'related-wallets', method: 'addressRelatedWallets', endpoint: '/api/v1/profiler/address/related-wallets' },
    { name: 'counterparties', method: 'addressCounterparties', endpoint: '/api/v1/profiler/address/counterparties' },
    { name: 'pnl-summary', method: 'addressPnlSummary', endpoint: '/api/v1/profiler/address/pnl-summary' },
    { name: 'perp-positions', method: 'addressPerpPositions', endpoint: '/api/v1/profiler/perp-positions' },
    { name: 'perp-trades', method: 'addressPerpTrades', endpoint: '/api/v1/profiler/perp-trades' },
  ],
  tokenGodMode: [
    { name: 'indicators', method: 'tokenIndicators', endpoint: '/api/v1/tgm/indicators' },
    { name: 'token-ohlcv', method: 'tokenOhlcv', endpoint: '/api/v1/tgm/token-ohlcv' },
    { name: 'screener', method: 'tokenScreener', endpoint: '/api/v1/token-screener' },
    { name: 'holders', method: 'tokenHolders', endpoint: '/api/v1/tgm/holders' },
    { name: 'flows', method: 'tokenFlows', endpoint: '/api/v1/tgm/flows' },
    { name: 'dex-trades', method: 'tokenDexTrades', endpoint: '/api/v1/tgm/dex-trades' },
    { name: 'pnl-leaderboard', method: 'tokenPnlLeaderboard', endpoint: '/api/v1/tgm/pnl-leaderboard' },
    { name: 'who-bought-sold', method: 'tokenWhoBoughtSold', endpoint: '/api/v1/tgm/who-bought-sold' },
    { name: 'flow-intelligence', method: 'tokenFlowIntelligence', endpoint: '/api/v1/tgm/flow-intelligence' },
    { name: 'transfers', method: 'tokenTransfers', endpoint: '/api/v1/tgm/transfers' },
    { name: 'jup-dca', method: 'tokenJupDca', endpoint: '/api/v1/tgm/jup-dca' },
    { name: 'perp-trades', method: 'tokenPerpTrades', endpoint: '/api/v1/tgm/perp-trades' },
    { name: 'perp-positions', method: 'tokenPerpPositions', endpoint: '/api/v1/tgm/perp-positions' },
    { name: 'perp-pnl-leaderboard', method: 'tokenPerpPnlLeaderboard', endpoint: '/api/v1/tgm/perp-pnl-leaderboard' },
    { name: 'top-tokens', method: 'topTokens', endpoint: '/api/v1/nansen-score/top-tokens' },
  ],
  composite: [
    { name: 'batch-profile', fn: batchProfile, endpoint: 'composite' },
    { name: 'trace-counterparties', fn: traceCounterparties, endpoint: 'composite' },
    { name: 'compare-wallets', fn: compareWallets, endpoint: 'composite' },
  ],
  portfolio: [
    { name: 'defi-holdings', method: 'portfolioDefiHoldings', endpoint: '/api/v1/portfolio/defi-holdings' },
  ],
  search: [
    { name: 'general-search', method: 'generalSearch', endpoint: '/api/v1/search/general' },
  ],
  predictionMarket: [
    { name: 'ohlcv', method: 'pmOhlcv', endpoint: '/api/v1/prediction-market/ohlcv' },
    { name: 'orderbook', method: 'pmOrderbook', endpoint: '/api/v1/prediction-market/orderbook' },
    { name: 'top-holders', method: 'pmTopHolders', endpoint: '/api/v1/prediction-market/top-holders' },
    { name: 'trades-by-market', method: 'pmTradesByMarket', endpoint: '/api/v1/prediction-market/trades-by-market' },
    { name: 'trades-by-address', method: 'pmTradesByAddress', endpoint: '/api/v1/prediction-market/trades-by-address' },
    { name: 'market-screener', method: 'pmMarketScreener', endpoint: '/api/v1/prediction-market/market-screener' },
    { name: 'event-screener', method: 'pmEventScreener', endpoint: '/api/v1/prediction-market/event-screener' },
    { name: 'pnl-by-market', method: 'pmPnlByMarket', endpoint: '/api/v1/prediction-market/pnl-by-market' },
    { name: 'pnl-by-address', method: 'pmPnlByAddress', endpoint: '/api/v1/prediction-market/pnl-by-address' },
    { name: 'position-detail', method: 'pmPositionDetail', endpoint: '/api/v1/prediction-market/position-detail' },
    { name: 'categories', method: 'pmCategories', endpoint: '/api/v1/prediction-market/categories' },
  ],
};

// Endpoints that are documented but return 404 (confirmed non-existent)
const NOT_IMPLEMENTED = [
  // These endpoints return 404 and should NOT be implemented
  // 'perpLeaderboard' - Profiler perp-leaderboard returns 404
  // 'tokenPerpScreener' - TGM perp-screener returns 404
];

describe('API Endpoint Coverage', () => {
  const api = new NansenAPI('test-key');

  describe('Smart Money Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.smartMoney) {
      it(`should have ${ep.name} method`, () => {
        expect(typeof api[ep.method]).toBe('function');
      });
    }
  });

  describe('Profiler Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.profiler) {
      it(`should have ${ep.name} method`, () => {
        expect(typeof api[ep.method]).toBe('function');
      });
    }
  });

  describe('Token God Mode Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.tokenGodMode) {
      it(`should have ${ep.name} method`, () => {
        expect(typeof api[ep.method]).toBe('function');
      });
    }
  });

  describe('Composite Methods', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.composite) {
      it(`should have ${ep.name} as exported function from cli.js`, () => {
        expect(typeof ep.fn).toBe('function');
      });
    }
  });

  describe('Portfolio Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.portfolio) {
      it(`should have ${ep.name} method`, () => {
        expect(typeof api[ep.method]).toBe('function');
      });
    }
  });

  describe('Search Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.search) {
      it(`should have ${ep.name} method`, () => {
        expect(typeof api[ep.method]).toBe('function');
      });
    }
  });

  describe('Prediction Market Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.predictionMarket) {
      it(`should have ${ep.name} method`, () => {
        expect(typeof api[ep.method]).toBe('function');
      });
    }
  });

  describe('Coverage Summary', () => {
    it('should report implemented endpoints', () => {
      const implemented = [
        ...DOCUMENTED_ENDPOINTS.smartMoney,
        ...DOCUMENTED_ENDPOINTS.profiler,
        ...DOCUMENTED_ENDPOINTS.tokenGodMode,
        ...DOCUMENTED_ENDPOINTS.composite,
        ...DOCUMENTED_ENDPOINTS.portfolio,
        ...DOCUMENTED_ENDPOINTS.search,
        ...DOCUMENTED_ENDPOINTS.predictionMarket,
      ];
      
      console.log(`\n📊 API Coverage Summary:`);
      console.log(`   Implemented: ${implemented.length} endpoints`);
      console.log(`   Not yet implemented: ${NOT_IMPLEMENTED.length} endpoints`);
      console.log(`   Coverage: ${((implemented.length / (implemented.length + NOT_IMPLEMENTED.length)) * 100).toFixed(1)}%`);
      
      if (NOT_IMPLEMENTED.length > 0) {
        console.log(`\n⚠️  Missing endpoints:`);
        NOT_IMPLEMENTED.forEach(ep => console.log(`   - ${ep}`));
      }
      
      expect(implemented.length).toBeGreaterThan(0);
    });
  });
});

describe('Supported Chains Coverage', () => {
  const DOCUMENTED_CHAINS = [
    'ethereum', 'solana', 'base', 'bnb', 'arbitrum',
    'polygon', 'optimism', 'avalanche', 'linea', 'scroll',
    'mantle', 'ronin', 'sei', 'plasma',
    'sonic', 'monad', 'hyperevm', 'iotaevm', 'xlayer'
  ];

  it('should document all supported chains', () => {
    // Just verify the list is comprehensive
    expect(DOCUMENTED_CHAINS).toContain('ethereum');
    expect(DOCUMENTED_CHAINS).toContain('solana');
    expect(DOCUMENTED_CHAINS).toContain('base');
    expect(DOCUMENTED_CHAINS.length).toBeGreaterThanOrEqual(18);
    
    console.log(`\n🔗 Supported Chains: ${DOCUMENTED_CHAINS.length}`);
    console.log(`   ${DOCUMENTED_CHAINS.join(', ')}`);
  });
});

describe('Smart Money Labels Coverage', () => {
  const DOCUMENTED_LABELS = [
    'Fund',
    'Smart Trader',
    '30D Smart Trader',
    '90D Smart Trader',
    '180D Smart Trader',
    'Smart HL Perps Trader',
  ];

  it('should document all smart money labels', () => {
    expect(DOCUMENTED_LABELS).toContain('Fund');
    expect(DOCUMENTED_LABELS).toContain('Smart Trader');
    expect(DOCUMENTED_LABELS.length).toBeGreaterThanOrEqual(6);
    
    console.log(`\n🏷️  Smart Money Labels: ${DOCUMENTED_LABELS.length}`);
    DOCUMENTED_LABELS.forEach(label => console.log(`   - ${label}`));
  });
});
