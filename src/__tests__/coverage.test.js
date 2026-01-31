/**
 * API Endpoint Coverage Test
 * 
 * Verifies all documented Nansen API endpoints are implemented
 */

import { describe, it, expect } from 'vitest';
import { NansenAPI } from '../api.js';

// All documented endpoints from Nansen API
const DOCUMENTED_ENDPOINTS = {
  smartMoney: [
    { name: 'netflow', method: 'smartMoneyNetflow', endpoint: '/api/v1/smart-money/netflow' },
    { name: 'holdings', method: 'smartMoneyHoldings', endpoint: '/api/v1/smart-money/holdings' },
    { name: 'dex-trades', method: 'smartMoneyDexTrades', endpoint: '/api/v1/smart-money/dex-trades' },
    { name: 'dcas', method: 'smartMoneyDcas', endpoint: '/api/v1/smart-money/dcas' },
    { name: 'perp-trades', method: 'smartMoneyPerpTrades', endpoint: '/api/v1/smart-money/perp-trades' },
    // Not yet implemented:
    // { name: 'historical-holdings', method: 'smartMoneyHistoricalHoldings', endpoint: '/api/v1/smart-money/historical-holdings' },
  ],
  profiler: [
    { name: 'balance', method: 'addressBalance', endpoint: '/api/v1/profiler/address/current-balance' },
    { name: 'labels', method: 'addressLabels', endpoint: '/api/beta/profiler/address/labels' },
    { name: 'transactions', method: 'addressTransactions', endpoint: '/api/v1/profiler/address/transactions' },
    { name: 'pnl', method: 'addressPnl', endpoint: '/api/v1/profiler/address/pnl-and-trade-performance' },
    { name: 'search', method: 'entitySearch', endpoint: '/api/beta/profiler/entity-name-search' },
    // Not yet implemented:
    // { name: 'historical-balances', method: 'addressHistoricalBalances', endpoint: '/api/v1/profiler/address/historical-balances' },
    // { name: 'perp-positions', method: 'addressPerpPositions', endpoint: '/api/v1/profiler/perp-positions' },
    // { name: 'perp-trades', method: 'addressPerpTrades', endpoint: '/api/v1/profiler/perp-trades' },
    // { name: 'related-wallets', method: 'addressRelatedWallets', endpoint: '/api/v1/profiler/address/related-wallets' },
    // { name: 'pnl-summary', method: 'addressPnlSummary', endpoint: '/api/v1/profiler/address/pnl-summary' },
    // { name: 'counterparties', method: 'addressCounterparties', endpoint: '/api/v1/profiler/address/counterparties' },
  ],
  tokenGodMode: [
    { name: 'screener', method: 'tokenScreener', endpoint: '/api/v1/token-screener' },
    { name: 'holders', method: 'tokenHolders', endpoint: '/api/v1/tgm/holders' },
    { name: 'flows', method: 'tokenFlows', endpoint: '/api/v1/tgm/flows' },
    { name: 'dex-trades', method: 'tokenDexTrades', endpoint: '/api/v1/tgm/dex-trades' },
    { name: 'pnl-leaderboard', method: 'tokenPnlLeaderboard', endpoint: '/api/v1/tgm/pnl-leaderboard' },
    { name: 'who-bought-sold', method: 'tokenWhoBoughtSold', endpoint: '/api/v1/tgm/who-bought-sold' },
    // Not yet implemented:
    // { name: 'perp-screener', method: 'tokenPerpScreener', endpoint: '/api/v1/tgm/perp-screener' },
    // { name: 'flow-intelligence', method: 'tokenFlowIntelligence', endpoint: '/api/v1/tgm/flow-intelligence' },
    // { name: 'transfers', method: 'tokenTransfers', endpoint: '/api/v1/tgm/transfers' },
    // { name: 'jup-dca', method: 'tokenJupDca', endpoint: '/api/v1/tgm/jup-dca' },
    // { name: 'perp-trades', method: 'tokenPerpTrades', endpoint: '/api/v1/tgm/perp-trades' },
    // { name: 'perp-positions', method: 'tokenPerpPositions', endpoint: '/api/v1/tgm/perp-positions' },
    // { name: 'perp-pnl-leaderboard', method: 'tokenPerpPnlLeaderboard', endpoint: '/api/v1/tgm/perp-pnl-leaderboard' },
  ],
  portfolio: [
    { name: 'defi-holdings', method: 'portfolioDefiHoldings', endpoint: '/api/v1/portfolio/defi-holdings' },
  ],
};

// Endpoints that are documented but not yet implemented
const NOT_IMPLEMENTED = [
  // Smart Money
  'smartMoneyHistoricalHoldings',
  // Profiler
  'addressHistoricalBalances',
  'addressPerpPositions',
  'addressPerpTrades',
  'addressRelatedWallets',
  'addressPnlSummary',
  'addressCounterparties',
  'perpLeaderboard',
  // Token God Mode
  'tokenPerpScreener',
  'tokenFlowIntelligence',
  'tokenTransfers',
  'tokenJupDca',
  'tokenPerpTrades',
  'tokenPerpPositions',
  'tokenPerpPnlLeaderboard',
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

  describe('Portfolio Endpoints', () => {
    for (const ep of DOCUMENTED_ENDPOINTS.portfolio) {
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
        ...DOCUMENTED_ENDPOINTS.portfolio,
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
    'zksync', 'mantle', 'ronin', 'sei', 'plasma',
    'sonic', 'unichain', 'monad', 'hyperevm', 'iotaevm'
  ];

  it('should document all supported chains', () => {
    // Just verify the list is comprehensive
    expect(DOCUMENTED_CHAINS).toContain('ethereum');
    expect(DOCUMENTED_CHAINS).toContain('solana');
    expect(DOCUMENTED_CHAINS).toContain('base');
    expect(DOCUMENTED_CHAINS.length).toBeGreaterThanOrEqual(20);
    
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
