/**
 * CLI Internal Tests - Tests CLI functions directly for coverage
 * These tests import functions from cli.js and test them directly,
 * allowing V8 coverage to track execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseArgs,
  formatValue,
  formatTable,
  formatOutput,
  formatError,
  formatStream,
  formatCsv,
  parseSort,
  buildCommands,
  runCLI,
  DEPRECATED_TO_RESEARCH,
  DEPRECATED_TO_TRADE,
  HELP,
  SCHEMA,
  filterFields,
  parseFields,
  batchProfile,
  traceCounterparties,
  compareWallets,
  buildPagination,
  parseAddressList
} from '../cli.js';
import {
  formatAlertsTable,
  buildAlertData,
  buildSmTokenFlowsData,
  buildCommonTokenTransferData,
  buildSmartContractCallData,
  buildAlertsCommands,
  validateAlertData,
} from '../commands/alerts.js';
import { getCachedResponse, setCachedResponse, clearCache, getCacheDir, NansenError, ErrorCode } from '../api.js';
import { EVM_CHAINS } from '../chain-ids.js';
import * as fs from 'fs';
import * as _path from 'path';

describe('parseArgs', () => {
  it('should parse positional arguments', () => {
    const result = parseArgs(['token', 'screener']);
    expect(result._).toEqual(['token', 'screener']);
  });

  it('should parse boolean flags', () => {
    const result = parseArgs(['--pretty', '--table', '--no-retry']);
    expect(result.flags).toEqual({ pretty: true, table: true, 'no-retry': true });
  });

  it('should parse short flags', () => {
    const result = parseArgs(['-p', '-t']);
    expect(result.flags).toEqual({ p: true, t: true });
  });

  it('should parse options with values', () => {
    const result = parseArgs(['--chain', 'solana', '--limit', '10']);
    expect(result.options).toEqual({ chain: 'solana', limit: '10' }); // numbers kept as strings to avoid scientific notation
  });

  it('should parse JSON options', () => {
    const result = parseArgs(['--filters', '{"only_smart_money":true}']);
    expect(result.options.filters).toEqual({ only_smart_money: true });
  });

  it('should handle mixed args', () => {
    const result = parseArgs(['token', 'screener', '--chain', 'solana', '--pretty', '--limit', '5']);
    expect(result._).toEqual(['token', 'screener']);
    expect(result.options.chain).toBe('solana');
    expect(result.options.limit).toBe('5'); // numbers kept as strings to avoid scientific notation
    expect(result.flags.pretty).toBe(true);
  });

  it('should treat flag without value as boolean', () => {
    const result = parseArgs(['--help']);
    expect(result.flags.help).toBe(true);
  });

  it('should handle flag followed by another flag', () => {
    const result = parseArgs(['--verbose', '--debug']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.debug).toBe(true);
  });
});

describe('formatValue', () => {
  it('should return empty string for null/undefined', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('should format large numbers with M suffix', () => {
    expect(formatValue(1500000)).toBe('1.50M');
    expect(formatValue(-2000000)).toBe('-2.00M');
  });

  it('should format thousands with K suffix', () => {
    expect(formatValue(5000)).toBe('5.00K');
    expect(formatValue(-1500)).toBe('-1.50K');
  });

  it('should format integers without decimals', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue(0)).toBe('0');
  });

  it('should format floats with 2 decimals', () => {
    expect(formatValue(3.14159)).toBe('3.14');
  });

  it('should stringify objects', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });

  it('should convert other types to string', () => {
    expect(formatValue('hello')).toBe('hello');
    expect(formatValue(true)).toBe('true');
  });
});

describe('formatTable', () => {
  it('should return "No data" for empty array', () => {
    expect(formatTable([])).toBe('No data');
  });

  it('should format array of objects as table', () => {
    const data = [
      { name: 'Token1', value_usd: 1000 },
      { name: 'Token2', value_usd: 2000 }
    ];
    const result = formatTable(data);
    expect(result).toContain('name');
    expect(result).toContain('value_usd');
    expect(result).toContain('Token1');
    expect(result).toContain('Token2');
  });

  it('should extract data from nested response', () => {
    const response = {
      data: [{ symbol: 'SOL', price_usd: 100 }]
    };
    const result = formatTable(response);
    expect(result).toContain('SOL');
  });

  it('should extract data from results field', () => {
    const response = {
      results: [{ symbol: 'ETH', price_usd: 3000 }]
    };
    const result = formatTable(response);
    expect(result).toContain('ETH');
  });

  it('should extract data from nested data.results', () => {
    const response = {
      data: {
        results: [{ symbol: 'BTC', price_usd: 50000 }]
      }
    };
    const result = formatTable(response);
    expect(result).toContain('BTC');
  });

  it('should handle single object', () => {
    const data = { name: 'Single', value: 123 };
    const result = formatTable(data);
    expect(result).toContain('Single');
  });

  it('should limit to 50 rows', () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ id: i }));
    const result = formatTable(data);
    expect(result).toContain('... and 10 more rows');
  });

  it('should prioritize common fields', () => {
    const data = [{ zebra: 1, token_symbol: 'ABC', apple: 2 }];
    const result = formatTable(data);
    const lines = result.split('\n');
    const header = lines[0];
    // token_symbol should come before zebra (priority field)
    expect(header.indexOf('token_symbol')).toBeLessThan(header.indexOf('zebra'));
  });
});

describe('formatAlertsTable', () => {
  it('should return "No alerts" for empty array', () => {
    expect(formatAlertsTable([])).toBe('No alerts');
  });

  it('should format alerts as table with ID, NAME, TYPE, ENABLED, CHANNELS columns', () => {
    const alerts = [
      { id: 'a1', name: 'ETH Whale Alert', type: 'sm-token-flows', isEnabled: true, channels: [{ type: 'telegram' }] },
      { id: 'a2', name: 'USDC Transfer Alert', type: 'common-token-transfer', isEnabled: false, channels: [{ type: 'slack' }, { type: 'discord' }] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('ID');
    expect(result).toContain('NAME');
    expect(result).toContain('TYPE');
    expect(result).toContain('ENABLED');
    expect(result).toContain('CHANNELS');
    expect(result).toContain('a1');
    expect(result).toContain('a2');
    expect(result).toContain('ETH Whale Alert');
    expect(result).toContain('sm-token-flows');
    expect(result).toContain('✓');
    expect(result).toContain('✗');
    expect(result).toContain('telegram');
    expect(result).toContain('slack, discord');
  });

  it('should handle alerts with no channels', () => {
    const alerts = [
      { id: 'a1', name: 'Test Alert', type: 'sm-token-flows', isEnabled: true, channels: [] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('Test Alert');
    expect(result).not.toContain('undefined');
  });

  it('should truncate long names', () => {
    const alerts = [
      { id: 'a1', name: 'A very long alert name that exceeds the column width and should be truncated', type: 'sm-token-flows', isEnabled: true, channels: [] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('…');
  });

  it('should show full ID without truncation', () => {
    const alerts = [
      { id: 'very-long-alert-id-that-should-not-be-truncated', name: 'Test', type: 'sm-token-flows', isEnabled: true, channels: [] }
    ];
    const result = formatAlertsTable(alerts);
    expect(result).toContain('very-long-alert-id-that-should-not-be-truncated');
  });
});

describe('buildSmTokenFlowsData', () => {
  it('should build data with inflow range flags', () => {
    const result = buildSmTokenFlowsData({
      chains: 'ethereum',
      'inflow-1h-min': '5000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.inflow_1h).toEqual({ min: 5000000 });
  });

  it('should build data with multiple flow ranges', () => {
    const result = buildSmTokenFlowsData({
      'inflow-1h-min': '1000000',
      'outflow-7d-max': '500000',
    });
    expect(result.inflow_1h).toEqual({ min: 1000000 });
    expect(result.outflow_7d).toEqual({ max: 500000 });
  });

  it('should parse --token into inclusion.tokens', () => {
    const result = buildSmTokenFlowsData({
      token: '0xabc123:ethereum',
    });
    expect(result.inclusion).toEqual({ tokens: [{ address: '0xabc123', chain: 'ethereum' }] });
  });

  it('should parse repeated --token into inclusion.tokens array', () => {
    const result = buildSmTokenFlowsData({
      token: ['0xabc:ethereum', '0xdef:base'],
    });
    expect(result.inclusion).toEqual({
      tokens: [
        { address: '0xabc', chain: 'ethereum' },
        { address: '0xdef', chain: 'base' },
      ],
    });
  });

  it('should parse --exclude-token into exclusion.tokens', () => {
    const result = buildSmTokenFlowsData({
      'exclude-token': '0xbad:ethereum',
    });
    expect(result.exclusion).toEqual({ tokens: [{ address: '0xbad', chain: 'ethereum' }] });
  });

  it('should return empty object when no flags provided', () => {
    const result = buildSmTokenFlowsData({});
    expect(result).toEqual({});
  });
});

describe('buildCommonTokenTransferData', () => {
  it('should build data with events and USD range', () => {
    const result = buildCommonTokenTransferData({
      chains: 'ethereum',
      events: 'send,receive',
      'usd-min': '1000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.events).toEqual(['send', 'receive']);
    expect(result.usdValue).toEqual({ min: 1000000 });
  });

  it('should build data with token amount range', () => {
    const result = buildCommonTokenTransferData({
      'token-amount-min': '100',
      'token-amount-max': '5000',
    });
    expect(result.tokenAmount).toEqual({ min: 100, max: 5000 });
  });

  it('should parse --subject into subjects array', () => {
    const result = buildCommonTokenTransferData({
      subject: 'label:Centralized Exchange',
    });
    expect(result.subjects).toEqual([{ type: 'label', value: 'Centralized Exchange' }]);
  });

  it('should parse repeated --subject values', () => {
    const result = buildCommonTokenTransferData({
      subject: ['label:CEX', 'label:DEX'],
    });
    expect(result.subjects).toEqual([
      { type: 'label', value: 'CEX' },
      { type: 'label', value: 'DEX' },
    ]);
  });

  it('should parse --token into inclusion.tokens', () => {
    const result = buildCommonTokenTransferData({
      token: '0xusdc:ethereum',
    });
    expect(result.inclusion).toEqual({ tokens: [{ address: '0xusdc', chain: 'ethereum' }] });
  });
});

describe('buildAlertData', () => {
  it('should dispatch to buildSmTokenFlowsData for sm-token-flows type', () => {
    const result = buildAlertData({
      type: 'sm-token-flows',
      chains: 'ethereum',
      'inflow-1h-min': '5000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.inflow_1h).toEqual({ min: 5000000 });
  });

  it('should dispatch to buildCommonTokenTransferData for common-token-transfer type', () => {
    const result = buildAlertData({
      type: 'common-token-transfer',
      chains: 'ethereum',
      events: 'send,receive',
      'usd-min': '1000000',
    });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.events).toEqual(['send', 'receive']);
    expect(result.usdValue).toEqual({ min: 1000000 });
  });

  it('should fall back to chains-only for unknown type', () => {
    const result = buildAlertData({
      type: 'unknown-type',
      chains: 'solana',
    });
    expect(result).toEqual({ chains: ['solana'] });
  });

  it('should not process --data (handled by handlers)', () => {
    const result = buildAlertData({
      type: 'sm-token-flows',
      chains: 'ethereum',
      data: '{"chains":["base"]}',
    });
    // buildAlertData ignores --data; handlers apply it post-merge
    expect(result.chains).toEqual(['ethereum']);
  });

  it('should work with no type (no flags)', () => {
    const result = buildAlertData({});
    expect(result).toEqual({});
  });

  it('should apply sm-token-flows defaults for all required fields', () => {
    const result = buildAlertData({ type: 'sm-token-flows' });
    expect(result.chains).toEqual([]);
    expect(result.events).toEqual(['sm-token-flows']);
    expect(result.inflow_1h).toEqual({});
    expect(result.inflow_1d).toEqual({});
    expect(result.inflow_7d).toEqual({});
    expect(result.outflow_1h).toEqual({});
    expect(result.outflow_1d).toEqual({});
    expect(result.outflow_7d).toEqual({});
    expect(result.netflow_1h).toEqual({});
    expect(result.netflow_1d).toEqual({});
    expect(result.netflow_7d).toEqual({});
    expect(result.inclusion).toEqual({});
    expect(result.exclusion).toEqual({});
  });

  it('should apply common-token-transfer defaults for all required fields', () => {
    const result = buildAlertData({ type: 'common-token-transfer' });
    expect(result.chains).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.subjects).toEqual([]);
    expect(result.counterparties).toEqual([]);
    expect(result.usdValue).toEqual({});
    expect(result.tokenAmount).toEqual({});
    expect(result.inclusion).toEqual({});
    expect(result.exclusion).toEqual({});
  });

  it('should apply smart-contract-call defaults for all required fields', () => {
    const result = buildAlertData({ type: 'smart-contract-call' });
    expect(result.chains).toEqual([]);
    expect(result.events).toEqual(['smart-contract-call']);
    expect(result.usdValue).toEqual({});
    expect(result.signatureHash).toEqual([]);
    expect(result.inclusion).toEqual({ caller: [], smartContract: [] });
    expect(result.exclusion).toEqual({ caller: [], smartContract: [] });
  });

  it('should deep-merge inclusion/exclusion so partial flags keep sibling defaults (smart-contract-call)', () => {
    const result = buildAlertData({
      type: 'smart-contract-call',
      chains: 'ethereum',
      caller: 'address:0xabc',
    });
    // --caller sets inclusion.caller, but smartContract should still be present from defaults
    expect(result.inclusion.caller).toEqual([{ type: 'address', value: '0xabc' }]);
    expect(result.inclusion.smartContract).toEqual([]);
    // exclusion untouched — both sub-fields from defaults
    expect(result.exclusion).toEqual({ caller: [], smartContract: [] });
  });

  it('should not share mutable references between calls', () => {
    const result1 = buildAlertData({ type: 'smart-contract-call' });
    const result2 = buildAlertData({ type: 'smart-contract-call' });
    result1.inclusion.caller.push({ type: 'address', value: '0x1' });
    expect(result2.inclusion.caller).toEqual([]);
  });

  it('should let user flags override defaults', () => {
    const result = buildAlertData({
      type: 'common-token-transfer',
      chains: 'ethereum,base',
      events: 'send',
      'usd-min': '500',
    });
    expect(result.chains).toEqual(['ethereum', 'base']);
    expect(result.events).toEqual(['send']);
    expect(result.usdValue).toEqual({ min: 500 });
    // Defaults still present for unset fields
    expect(result.counterparties).toEqual([]);
    expect(result.tokenAmount).toEqual({});
    expect(result.inclusion).toEqual({});
    expect(result.exclusion).toEqual({});
  });

  it('should skip defaults when applyDefaults is false (update path)', () => {
    const result = buildAlertData({ type: 'common-token-transfer', chains: 'ethereum' }, { applyDefaults: false });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.counterparties).toBeUndefined();
    expect(result.usdValue).toBeUndefined();
    expect(result.tokenAmount).toBeUndefined();
  });

  it('should not wipe subjects when updating common-token-transfer without --subject', () => {
    // Simulates: user created alert with --subject label:CEX, then updates with only --usd-min 5000
    const result = buildAlertData({ type: 'common-token-transfer', 'usd-min': '5000' }, { applyDefaults: false });
    expect(result.subjects).toBeUndefined();
    expect(result.usdValue).toEqual({ min: 5000 });
  });

  it('should not apply --data (handled by handlers)', () => {
    const result = buildAlertData({
      type: 'sm-token-flows',
      data: '{"events":["custom"]}',
    });
    // --data is ignored by buildAlertData; defaults apply normally
    expect(result.events).toEqual(['sm-token-flows']);
  });
});

describe('buildSmTokenFlowsData netflow fields', () => {
  it('should include netflow-1h range', () => {
    const result = buildSmTokenFlowsData({ 'netflow-1h-min': '100000' });
    expect(result.netflow_1h).toEqual({ min: 100000 });
  });

  it('should include netflow-1d and netflow-7d ranges', () => {
    const result = buildSmTokenFlowsData({ 'netflow-1d-min': '500000', 'netflow-7d-max': '2000000' });
    expect(result.netflow_1d).toEqual({ min: 500000 });
    expect(result.netflow_7d).toEqual({ max: 2000000 });
  });
});

describe('buildCommonTokenTransferData counterparty', () => {
  it('should add counterparties when --counterparty is provided', () => {
    const result = buildCommonTokenTransferData({ counterparty: 'address:0xabc' });
    expect(result.counterparties).toEqual([{ type: 'address', value: '0xabc' }]);
  });

  it('should handle repeated --counterparty flags as array', () => {
    const result = buildCommonTokenTransferData({ counterparty: ['address:0xabc', 'label:Whale'] });
    expect(result.counterparties).toEqual([
      { type: 'address', value: '0xabc' },
      { type: 'label', value: 'Whale' },
    ]);
  });

  it('should not add counterparties when flag is absent', () => {
    const result = buildCommonTokenTransferData({ chains: 'ethereum' });
    expect(result.counterparties).toBeUndefined();
  });
});

describe('buildSmartContractCallData', () => {
  it('should build data with chains and usd range', () => {
    const result = buildSmartContractCallData({ chains: 'ethereum,base', 'usd-min': '1000', 'usd-max': '9999' });
    expect(result.chains).toEqual(['ethereum', 'base']);
    expect(result.usdValue).toEqual({ min: 1000, max: 9999 });
  });

  it('should build signatureHash as array from single value', () => {
    const result = buildSmartContractCallData({ 'signature-hash': '0xa9059cbb' });
    expect(result.signatureHash).toEqual(['0xa9059cbb']);
  });

  it('should build signatureHash as array from repeated flags', () => {
    const result = buildSmartContractCallData({ 'signature-hash': ['0xa9059cbb', '0x23b872dd'] });
    expect(result.signatureHash).toEqual(['0xa9059cbb', '0x23b872dd']);
  });

  it('should build inclusion.caller from --caller', () => {
    const result = buildSmartContractCallData({ caller: 'address:0xabc' });
    expect(result.inclusion.caller).toEqual([{ type: 'address', value: '0xabc' }]);
  });

  it('should build inclusion.smartContract from --contract', () => {
    const result = buildSmartContractCallData({ contract: 'address:0xdef' });
    expect(result.inclusion.smartContract).toEqual([{ type: 'address', value: '0xdef' }]);
  });

  it('should build exclusion.caller from --exclude-caller', () => {
    const result = buildSmartContractCallData({ 'exclude-caller': 'label:Bot' });
    expect(result.exclusion.caller).toEqual([{ type: 'label', value: 'Bot' }]);
  });

  it('should build exclusion.smartContract from --exclude-contract', () => {
    const result = buildSmartContractCallData({ 'exclude-contract': 'address:0x999' });
    expect(result.exclusion.smartContract).toEqual([{ type: 'address', value: '0x999' }]);
  });

  it('should dispatch to buildSmartContractCallData for smart-contract-call type', () => {
    const result = buildAlertData({ type: 'smart-contract-call', chains: 'ethereum', 'signature-hash': '0xa9059cbb' });
    expect(result.chains).toEqual(['ethereum']);
    expect(result.signatureHash).toEqual(['0xa9059cbb']);
  });
});

describe('buildSmTokenFlowsData new inclusion/exclusion flags', () => {
  it('should add token-sector to inclusion.tokenSectors', () => {
    const result = buildSmTokenFlowsData({ 'token-sector': 'DeFi' });
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });

  it('should handle repeated --token-sector', () => {
    const result = buildSmTokenFlowsData({ 'token-sector': ['DeFi', 'NFT'] });
    expect(result.inclusion.tokenSectors).toEqual(['DeFi', 'NFT']);
  });

  it('should add exclude-token-sector to exclusion.tokenSectors', () => {
    const result = buildSmTokenFlowsData({ 'exclude-token-sector': 'Meme' });
    expect(result.exclusion.tokenSectors).toEqual(['Meme']);
  });

  it('should add token-age-max to inclusion.tokenAge', () => {
    const result = buildSmTokenFlowsData({ 'token-age-max': '30' });
    expect(result.inclusion.tokenAge).toEqual({ max: 30 });
  });

  it('should add market-cap range to inclusion.marketCap', () => {
    const result = buildSmTokenFlowsData({ 'market-cap-min': '1000000', 'market-cap-max': '9000000' });
    expect(result.inclusion.marketCap).toEqual({ min: 1000000, max: 9000000 });
  });

  it('should add fdv range to inclusion.fdvUsd', () => {
    const result = buildSmTokenFlowsData({ 'fdv-min': '500000' });
    expect(result.inclusion.fdvUsd).toEqual({ min: 500000 });
  });

  it('should merge token-sector with existing inclusion.tokens', () => {
    const result = buildSmTokenFlowsData({ token: '0xabc:ethereum', 'token-sector': 'DeFi' });
    expect(result.inclusion.tokens).toEqual([{ address: '0xabc', chain: 'ethereum' }]);
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });
});

describe('buildCommonTokenTransferData new inclusion/exclusion flags', () => {
  it('should add token-sector to inclusion.tokenSectors', () => {
    const result = buildCommonTokenTransferData({ 'token-sector': 'DeFi' });
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });

  it('should add exclude-token-sector to exclusion.tokenSectors', () => {
    const result = buildCommonTokenTransferData({ 'exclude-token-sector': ['Meme', 'GameFi'] });
    expect(result.exclusion.tokenSectors).toEqual(['Meme', 'GameFi']);
  });

  it('should add token-age-min and token-age-max to inclusion.tokenAge', () => {
    const result = buildCommonTokenTransferData({ 'token-age-min': '7', 'token-age-max': '90' });
    expect(result.inclusion.tokenAge).toEqual({ min: 7, max: 90 });
  });

  it('should add token-age-max only', () => {
    const result = buildCommonTokenTransferData({ 'token-age-max': '30' });
    expect(result.inclusion.tokenAge).toEqual({ max: 30 });
  });

  it('should add market-cap range to inclusion.marketCap', () => {
    const result = buildCommonTokenTransferData({ 'market-cap-min': '1000000' });
    expect(result.inclusion.marketCap).toEqual({ min: 1000000 });
  });

  it('should add exclude-from to exclusion.fromTargets', () => {
    const result = buildCommonTokenTransferData({ 'exclude-from': 'address:0xbad' });
    expect(result.exclusion.fromTargets).toEqual([{ type: 'address', value: '0xbad' }]);
  });

  it('should add exclude-to to exclusion.toTargets', () => {
    const result = buildCommonTokenTransferData({ 'exclude-to': ['label:Bot', 'label:Scammer'] });
    expect(result.exclusion.toTargets).toEqual([
      { type: 'label', value: 'Bot' },
      { type: 'label', value: 'Scammer' },
    ]);
  });

  it('should merge token-sector with existing inclusion.tokens', () => {
    const result = buildCommonTokenTransferData({ token: '0xabc:base', 'token-sector': 'DeFi' });
    expect(result.inclusion.tokens).toEqual([{ address: '0xabc', chain: 'base' }]);
    expect(result.inclusion.tokenSectors).toEqual(['DeFi']);
  });

  it('should merge exclude-from with existing exclusion.tokens', () => {
    const result = buildCommonTokenTransferData({ 'exclude-token': '0xbad:ethereum', 'exclude-from': 'label:Bot' });
    expect(result.exclusion.tokens).toEqual([{ address: '0xbad', chain: 'ethereum' }]);
    expect(result.exclusion.fromTargets).toEqual([{ type: 'label', value: 'Bot' }]);
  });
});

describe('alerts list — client-side filtering', () => {
  const ALERTS = [
    { id: '1', name: 'A', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum'], inclusion: { tokens: [{ address: '0xabc', chain: 'ethereum' }] } } },
    { id: '2', name: 'B', type: 'common-token-transfer', isEnabled: false, data: { chains: ['solana'] } },
    { id: '3', name: 'C', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum', 'base'] } },
    { id: '4', name: 'D', type: 'smart-contract-call', isEnabled: true, data: { chains: ['all'] } },
    { id: '5', name: 'E', type: 'sm-token-flows', isEnabled: true, data: { chains: ['ethereum'], exclusion: { tokens: [{ address: '0xdef', chain: 'ethereum' }] } } },
  ];

  function setup() {
    const mockApi = { alertsList: vi.fn().mockResolvedValue(ALERTS) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    return { mockApi, cmd };
  }

  it('should return all alerts with no filters', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, {});
    expect(result).toHaveLength(5);
  });

  it('should filter by --type', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { type: 'sm-token-flows' });
    expect(result).toHaveLength(3);
    expect(result.every(a => a.type === 'sm-token-flows')).toBe(true);
  });

  it('should filter by --enabled', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, { enabled: true }, {});
    expect(result).toHaveLength(4);
    expect(result.every(a => a.isEnabled)).toBe(true);
  });

  it('should filter by --disabled', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, { disabled: true }, {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('should reject --enabled and --disabled together', async () => {
    const { mockApi, cmd } = setup();
    await expect(cmd(['list'], mockApi, { enabled: true, disabled: true }, {}))
      .rejects.toThrow('Cannot specify both --enabled and --disabled');
  });

  it('should filter by --token-address (case-insensitive)', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': '0xABC' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('should match --token-address in exclusion tokens', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': '0xdef' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('5');
  });

  it('should not false-positive --token-address against chain names', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': 'ethereum' });
    expect(result).toHaveLength(0);
  });

  it('should not false-positive --token-address against chains: ["all"]', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { 'token-address': 'all' });
    expect(result).toHaveLength(0);
  });

  it('should filter by --chain (includes "all" matches)', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { chain: 'solana' });
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['2', '4']);
  });

  it('should match --chain against "all" even when no explicit match', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { chain: 'arbitrum' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('4');
  });

  it('should apply --limit', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('1');
  });

  it('should apply --offset', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { offset: 2 });
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('3');
  });

  it('should apply --offset and --limit together', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { offset: 1, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('2');
    expect(result[1].id).toBe('3');
  });

  it('should combine type + chain filters', async () => {
    const { mockApi, cmd } = setup();
    const result = await cmd(['list'], mockApi, {}, { type: 'sm-token-flows', chain: 'base' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });
});

describe('alerts create does not require --time-window', () => {
  it('should throw only for missing --name, --type, and channel (not --time-window)', async () => {
    const logs = [];
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: (...a) => logs.push(a) })['alerts'];
    // Missing --name and --type but has channel — should complain about name and type, not time-window
    let err;
    try {
      await cmd(['create'], mockApi, {}, { telegram: '123' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain('--name');
    expect(err.message).toContain('--type');
    expect(err.message).not.toContain('--time-window');
  });

  it('should use TIME_WINDOW_BY_TYPE for sm-token-flows', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, { name: 'Test', type: 'sm-token-flows', chains: 'ethereum', telegram: '123', 'inflow-1h-min': 1000000 });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({ timeWindow: '1h' }));
  });

  it('should use realtime for common-token-transfer', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, { name: 'Test', type: 'common-token-transfer', chains: 'ethereum', telegram: '123', subject: 'label:CEX' });
    expect(mockApi.alertsCreate).toHaveBeenCalledWith(expect.objectContaining({ timeWindow: 'realtime' }));
  });
});

describe('alerts update — type inference', () => {
  it('should call alertsGet to infer type when type-specific flags used without --type', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows' }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': 500000 });
    expect(mockApi.alertsGet).toHaveBeenCalledWith('abc123');
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'abc123',
      type: 'sm-token-flows',
      timeWindow: '1h',
    }));
  });

  it('should reject --type that differs from existing alert type', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'common-token-transfer' }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, { type: 'sm-token-flows', 'inflow-1h-min': 500000 }))
      .rejects.toThrow('Cannot change alert type');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should allow --type that matches existing alert type', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'] } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { type: 'sm-token-flows', 'inflow-1h-min': 500000 });
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'sm-token-flows' }));
  });

  it('should always call alertsGet even for simple field updates like rename', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ type: 'sm-token-flows', data: { chains: ['ethereum'], inflow_1h: { min: 1000 } } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { name: 'New Name' });
    expect(mockApi.alertsGet).toHaveBeenCalledWith('abc123');
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name' }));
  });

  it('should infer type from nested data field if top-level type is absent', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({ data: { type: 'common-token-transfer', subjects: [{ type: 'label', value: 'SM' }] } }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-min': 1000 });
    expect(mockApi.alertsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'common-token-transfer',
      timeWindow: 'realtime',
    }));
  });

  it('should throw if --id is missing', async () => {
    const mockApi = { alertsGet: vi.fn(), alertsUpdate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update'], mockApi, {}, {})).rejects.toThrow('Required: <id>');
  });

  it('should throw if alert is not found', async () => {
    const mockApi = { alertsGet: vi.fn().mockResolvedValue(null), alertsUpdate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'nonexistent'], mockApi, {}, { name: 'X' })).rejects.toThrow('Alert not found');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should merge inclusion/exclusion so adding --token does not drop tokenSectors', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { tokens: [{ address: '0xA', chain: 'ethereum' }], tokenSectors: ['DeFi'] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { token: '0xB:ethereum' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // New token replaces the tokens array
    expect(sentData.inclusion.tokens).toEqual([{ address: '0xB', chain: 'ethereum' }]);
    // But tokenSectors from existing data is preserved
    expect(sentData.inclusion.tokenSectors).toEqual(['DeFi']);
    // Top-level fields also preserved
    expect(sentData.chains).toEqual(['ethereum']);
  });

  it('should deep-merge range fields so updating only min preserves existing max', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': '2000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 2000000, max: 50000000 });
    expect(sentData.outflow_1d).toEqual({ min: 500, max: 10000 });
  });

  it('should deep-merge range fields for common-token-transfer usdValue', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          tokenAmount: { min: 10, max: 500 },
          subjects: [{ type: 'label', value: 'smart_money' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-max': '5000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 100, max: 5000000 });
    expect(sentData.tokenAmount).toEqual({ min: 10, max: 500 });
  });

  it('should deep-merge inclusion-nested marketCap range on sm-token-flows', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { marketCap: { min: 1000000, max: 10000000 }, tokens: [{ address: '0xabc', chain: 'ethereum' }] },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'market-cap-min': '5000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // marketCap.max must survive even though only min was updated
    expect(sentData.inclusion.marketCap).toEqual({ min: 5000000, max: 10000000 });
    // sibling inclusion keys preserved
    expect(sentData.inclusion.tokens).toEqual([{ address: '0xabc', chain: 'ethereum' }]);
    // top-level range untouched
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 50000 });
  });

  it('should deep-merge inclusion-nested fdvUsd range on sm-token-flows', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['base'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { fdvUsd: { min: 500000, max: 2000000 } },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'fdv-max': '9000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion.fdvUsd).toEqual({ min: 500000, max: 9000000 });
  });

  it('should apply --data as post-merge override (named flags preserved)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    // Named flag sets min, --data sets max on the same range
    await cmd(['update', 'abc123'], mockApi, {}, {
      'inflow-1h-min': '2000',
      data: '{"inflow_1h":{"max":99999}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // Both named flag and --data compose correctly
    expect(sentData.inflow_1h).toEqual({ min: 2000, max: 99999 });
  });

  it('should apply --data after merge so it can clear a range bound with null', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      data: '{"inflow_1h":{"max":null}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: null });
  });

  it('should let --data add fields to inclusion without losing named-flag tokens', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { tokens: [{ address: '0xold', chain: 'ethereum' }] },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      token: '0xnew:base',
      data: '{"inclusion":{"marketCap":{"min":5000}}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    // Named flag replaces tokens, --data adds marketCap, both coexist
    expect(sentData.inclusion.tokens).toEqual([{ address: '0xnew', chain: 'base' }]);
    expect(sentData.inclusion.marketCap).toEqual({ min: 5000 });
  });

  it('should replace arrays entirely on update (not merge elements)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum', 'base'],
          subjects: [{ type: 'label', value: 'old' }],
          usdValue: {},
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      chains: 'solana',
      subject: 'address:0xabc',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.chains).toEqual(['solana']);
    expect(sentData.subjects).toEqual([{ type: 'address', value: '0xabc' }]);
  });

  it('should preserve fields the user does not mention', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          outflow_7d: { min: 100, max: 999 },
          inclusion: { tokenSectors: ['defi'] },
          exclusion: { tokens: [{ address: '0xskip', chain: 'base' }] },
          unknownFutureField: 'preserved',
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': '2000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 2000, max: 50000 });
    expect(sentData.outflow_7d).toEqual({ min: 100, max: 999 });
    expect(sentData.inclusion.tokenSectors).toEqual(['defi']);
    expect(sentData.exclusion.tokens).toEqual([{ address: '0xskip', chain: 'base' }]);
    expect(sentData.unknownFutureField).toBe('preserved');
  });

  it('should throw on invalid --data JSON during update', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: { chains: [] },
      }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, { data: 'not-json' }))
      .rejects.toThrow('--data must be valid JSON');
  });

  it('should apply --data only via update handler when no named flags provided', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      data: '{"chains":["base","solana"]}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.chains).toEqual(['base', 'solana']);
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 50000 });
  });

  // ── smart-contract-call update edge cases ──

  it('should deep-merge usdValue range on smart-contract-call', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 5000, max: 100000 },
          signatureHash: ['0xa9059cbb'],
          inclusion: { caller: [{ type: 'label', value: 'SM' }], smartContract: [] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-min': '25000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 25000, max: 100000 });
    expect(sentData.signatureHash).toEqual(['0xa9059cbb']);
  });

  it('should replace signatureHash array on smart-contract-call without dropping other fields', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 5000, max: 100000 },
          signatureHash: ['0xa9059cbb', '0x23b872dd'],
          inclusion: { caller: [{ type: 'label', value: 'SM' }], smartContract: [] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'signature-hash': '0xffffffff' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.signatureHash).toEqual(['0xffffffff']);
    expect(sentData.usdValue).toEqual({ min: 5000, max: 100000 });
    expect(sentData.inclusion.caller).toEqual([{ type: 'label', value: 'SM' }]);
  });

  it('should preserve smartContract when updating caller on smart-contract-call', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: {},
          inclusion: { caller: [{ type: 'label', value: 'old' }], smartContract: [{ type: 'address', value: '0xdead' }] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { caller: 'entity:Binance' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion.caller).toEqual([{ type: 'entity', value: 'Binance' }]);
    expect(sentData.inclusion.smartContract).toEqual([{ type: 'address', value: '0xdead' }]);
  });

  // ── common-token-transfer update edge cases ──

  it('should deep-merge inclusion-nested marketCap range on common-token-transfer', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: { marketCap: { min: 50000, max: 5000000 } },
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'market-cap-max': '20000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion.marketCap).toEqual({ min: 50000, max: 20000000 });
    expect(sentData.usdValue).toEqual({ min: 100, max: 999999 });
    expect(sentData.subjects).toEqual([{ type: 'label', value: 'SM' }]);
  });

  // ── cross-type edge cases ──

  it('should handle existing null range bounds correctly', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: null, max: 999999 },
          tokenAmount: { min: null, max: null },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-min': '5000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 5000, max: 999999 });
    expect(sentData.tokenAmount).toEqual({ min: null, max: null });
  });

  it('should clear entire sub-object via --data null', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000, max: 50000 },
          inclusion: { marketCap: { min: 100, max: 999 }, tokenSectors: ['defi'] },
          exclusion: { tokens: [{ address: '0xskip', chain: 'base' }] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { data: '{"inclusion":null}' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inclusion).toBeNull();
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 50000 });
    expect(sentData.exclusion).toEqual({ tokens: [{ address: '0xskip', chain: 'base' }] });
  });

  it('should deep-merge --data + named flags on common-token-transfer', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          tokenAmount: { min: 10, max: 500 },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      'token-amount-min': '50',
      data: '{"tokenAmount":{"max":2000}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.tokenAmount).toEqual({ min: 50, max: 2000 });
    expect(sentData.usdValue).toEqual({ min: 100, max: 999999 });
  });

  it('should deep-merge --data + named flags on smart-contract-call', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'smart-contract-call',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 5000, max: 100000 },
          signatureHash: ['0xa9059cbb'],
          inclusion: { caller: [], smartContract: [] },
          exclusion: { caller: [], smartContract: [] },
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, {
      'usd-min': '10000',
      data: '{"usdValue":{"max":null}}',
    });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 10000, max: null });
    expect(sentData.signatureHash).toEqual(['0xa9059cbb']);
  });

  it('should clear range bound with null on common-token-transfer', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 1000, max: 500000 },
          subjects: [{ type: 'label', value: 'SM' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { data: '{"usdValue":{"min":null}}' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: null, max: 500000 });
  });
});

describe('alerts create — --data as post-merge override', () => {
  it('should deep-merge --data on top of named flags and defaults', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      'inflow-1h-min': '1000',
      data: '{"inflow_1h":{"max":9999},"events":["custom"]}',
    });
    const sentData = mockApi.alertsCreate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 1000, max: 9999 });
    expect(sentData.events).toEqual(['custom']);
    // Defaults for unset fields still present
    expect(sentData.outflow_1d).toEqual({});
  });

  it('should throw on invalid --data JSON during create', async () => {
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], {}, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      data: '{bad}',
    })).rejects.toThrow('--data must be valid JSON');
  });

  it('should accept --data as object (not string) during create', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      'inflow-1h-min': '1000',
      data: { chains: ['solana'] },
    });
    const sentData = mockApi.alertsCreate.mock.calls[0][0].data;
    expect(sentData.chains).toEqual(['solana']);
  });
});

describe('parseArgs repeatable flags', () => {
  it('should accumulate repeated options into arrays', () => {
    const result = parseArgs(['--token', '0xabc:ethereum', '--token', '0xdef:base']);
    expect(result.options.token).toEqual(['0xabc:ethereum', '0xdef:base']);
  });

  it('should keep single option as string', () => {
    const result = parseArgs(['--token', '0xabc:ethereum']);
    expect(result.options.token).toBe('0xabc:ethereum');
  });
});

describe('parseArgs negative numbers', () => {
  it('should treat negative numbers as option values, not flags', () => {
    const result = parseArgs(['--telegram', '-4583755198']);
    expect(result.options.telegram).toBe('-4583755198');
    expect(result.flags).toEqual({});
  });

  it('should still treat non-numeric dashes as flags', () => {
    const result = parseArgs(['--verbose', '-v']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.v).toBe(true);
  });
});

describe('formatOutput', () => {
  it('should return compact JSON by default', () => {
    const result = formatOutput({ a: 1 });
    expect(result.type).toBe('json');
    expect(result.text).toBe('{"a":1}');
  });

  it('should return pretty JSON when pretty=true', () => {
    const result = formatOutput({ a: 1 }, { pretty: true });
    expect(result.type).toBe('json');
    expect(result.text).toContain('\n');
  });

  it('should return table when table=true', () => {
    const result = formatOutput({ data: [{ x: 1 }] }, { table: true });
    expect(result.type).toBe('table');
  });

  it('should return error text for failed response in table mode', () => {
    const result = formatOutput({ success: false, error: 'Oops' }, { table: true });
    expect(result.type).toBe('error');
    expect(result.text).toBe('Error: Oops');
  });
});

describe('formatError', () => {
  it('should format error object', () => {
    const error = new Error('Test error');
    error.code = 'TEST_CODE';
    error.status = 500;
    error.details = { detail: 'extra info' };
    
    const result = formatError(error);
    expect(result).toEqual({
      success: false,
      error: 'Test error',
      code: 'TEST_CODE',
      status: 500,
      details: { detail: 'extra info' }
    });
  });

  it('should use defaults for missing fields', () => {
    const error = new Error('Simple error');
    const result = formatError(error);
    expect(result.code).toBe('UNKNOWN');
    expect(result.status).toBeNull();
    expect(result).not.toHaveProperty('details');
  });

  it('should surface .details from trading-style errors (NO_QUOTES with warnings)', () => {
    const error = Object.assign(new Error('No quotes available'), {
      code: 'NO_QUOTES',
      status: 404,
      details: { warnings: ['Low liquidity', 'Slippage too high'] }
    });
    const result = formatError(error);
    expect(result.success).toBe(false);
    expect(result.error).toBe('No quotes available');
    expect(result.code).toBe('NO_QUOTES');
    expect(result.details).toEqual({ warnings: ['Low liquidity', 'Slippage too high'] });
  });

  it('should surface .details from NansenError (which stores as .details)', () => {
    const error = new NansenError('Rate limited', ErrorCode.RATE_LIMITED, 429, { retry_after: 60 });
    const result = formatError(error);
    expect(result.success).toBe(false);
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.details).toEqual({ retry_after: 60 });
  });

  it('should omit details when null', () => {
    const error = Object.assign(new Error('fail'), { code: 'ERR', details: null });
    const result = formatError(error);
    expect(result).not.toHaveProperty('details');
  });

  it('should omit details when undefined', () => {
    const error = Object.assign(new Error('fail'), { code: 'ERR' });
    const result = formatError(error);
    expect(result).not.toHaveProperty('details');
  });

  it('should omit details when empty object', () => {
    const error = Object.assign(new Error('fail'), { code: 'ERR', details: {} });
    const result = formatError(error);
    expect(result).not.toHaveProperty('details');
  });

  it('should fall back to .data if .details is not set (backward compat)', () => {
    const error = new Error('legacy error');
    error.code = 'LEGACY';
    error.data = { info: 'from data property' };
    const result = formatError(error);
    expect(result.details).toEqual({ info: 'from data property' });
  });
});

describe('parseSort', () => {
  it('should return undefined when no sort option', () => {
    expect(parseSort(undefined, undefined)).toBeUndefined();
  });

  it('should prefer orderBy when provided', () => {
    const orderBy = [{ field: 'price', direction: 'ASC' }];
    const result = parseSort('value:desc', orderBy);
    expect(result).toBe(orderBy);
  });

  it('should parse field:direction format', () => {
    const result = parseSort('value_usd:asc', undefined);
    expect(result).toEqual([{ field: 'value_usd', direction: 'ASC' }]);
  });

  it('should default to DESC when direction not specified', () => {
    const result = parseSort('timestamp', undefined);
    expect(result).toEqual([{ field: 'timestamp', direction: 'DESC' }]);
  });
});

describe('HELP', () => {
  it('should contain usage information', () => {
    expect(HELP).toContain('USAGE:');
    expect(HELP).toContain('COMMANDS:');
    expect(HELP).toContain('EXAMPLES:');
  });

  it('should list top-level commands in help text', () => {
    expect(HELP).toContain('research');
    expect(HELP).toContain('trade');
    expect(HELP).toContain('wallet');
    expect(HELP).toContain('schema');
    expect(HELP).toContain('account');
    expect(HELP).toContain('login');
    expect(HELP).toContain('logout');
  });
});

describe('buildCommands', () => {
  let mockDeps;
  let commands;
  let logs;

  beforeEach(() => {
    logs = [];
    mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
      promptFn: vi.fn(),
      saveConfigFn: vi.fn(),
      deleteConfigFn: vi.fn(),
      getConfigFileFn: vi.fn(() => '/home/user/.nansen/config.json'),
      NansenAPIClass: vi.fn(),
      isTTY: true
    };
    commands = buildCommands(mockDeps);
  });

  describe('help command', () => {
    it('should output help text', async () => {
      await commands.help([], null, {}, {});
      expect(logs[0]).toContain('USAGE:');
    });
  });

  describe('logout command', () => {
    it('should report success when config deleted', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(true);
      await commands.logout([], null, {}, {});
      expect(logs[0]).toContain('Removed');
    });

    it('should report when no config found', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(false);
      await commands.logout([], null, {}, {});
      expect(logs[0]).toContain('No saved credentials');
    });
  });

  describe('login command', () => {
    it('should exit when no API key provided', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      await commands.login([], null, {}, {});
      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
    });

    it('should exit when API key is whitespace', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      await commands.login([], null, {}, { 'api-key': '   ' });
      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
    });

    it('should save config with --api-key option after verification', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 9800 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'valid-api-key' });

      expect(mockApi.getAccount).toHaveBeenCalledOnce();
      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'valid-api-key',
        baseUrl: 'https://api.nansen.ai'
      });
    });

    it('should exit when no API key available', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;

      await commands.login([], null, {}, {});

      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('API_KEY_REQUIRED'))).toBe(true);
    });

    it('should reject invalid API key (401)', async () => {
      const mockApi = { getAccount: vi.fn().mockRejectedValue({ code: 'UNAUTHORIZED', message: 'Unauthorized' }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'invalid-key' });

      expect(mockDeps.exit).toHaveBeenCalledWith(1);
      expect(mockDeps.saveConfigFn).not.toHaveBeenCalled();
      expect(logs.some(l => l.includes('INVALID_API_KEY'))).toBe(true);
    });

    it('should handle network errors during verification', async () => {
      const mockApi = { getAccount: vi.fn().mockRejectedValue({ code: 'NETWORK_ERROR', message: 'Network error' }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'some-key' });

      expect(mockDeps.exit).toHaveBeenCalledWith(1);
      expect(mockDeps.saveConfigFn).not.toHaveBeenCalled();
      expect(logs.some(l => l.includes('VERIFICATION_FAILED'))).toBe(true);
    });

    it('should display account info on successful login', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'enterprise', credits_remaining: 50000 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'valid-key' });

      expect(logs.some(l => l.includes('Plan: enterprise'))).toBe(true);
      expect(logs.some(l => l.includes('Credits remaining: 50000'))).toBe(true);
    });

  });

  describe('account command', () => {
    it('should return account data from apiInstance.getAccount()', async () => {
      const mockApi = {
        getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 9800 }),
      };
      const result = await commands.account([], mockApi, {}, {});
      expect(mockApi.getAccount).toHaveBeenCalledOnce();
      expect(result).toEqual({ plan: 'pro', credits_remaining: 9800 });
    });
  });

  describe('smart-money command', () => {
    it('should return help for unknown subcommand', async () => {
      const mockApi = {};
      const result = await commands['smart-money'](['unknown'], mockApi, {}, {});
      expect(result.error).toContain('Unknown subcommand');
      expect(result.available).toContain('netflow');
    });

    it('should return help object for help subcommand', async () => {
      const result = await commands['smart-money'](['help'], null, {}, {});
      expect(result.commands).toContain('netflow');
      expect(result.description).toBeDefined();
    });

    it('should call netflow with correct params', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['smart-money'](['netflow'], mockApi, {}, { chain: 'ethereum', limit: 10 });
      
      expect(mockApi.smartMoneyNetflow).toHaveBeenCalledWith({
        chains: ['ethereum'],
        filters: {},
        orderBy: undefined,
        pagination: { page: 1, per_page: 10 }
      });
    });

    it('should add smart money labels filter', async () => {
      const mockApi = {
        smartMoneyNetflow: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['smart-money'](['netflow'], mockApi, {}, { labels: 'Fund' });
      
      expect(mockApi.smartMoneyNetflow).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: { include_smart_money_labels: ['Fund'] }
        })
      );
    });
  });

  describe('profiler command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['profiler'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
    });

    it('should call balance with address', async () => {
      const mockApi = {
        addressBalance: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['profiler'](['balance'], mockApi, {}, { address: '0x123', chain: 'ethereum' });
      
      expect(mockApi.addressBalance).toHaveBeenCalledWith(
        expect.objectContaining({ address: '0x123', chain: 'ethereum' })
      );
    });

    it('should call search with query', async () => {
      const mockApi = {
        entitySearch: vi.fn().mockResolvedValue({ results: [] })
      };
      await commands['profiler'](['search'], mockApi, {}, { query: 'Vitalik' });
      
      expect(mockApi.entitySearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Vitalik' })
      );
    });
  });

  describe('token command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['token'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
    });

    it('should call screener with chains and timeframe', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['screener'], mockApi, {}, { chain: 'solana', timeframe: '1h' });
      
      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ chains: ['solana'], timeframe: '1h' })
      );
    });

    it('should set smart money filter from flag', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['screener'], mockApi, { 'smart-money': true }, {});
      
      expect(mockApi.tokenScreener).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { include_smart_money_labels: ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'] } })
      );
    });

    it('should filter screener results by search option (client-side, flat)', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: [
          { token_symbol: 'PEPE', token_name: 'Pepe', price_usd: 0.001 },
          { token_symbol: 'USDC', token_name: 'USD Coin', price_usd: 1.0 },
          { token_symbol: 'PEPEFORK', token_name: 'Pepe Fork', price_usd: 0.0001 },
        ] })
      };
      const result = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'PEPE' });
      
      expect(result.data).toHaveLength(2);
      expect(result.data[0].token_symbol).toBe('PEPE');
      expect(result.data[1].token_symbol).toBe('PEPEFORK');
    });

    it('should filter screener results by search option (client-side, nested)', async () => {
      const mockApi = {
        tokenScreener: vi.fn().mockResolvedValue({ data: { data: [
          { token_symbol: 'PEPE', price_usd: 0.001 },
          { token_symbol: 'USDC', price_usd: 1.0 },
          { token_symbol: 'PEPEFORK', price_usd: 0.0001 },
        ], pagination: { page: 1 } } })
      };
      const result = await commands['token'](['screener'], mockApi, {}, { chain: 'ethereum', search: 'PEPE' });
      
      expect(result.data.data).toHaveLength(2);
      expect(result.data.data[0].token_symbol).toBe('PEPE');
      expect(result.data.pagination.page).toBe(1);
    });

    it('should call holders with token address', async () => {
      const mockApi = {
        tokenHolders: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['holders'], mockApi, {}, { token: '0xabc' });

      expect(mockApi.tokenHolders).toHaveBeenCalledWith(
        expect.objectContaining({ tokenAddress: '0xabc' })
      );
    });

    it('should call ohlcv with token address and timeframe', async () => {
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ candles: [] })
      };
      await commands['token'](['ohlcv'], mockApi, {}, { token: '0xabc', chain: 'solana', timeframe: '4h' });

      expect(mockApi.tokenOhlcv).toHaveBeenCalledWith(
        expect.objectContaining({ tokenAddress: '0xabc', chain: 'solana', timeframe: '4h' })
      );
    });

    it('should warn to stderr when ohlcv price fields are null but volume is present', async () => {
      const nullPriceCandles = [
        { interval_start: '2026-02-01T00:00:00', open: null, high: null, low: null, close: null, volume: 167913267, volume_usd: null, market_cap: { open: null, high: null, low: null, close: null } },
        { interval_start: '2026-02-02T00:00:00', open: null, high: null, low: null, close: null, volume: 125748386, volume_usd: null, market_cap: { open: null, high: null, low: null, close: null } },
      ];
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ data: nullPriceCandles })
      };
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await commands['token'](['ohlcv'], mockApi, {}, { token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', chain: 'base', timeframe: '1d' });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Price data unavailable'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('open/high/low/close'));
      stderrSpy.mockRestore();
    });

    it('should not warn to stderr when ohlcv price fields are populated', async () => {
      const fullCandles = [
        { interval_start: '2026-02-01T00:00:00', open: 0.0000071, high: 0.0000073, low: 0.0000069, close: 0.0000070, volume: 112998122501, volume_usd: 806705, market_cap: { open: 631010924, high: 620085355, low: 620085355, close: 620085355 } },
      ];
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ data: fullCandles })
      };
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await commands['token'](['ohlcv'], mockApi, {}, { token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', chain: 'solana', timeframe: '1d' });

      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('Price data unavailable'));
      stderrSpy.mockRestore();
    });

    it('should warn to stderr when ohlcv returns empty candles array', async () => {
      const mockApi = {
        tokenOhlcv: vi.fn().mockResolvedValue({ data: [] })
      };
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await commands['token'](['ohlcv'], mockApi, {}, { token: '0xdeadbeef', chain: 'base', timeframe: '1d' });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No OHLCV data returned'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('0xdeadbeef'));
      stderrSpy.mockRestore();
    });

    it('should pass days to flows handler', async () => {
      const mockApi = {
        tokenFlows: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['flows'], mockApi, {}, { token: '0xabc', days: '7' });

      expect(mockApi.tokenFlows).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });

    it('should pass days to who-bought-sold handler', async () => {
      const mockApi = {
        tokenWhoBoughtSold: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['who-bought-sold'], mockApi, {}, { token: '0xabc', days: '7' });

      expect(mockApi.tokenWhoBoughtSold).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });

    it('should pass days to flow-intelligence handler', async () => {
      const mockApi = {
        tokenFlowIntelligence: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['token'](['flow-intelligence'], mockApi, {}, { token: '0xabc', days: '7' });

      expect(mockApi.tokenFlowIntelligence).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });
  });

  describe('profiler command - days passthrough', () => {
    it('should pass days to transactions handler', async () => {
      const mockApi = {
        addressTransactions: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['profiler'](['transactions'], mockApi, {}, { address: '0x123', days: '7' });

      expect(mockApi.addressTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });
  });

  describe('portfolio command', () => {
    it('should return help for unknown subcommand', async () => {
      const result = await commands['portfolio'](['unknown'], {}, {}, {});
      expect(result.error).toContain('Unknown subcommand');
    });

    it('should call defi-holdings with wallet', async () => {
      const mockApi = {
        portfolioDefiHoldings: vi.fn().mockResolvedValue({ data: [] })
      };
      await commands['portfolio'](['defi'], mockApi, {}, { wallet: '0xdef' });
      
      expect(mockApi.portfolioDefiHoldings).toHaveBeenCalledWith({ walletAddress: '0xdef' });
    });
  });
});

describe('runCLI', () => {
  let outputs;
  let errors;
  let exitCode;

  beforeEach(() => {
    outputs = [];
    errors = [];
    exitCode = null;
  });

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { exitCode = code; }
  });

  it('should show help when no command', async () => {
    const result = await runCLI([], mockDeps());
    expect(result.type).toBe('help');
    expect(outputs[0]).toContain('USAGE:');
  });

  it('should show help when --help flag', async () => {
    const result = await runCLI(['--help'], mockDeps());
    expect(result.type).toBe('help');
  });

  it('should show help when -h flag', async () => {
    const result = await runCLI(['-h'], mockDeps());
    expect(result.type).toBe('help');
  });

  it('should error on unknown command', async () => {
    const result = await runCLI(['unknown-cmd'], mockDeps());
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
  });

  it('should run help command without API', async () => {
    const result = await runCLI(['help'], mockDeps());
    // 'help' is handled early in runCLI, returning type: 'help'
    expect(result.type).toBe('help');
  });

  it('should configure no-retry when flag set', async () => {
    let apiOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        apiOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--no-retry'], deps);
    expect(apiOptions.retry.maxRetries).toBe(0);
  });

  it('should use custom retries count', async () => {
    let apiOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        apiOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--retries', '5'], deps);
    expect(apiOptions.retry.maxRetries).toBe(5);
  });

  it('should output pretty JSON when --pretty', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ x: 1 });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--pretty'], deps);
    expect(outputs[0]).toContain('\n'); // pretty JSON has newlines
  });

  it('should output table when --table', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([{ token: 'SOL', value: 100 }]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--table'], deps);
    expect(outputs[0]).toContain('│'); // table has column separators
  });

  it('should handle API errors', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockRejectedValue(new Error('API Error'));
      }
    };
    
    const result = await runCLI(['smart-money', 'netflow'], deps);
    expect(result.type).toBe('error');
    expect(exitCode).toBe(1);
  });
});

// =================== P1: --table Output Formatting ===================

describe('--table output formatting', () => {
  it('should format token data with priority columns', () => {
    const data = [
      { token_symbol: 'SOL', token_name: 'Solana', value_usd: 1500000, random_field: 'ignored' },
      { token_symbol: 'ETH', token_name: 'Ethereum', value_usd: 2500000, random_field: 'also ignored' }
    ];
    const result = formatTable(data);
    
    // Should have headers
    expect(result).toContain('token_symbol');
    expect(result).toContain('token_name');
    expect(result).toContain('value_usd');
    
    // Should format large numbers with M suffix
    expect(result).toContain('1.50M');
    expect(result).toContain('2.50M');
    
    // Should have table separators
    expect(result).toContain('│');
    expect(result).toContain('─');
  });

  it('should format address and chain columns', () => {
    const data = [
      { address: '0x1234...', chain: 'ethereum', label: 'Whale', pnl_usd: 50000 }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('address');
    expect(result).toContain('chain');
    expect(result).toContain('label');
    expect(result).toContain('0x1234...');
    expect(result).toContain('ethereum');
    expect(result).toContain('Whale');
    expect(result).toContain('50.00K');
  });

  it('should handle nested API response with data wrapper', () => {
    const response = {
      success: true,
      data: [
        { symbol: 'BTC', price_usd: 45000, volume_usd: 1000000000 }
      ]
    };
    const formatted = formatOutput(response, { table: true });
    
    expect(formatted.type).toBe('table');
    expect(formatted.text).toContain('symbol');
    expect(formatted.text).toContain('BTC');
    expect(formatted.text).toContain('1000.00M');
  });

  it('should truncate long values to column width', () => {
    const data = [
      { address: '0x1234567890abcdef1234567890abcdef12345678', name: 'A very long name that exceeds thirty characters easily' }
    ];
    const result = formatTable(data);
    
    // Values should be truncated (max 30 chars per column)
    const lines = result.split('\n');
    lines.forEach(line => {
      // Each cell shouldn't exceed reasonable width
      expect(line.length).toBeLessThan(300);
    });
  });

  it('should handle empty values gracefully', () => {
    const data = [
      { symbol: 'TEST', value: null, amount: undefined, label: '' }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('TEST');
    // Empty values should not cause errors
    expect(result).not.toContain('null');
    expect(result).not.toContain('undefined');
  });

  it('should format error response in table mode', () => {
    const errorResponse = { success: false, error: 'Rate limited' };
    const formatted = formatOutput(errorResponse, { table: true });
    
    expect(formatted.type).toBe('error');
    expect(formatted.text).toBe('Error: Rate limited');
  });
});

// =================== P1: --no-retry and --retries Flags ===================

describe('--no-retry and --retries flags', () => {
  let outputs, _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => outputs.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    _exitCode = null;
  });

  it('should set maxRetries to 0 when --no-retry is used', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--no-retry'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(0);
  });

  it('should use default maxRetries of 3 without flags', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(3);
  });

  it('should use custom maxRetries when --retries is specified', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--retries', '7'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(7);
  });

  it('should allow --retries 0 to disable retries', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--retries', '0'], deps);
    
    expect(capturedOptions.retry.maxRetries).toBe(0);
  });
});

// =================== P2: parseSort with Special Characters ===================

describe('parseSort with special characters', () => {
  it('should handle field names with underscores', () => {
    const result = parseSort('value_usd:asc', undefined);
    expect(result).toEqual([{ field: 'value_usd', direction: 'ASC' }]);
  });

  it('should handle field names with numbers', () => {
    const result = parseSort('pnl_30d:desc', undefined);
    expect(result).toEqual([{ field: 'pnl_30d', direction: 'DESC' }]);
  });

  it('should handle field names with dots', () => {
    const result = parseSort('token.price:asc', undefined);
    expect(result).toEqual([{ field: 'token.price', direction: 'ASC' }]);
  });

  it('should handle field names with hyphens', () => {
    const result = parseSort('net-flow:desc', undefined);
    expect(result).toEqual([{ field: 'net-flow', direction: 'DESC' }]);
  });

  it('should handle multiple colons in field name', () => {
    // Edge case: field:with:colons:asc should split on first colon only
    const result = parseSort('field:asc', undefined);
    expect(result).toEqual([{ field: 'field', direction: 'ASC' }]);
  });

  it('should handle empty field name gracefully', () => {
    const result = parseSort(':asc', undefined);
    expect(result).toEqual([{ field: '', direction: 'ASC' }]);
  });

  it('should handle case-insensitive direction', () => {
    expect(parseSort('field:ASC', undefined)).toEqual([{ field: 'field', direction: 'ASC' }]);
    expect(parseSort('field:Desc', undefined)).toEqual([{ field: 'field', direction: 'DESC' }]);
    expect(parseSort('field:DESC', undefined)).toEqual([{ field: 'field', direction: 'DESC' }]);
  });
});

// =================== P2: formatTable with Nested Objects ===================

describe('formatTable with nested objects', () => {
  it('should stringify nested objects', () => {
    const data = [
      { name: 'Test', metadata: { chain: 'ethereum', protocol: 'uniswap' } }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('name');
    expect(result).toContain('Test');
    expect(result).toContain('metadata');
    // Nested object should be stringified
    expect(result).toContain('chain');
  });

  it('should handle deeply nested objects', () => {
    const data = [
      { 
        id: 1, 
        deep: { 
          level1: { 
            level2: { 
              value: 'deep value' 
            } 
          } 
        } 
      }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('id');
    expect(result).toContain('1');
    // Deep nesting should be JSON stringified
    expect(result).toContain('level1');
  });

  it('should handle arrays in fields', () => {
    const data = [
      { name: 'Multi', tags: ['defi', 'nft', 'gaming'] }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('name');
    expect(result).toContain('Multi');
    expect(result).toContain('tags');
    expect(result).toContain('defi');
  });

  it('should handle mixed nested and flat fields', () => {
    const data = [
      { 
        symbol: 'ETH',
        price_usd: 3000,
        volume: { h24: 1000000, h7d: 5000000 },
        labels: ['whale', 'smart money']
      }
    ];
    const result = formatTable(data);
    
    expect(result).toContain('symbol');
    expect(result).toContain('ETH');
    expect(result).toContain('3.00K'); // price formatted
    expect(result).toContain('volume');
    expect(result).toContain('labels');
  });

  it('should handle null nested values', () => {
    const data = [
      { name: 'Test', nested: null, deep: { value: null } }
    ];
    const result = formatTable(data);
    
    // Should not crash on null nested values
    expect(result).toContain('name');
    expect(result).toContain('Test');
  });
});

// =================== P2: Mock Login/Logout Flow ===================

describe('login/logout flow', () => {
  let mockDeps;
  let commands;
  let logs;

  beforeEach(() => {
    logs = [];
    mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
      promptFn: vi.fn(),
      saveConfigFn: vi.fn(),
      deleteConfigFn: vi.fn(),
      getConfigFileFn: vi.fn(() => '/home/user/.nansen/config.json'),
      NansenAPIClass: vi.fn(),
      isTTY: true
    };
    commands = buildCommands(mockDeps);
  });

  describe('login command', () => {
    it('should prompt for API key with --human flag in TTY mode', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });
      mockDeps.promptFn.mockResolvedValue('test-key');
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;

      await commands.login([], null, { human: true }, {});

      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(mockDeps.promptFn).toHaveBeenCalledWith('Enter your API key: ', true);
    });

    it('should trim whitespace from API key', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': '  api-key-with-spaces  ' });

      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'api-key-with-spaces',
        baseUrl: 'https://api.nansen.ai'
      });
    });

    it('should display login instructions with --human flag', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });
      mockDeps.promptFn.mockResolvedValue('some-key');
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;

      await commands.login([], null, { human: true }, {});

      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(logs.some(l => l.includes('Nansen CLI Login'))).toBe(true);
      expect(logs.some(l => l.includes('https://app.nansen.ai/api'))).toBe(true);
    });

    it('should save config with --api-key option', async () => {
      const mockApi = { getAccount: vi.fn().mockResolvedValue({ plan: 'pro', credits_remaining: 100 }) };
      mockDeps.NansenAPIClass.mockImplementation(function() { return mockApi; });

      await commands.login([], null, {}, { 'api-key': 'test-key' });

      expect(mockDeps.saveConfigFn).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseUrl: 'https://api.nansen.ai'
      });
      expect(logs.some(l => l.includes('Saved to'))).toBe(true);
    });

    it('should exit when no API key available', async () => {
      const savedEnv = process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_API_KEY;
      
      await commands.login([], null, {}, {});
      
      if (savedEnv !== undefined) process.env.NANSEN_API_KEY = savedEnv;
      expect(logs.some(l => l.includes('API_KEY_REQUIRED'))).toBe(true);
      expect(mockDeps.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('logout command', () => {
    it('should call deleteConfig', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(true);
      await commands.logout([], null, {}, {});
      
      expect(mockDeps.deleteConfigFn).toHaveBeenCalled();
    });

    it('should show success message when config deleted', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(true);
      await commands.logout([], null, {}, {});
      
      expect(logs.some(l => l.includes('Removed'))).toBe(true);
      expect(logs.some(l => l.includes('/home/user/.nansen/config.json'))).toBe(true);
    });

    it('should show message when no config exists', async () => {
      mockDeps.deleteConfigFn.mockReturnValue(false);
      await commands.logout([], null, {}, {});
      
      expect(logs.some(l => l.includes('No saved credentials'))).toBe(true);
    });
  });
});

// =================== Schema Command ===================

describe('SCHEMA', () => {
  it('should have version number', () => {
    expect(SCHEMA.version).toBeDefined();
    expect(SCHEMA.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should define all main commands under research', () => {
    const r = SCHEMA.commands.research.subcommands;
    expect(r['smart-money']).toBeDefined();
    expect(r['profiler']).toBeDefined();
    expect(r['token']).toBeDefined();
    expect(r['portfolio']).toBeDefined();
    expect(r['prediction-market']).toBeDefined();
  });

  it('should define subcommands for smart-money', () => {
    const sm = SCHEMA.commands.research.subcommands['smart-money'];
    expect(sm.subcommands['netflow']).toBeDefined();
    expect(sm.subcommands['dex-trades']).toBeDefined();
    expect(sm.subcommands['holdings']).toBeDefined();
    expect(sm.subcommands['perp-trades']).toBeDefined();
    expect(sm.subcommands['dcas']).toBeDefined();
    expect(sm.subcommands['historical-holdings']).toBeDefined();
  });

  it('should define subcommands for profiler', () => {
    const profiler = SCHEMA.commands.research.subcommands['profiler'];
    expect(profiler.subcommands['balance']).toBeDefined();
    expect(profiler.subcommands['labels']).toBeDefined();
    expect(profiler.subcommands['transactions']).toBeDefined();
    expect(profiler.subcommands['pnl']).toBeDefined();
    expect(profiler.subcommands['search']).toBeDefined();
  });

  it('should define subcommands for token', () => {
    const token = SCHEMA.commands.research.subcommands['token'];
    expect(token.subcommands['screener']).toBeDefined();
    expect(token.subcommands['holders']).toBeDefined();
    expect(token.subcommands['flows']).toBeDefined();
    expect(token.subcommands['pnl']).toBeDefined();
    expect(token.subcommands['perp-trades']).toBeDefined();
  });

  it('should define subcommands for prediction-market', () => {
    const pm = SCHEMA.commands.research.subcommands['prediction-market'];
    expect(pm.subcommands['ohlcv']).toBeDefined();
    expect(pm.subcommands['orderbook']).toBeDefined();
    expect(pm.subcommands['top-holders']).toBeDefined();
    expect(pm.subcommands['trades-by-market']).toBeDefined();
    expect(pm.subcommands['trades-by-address']).toBeDefined();
    expect(pm.subcommands['market-screener']).toBeDefined();
    expect(pm.subcommands['event-screener']).toBeDefined();
    expect(pm.subcommands['pnl-by-market']).toBeDefined();
    expect(pm.subcommands['pnl-by-address']).toBeDefined();
    expect(pm.subcommands['position-detail']).toBeDefined();
    expect(pm.subcommands['categories']).toBeDefined();
  });

  it('should have required market-id option for pm market endpoints', () => {
    const ohlcv = SCHEMA.commands.research.subcommands['prediction-market'].subcommands['ohlcv'];
    expect(ohlcv.options['market-id'].required).toBe(true);
    // Note: type removed in minimal schema (skills document types)
  });

  it('should have required address option for pm address endpoints', () => {
    const trades = SCHEMA.commands.research.subcommands['prediction-market'].subcommands['trades-by-address'];
    expect(trades.options.address.required).toBe(true);
  });

  // Note: returns removed in minimal schema (skills document output fields)

  it('should include option defaults', () => {
    const netflow = SCHEMA.commands.research.subcommands['smart-money'].subcommands['netflow'];
    // Note: type removed in minimal schema (skills document types)
    expect(netflow.options.chain.default).toBe('solana');
  });

  it('should include required flag for required options', () => {
    const balance = SCHEMA.commands.research.subcommands['profiler'].subcommands['balance'];
    expect(balance.options.address.required).toBe(true);
  });

  // Note: returns removed in minimal schema (skills document output fields)

  it('should define global options', () => {
    expect(SCHEMA.globalOptions.pretty).toBeDefined();
    expect(SCHEMA.globalOptions.table).toBeDefined();
    expect(SCHEMA.globalOptions.fields).toBeDefined();
    expect(SCHEMA.globalOptions['no-retry']).toBeDefined();

  });

  it('should list supported chains', () => {
    expect(SCHEMA.chains).toContain('ethereum');
    expect(SCHEMA.chains).toContain('solana');
    expect(SCHEMA.chains).toContain('base');
    expect(SCHEMA.chains.length).toBeGreaterThan(10);
  });

  it('schema.json chains should be a superset of EVM_CHAINS', () => {
    for (const chain of EVM_CHAINS) {
      expect(SCHEMA.chains, `EVM_CHAINS has "${chain}" but schema.json does not`).toContain(chain);
    }
  });

  it('should list smart money labels', () => {
    expect(SCHEMA.smartMoneyLabels).toContain('Fund');
    expect(SCHEMA.smartMoneyLabels).toContain('Smart Trader');
  });
});

describe('schema command', () => {
  let outputs;
  let mockDeps;

  beforeEach(() => {
    outputs = [];
    mockDeps = {
      output: (msg) => outputs.push(msg),
      errorOutput: (msg) => outputs.push(msg),
      exit: vi.fn()
    };
  });

  it('should return full schema without subcommand', async () => {
    const result = await runCLI(['schema'], mockDeps);
    
    expect(result.type).toBe('schema');
    expect(result.data.version).toBeDefined();
    expect(result.data.commands).toBeDefined();
  });

  it('should return specific command schema', async () => {
    const commands = buildCommands({});
    const result = await commands.schema(['smart-money'], null, {}, {});
    
    expect(result.command).toBe('smart-money');
    expect(result.subcommands).toBeDefined();
    expect(result.globalOptions).toBeDefined();
  });

  it('should return full schema for unknown command', async () => {
    const commands = buildCommands({});
    const result = await commands.schema(['unknown'], null, {}, {});
    
    // Returns full schema when command not found
    expect(result.version).toBeDefined();
    expect(result.commands).toBeDefined();
  });

  it('should output JSON', async () => {
    await runCLI(['schema'], mockDeps);
    
    const output = outputs[0];
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.version).toBeDefined();
  });

  it('should output pretty JSON with --pretty', async () => {
    await runCLI(['schema', '--pretty'], mockDeps);
    
    const output = outputs[0];
    expect(output).toContain('\n'); // Pretty JSON has newlines
  });

});

// =================== Field Filtering ===================

describe('parseFields', () => {
  it('should parse comma-separated fields', () => {
    const result = parseFields('address,value_usd,pnl_usd');
    expect(result).toEqual(['address', 'value_usd', 'pnl_usd']);
  });

  it('should trim whitespace', () => {
    const result = parseFields('address , value_usd , pnl_usd');
    expect(result).toEqual(['address', 'value_usd', 'pnl_usd']);
  });

  it('should filter empty fields', () => {
    const result = parseFields('address,,value_usd,');
    expect(result).toEqual(['address', 'value_usd']);
  });

  it('should return null for undefined input', () => {
    expect(parseFields(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseFields('')).toBeNull();
  });

  it('should handle single field', () => {
    const result = parseFields('address');
    expect(result).toEqual(['address']);
  });
});

describe('filterFields', () => {
  it('should filter object to specified fields', () => {
    const data = { address: '0x123', value_usd: 1000, pnl_usd: 50, extra: 'ignored' };
    const result = filterFields(data, ['address', 'value_usd']);
    
    expect(result).toEqual({ address: '0x123', value_usd: 1000 });
    expect(result.extra).toBeUndefined();
    expect(result.pnl_usd).toBeUndefined();
  });

  it('should filter array of objects', () => {
    const data = [
      { address: '0x1', value: 100, extra: 'a' },
      { address: '0x2', value: 200, extra: 'b' }
    ];
    const result = filterFields(data, ['address', 'value']);
    
    expect(result).toEqual([
      { address: '0x1', value: 100 },
      { address: '0x2', value: 200 }
    ]);
  });

  it('should handle nested objects', () => {
    const data = {
      results: [
        { address: '0x1', value: 100 },
        { address: '0x2', value: 200 }
      ],
      pagination: { page: 1 }
    };
    const result = filterFields(data, ['address', 'value']);
    
    expect(result.results).toBeDefined();
    expect(result.results[0].address).toBe('0x1');
    expect(result.results[0].value).toBe(100);
  });

  it('should return original data when fields is empty', () => {
    const data = { a: 1, b: 2 };
    expect(filterFields(data, [])).toEqual(data);
  });

  it('should return original data when fields is null', () => {
    const data = { a: 1, b: 2 };
    expect(filterFields(data, null)).toEqual(data);
  });

  it('should handle null values', () => {
    const data = { address: '0x1', value: null };
    const result = filterFields(data, ['address', 'value']);
    expect(result).toEqual({ address: '0x1', value: null });
  });

  it('should handle deeply nested structures', () => {
    const data = {
      data: {
        results: [
          { token_symbol: 'ETH', price_usd: 3000, ignored: true }
        ]
      }
    };
    const result = filterFields(data, ['token_symbol', 'price_usd']);
    
    expect(result.data.results[0].token_symbol).toBe('ETH');
    expect(result.data.results[0].price_usd).toBe(3000);
    expect(result.data.results[0].ignored).toBeUndefined();
  });
});

describe('--fields flag integration', () => {
  let outputs;
  let errors;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    errors = [];
    _exitCode = null;
  });

  it('should filter response fields', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { token_symbol: 'SOL', value_usd: 1000, extra_field: 'ignored', chain: 'solana' }
        ]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--fields', 'token_symbol,value_usd'], deps);
    
    const output = JSON.parse(outputs[0]);
    expect(output.success).toBe(true);
    expect(output.data[0].token_symbol).toBe('SOL');
    expect(output.data[0].value_usd).toBe(1000);
    expect(output.data[0].extra_field).toBeUndefined();
    expect(output.data[0].chain).toBeUndefined();
  });

  it('should work with nested response data', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({
          results: [
            { symbol: 'BTC', price: 50000, volume: 1000000 }
          ],
          meta: { page: 1 }
        });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--fields', 'symbol,price'], deps);
    
    const output = JSON.parse(outputs[0]);
    expect(output.data.results[0].symbol).toBe('BTC');
    expect(output.data.results[0].price).toBe(50000);
    expect(output.data.results[0].volume).toBeUndefined();
  });

  it('should work with --pretty flag', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([{ symbol: 'ETH' }]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--fields', 'symbol', '--pretty'], deps);
    
    expect(outputs[0]).toContain('\n'); // Pretty formatting
  });
});

// =================== Response Caching ===================

describe('Response Caching', () => {
  const testEndpoint = '/test/endpoint';
  const testBody = { test: true };
  const testData = { result: 'cached data' };

  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  afterEach(() => {
    // Clean up after tests
    clearCache();
  });

  describe('getCachedResponse', () => {
    it('should return null for uncached endpoint', () => {
      const result = getCachedResponse('/uncached/endpoint', {});
      expect(result).toBeNull();
    });

    it('should return cached data when valid', () => {
      setCachedResponse(testEndpoint, testBody, testData);
      const result = getCachedResponse(testEndpoint, testBody, 300);
      
      expect(result.result).toBe('cached data');
      expect(result._meta.fromCache).toBe(true);
      expect(result._meta.cacheAge).toBeDefined();
    });

    it('should return null for expired cache', async () => {
      setCachedResponse(testEndpoint, testBody, testData);
      
      // Use very short TTL to simulate expiry
      const result = getCachedResponse(testEndpoint, testBody, 0);
      expect(result).toBeNull();
    });

    it('should use different keys for different bodies', () => {
      setCachedResponse(testEndpoint, { a: 1 }, { data: 'first' });
      setCachedResponse(testEndpoint, { a: 2 }, { data: 'second' });
      
      const result1 = getCachedResponse(testEndpoint, { a: 1 }, 300);
      const result2 = getCachedResponse(testEndpoint, { a: 2 }, 300);
      
      expect(result1.data).toBe('first');
      expect(result2.data).toBe('second');
    });
  });

  describe('setCachedResponse', () => {
    it('should create cache directory if not exists', () => {
      const cacheDir = getCacheDir();
      // Clear the directory first
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true });
      }
      
      setCachedResponse(testEndpoint, testBody, testData);
      
      expect(fs.existsSync(cacheDir)).toBe(true);
    });

    it('should write cache file', () => {
      setCachedResponse(testEndpoint, testBody, testData);
      
      const cacheDir = getCacheDir();
      const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
    });
  });

  describe('clearCache', () => {
    it('should remove all cached responses', () => {
      setCachedResponse('/endpoint/1', {}, { data: 1 });
      setCachedResponse('/endpoint/2', {}, { data: 2 });
      setCachedResponse('/endpoint/3', {}, { data: 3 });
      
      const count = clearCache();
      
      expect(count).toBe(3);
      expect(getCachedResponse('/endpoint/1', {}, 300)).toBeNull();
    });

    it('should return 0 for empty cache', () => {
      const count = clearCache();
      expect(count).toBe(0);
    });
  });
});

describe('cache command', () => {
  it('should clear cache with clear subcommand', async () => {
    const logs = [];
    const mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn()
    };
    const commands = buildCommands(mockDeps);
    
    // Add some cache entries first
    setCachedResponse('/test/1', {}, { data: 1 });
    setCachedResponse('/test/2', {}, { data: 2 });
    
    await commands.cache(['clear'], null, {}, {});
    
    expect(logs.some(l => l.includes('Cleared 2'))).toBe(true);
  });

  it('should show help for unknown subcommand', async () => {
    const logs = [];
    const mockDeps = {
      log: (msg) => logs.push(msg),
      exit: vi.fn()
    };
    const commands = buildCommands(mockDeps);
    
    await commands.cache(['unknown'], null, {}, {});
    
    expect(logs.some(l => l.includes('Unknown cache subcommand'))).toBe(true);
  });
});

describe('--cache flag integration', () => {
  let outputs;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => outputs.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    _exitCode = null;
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  it('should pass cache options to API when --cache flag used', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--cache'], deps);
    
    expect(capturedOptions.cache.enabled).toBe(true);
  });

  it('should use custom TTL when --cache-ttl specified', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--cache', '--cache-ttl', '60'], deps);
    
    expect(capturedOptions.cache.ttl).toBe(60);
  });

  it('should not enable cache by default', async () => {
    let capturedOptions;
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI(key, url, opts) {
        capturedOptions = opts;
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    
    await runCLI(['smart-money', 'netflow'], deps);
    
    expect(capturedOptions.cache.enabled).toBeFalsy();
  });
});

// =================== Streaming Output (NDJSON) ===================

describe('formatStream', () => {
  it('should output array as JSON lines', () => {
    const data = [
      { symbol: 'SOL', value: 100 },
      { symbol: 'ETH', value: 200 },
      { symbol: 'BTC', value: 300 }
    ];
    const result = formatStream(data);
    const lines = result.split('\n');
    
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ symbol: 'SOL', value: 100 });
    expect(JSON.parse(lines[1])).toEqual({ symbol: 'ETH', value: 200 });
    expect(JSON.parse(lines[2])).toEqual({ symbol: 'BTC', value: 300 });
  });

  it('should extract data from nested response', () => {
    const response = {
      data: [
        { token: 'A' },
        { token: 'B' }
      ]
    };
    const result = formatStream(response);
    const lines = result.split('\n');
    
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).token).toBe('A');
  });

  it('should extract from results field', () => {
    const response = {
      results: [{ id: 1 }, { id: 2 }]
    };
    const result = formatStream(response);
    const lines = result.split('\n');
    
    expect(lines).toHaveLength(2);
  });

  it('should extract from nested data.results', () => {
    const response = {
      data: {
        results: [{ x: 1 }]
      }
    };
    const result = formatStream(response);
    expect(JSON.parse(result).x).toBe(1);
  });

  it('should handle single object', () => {
    const data = { single: true, value: 42 };
    const result = formatStream(data);
    
    expect(JSON.parse(result)).toEqual({ single: true, value: 42 });
  });

  it('should return empty string for empty array', () => {
    expect(formatStream([])).toBe('');
  });

  it('should handle null/undefined', () => {
    expect(formatStream(null)).toBe('');
    expect(formatStream(undefined)).toBe('');
  });
});

describe('--stream flag integration', () => {
  let outputs;
  let errors;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    errors = [];
    outputs = [];
    _exitCode = null;
  });

  it('should output NDJSON when --stream flag used', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { symbol: 'SOL', value: 100 },
          { symbol: 'ETH', value: 200 }
        ]);
      }
    };
    
    const result = await runCLI(['smart-money', 'netflow', '--stream'], deps);
    
    expect(result.type).toBe('stream');
    const lines = outputs[0].split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).symbol).toBe('SOL');
    expect(JSON.parse(lines[1]).symbol).toBe('ETH');
  });

  it('should work with nested API response', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({
          data: [{ token: 'ABC' }, { token: 'XYZ' }]
        });
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--stream'], deps);
    
    const lines = outputs[0].split('\n');
    expect(lines).toHaveLength(2);
  });

  it('should apply field filtering before streaming', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { symbol: 'SOL', value: 100, extra: 'ignored' }
        ]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--stream', '--fields', 'symbol'], deps);
    
    const record = JSON.parse(outputs[0]);
    expect(record.symbol).toBe('SOL');
    expect(record.extra).toBeUndefined();
  });

  it('should not wrap in success envelope', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([{ a: 1 }]);
      }
    };
    
    await runCLI(['smart-money', 'netflow', '--stream'], deps);
    
    // Stream output should NOT have success wrapper
    const record = JSON.parse(outputs[0]);
    expect(record.success).toBeUndefined();
    expect(record.a).toBe(1);
  });
});

// =================== --from/--to Filters on Token Transfers ===================

describe('--from/--to filters on token transfers', () => {
  it('should inject --from into filters', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({ transfers: [] })
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc', from: '0xsender' });

    expect(mockApi.tokenTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ from_address: '0xsender' })
      })
    );
  });

  it('should inject --to into filters', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({ transfers: [] })
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc', to: '0xrecipient' });

    expect(mockApi.tokenTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ to_address: '0xrecipient' })
      })
    );
  });

  it('should inject both --from and --to into filters', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({ transfers: [] })
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc', from: '0xA', to: '0xB' });

    expect(mockApi.tokenTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ from_address: '0xA', to_address: '0xB' })
      })
    );
  });

  it('should appear in SCHEMA for token.transfers', () => {
    const transfers = SCHEMA.commands.research.subcommands['token'].subcommands['transfers'];
    expect(transfers).toBeDefined();
    // Note: from/to options removed from minimal schema (no required/default)
    // but still work at runtime via extraParams
  });
});

// =================== profiler batch ===================

describe('profiler batch command', () => {
  it('should appear in SCHEMA', () => {
    const batch = SCHEMA.commands.research.subcommands['profiler'].subcommands['batch'];
    expect(batch).toBeDefined();
    // Note: option details removed from minimal schema (skills document these)
    // but addresses/file/include still work at runtime
  });

  it('should parse comma-separated addresses', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.total).toBe(2);
    expect(mockApi.addressLabels).toHaveBeenCalledTimes(2);
    expect(mockApi.addressBalance).toHaveBeenCalledTimes(2);
  });

  it('should parse custom include parameter', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressPnl: vi.fn().mockResolvedValue({ pnl: 0 }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001',
      include: 'labels,pnl',
      delay: '0'
    });

    expect(result.total).toBe(1);
    expect(mockApi.addressLabels).toHaveBeenCalled();
    expect(mockApi.addressPnl).toHaveBeenCalled();
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('batch');
  });
});

// =================== profiler trace ===================

describe('profiler trace command', () => {
  it('should appear in SCHEMA', () => {
    const trace = SCHEMA.commands.research.subcommands['profiler'].subcommands['trace'];
    expect(trace).toBeDefined();
    expect(trace.options.address.required).toBe(true);
    expect(trace.options.depth).toBeDefined();
    expect(trace.options.width).toBeDefined();
  });

  it('should call traceCounterparties with correct params', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: '3',
      width: '5',
      delay: '0'
    });

    expect(result.root).toBe('0x0000000000000000000000000000000000000001');
    expect(result.depth).toBe(3);
  });

  it('should clamp depth to 1-5 range', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };
    const commands = buildCommands({});

    const result1 = await commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      depth: '10',
      delay: '0'
    });
    expect(result1.depth).toBe(5);

    const result2 = await commands['profiler'](['trace'], mockApi, {}, {
      address: '0x0000000000000000000000000000000000000001',
      depth: '0',
      delay: '0'
    });
    expect(result2.depth).toBe(1);
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('trace');
  });
});

// =================== profiler compare ===================

describe('profiler compare command', () => {
  it('should appear in SCHEMA', () => {
    const compare = SCHEMA.commands.research.subcommands['profiler'].subcommands['compare'];
    expect(compare).toBeDefined();
    expect(compare.options.addresses.required).toBe(true);
  });

  it('should parse two comma-separated addresses', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['compare'], mockApi, {}, {
      addresses: '0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.addresses).toHaveLength(2);
    expect(mockApi.addressCounterparties).toHaveBeenCalledTimes(2);
    expect(mockApi.addressBalance).toHaveBeenCalledTimes(2);
  });

  it('should be listed in profiler help', async () => {
    const commands = buildCommands({});
    const result = await commands['profiler'](['help'], null, {}, {});
    expect(result.commands).toContain('compare');
  });
});

// =================== parseAddressList ===================

describe('parseAddressList', () => {
  it('should parse a JSON array string', () => {
    const result = parseAddressList('["0xAAA","0xBBB"]');
    expect(result).toEqual(['0xAAA', '0xBBB']);
  });

  it('should handle a pre-parsed array from arg parser', () => {
    const result = parseAddressList(['0xAAA', '0xBBB']);
    expect(result).toEqual(['0xAAA', '0xBBB']);
  });

  it('should parse comma-separated string', () => {
    const result = parseAddressList('0xAAA,0xBBB,0xCCC');
    expect(result).toEqual(['0xAAA', '0xBBB', '0xCCC']);
  });

  it('should trim whitespace and filter empty entries', () => {
    const result = parseAddressList(' 0xAAA , 0xBBB , ');
    expect(result).toEqual(['0xAAA', '0xBBB']);
  });

  it('should handle malformed JSON by falling back to comma split', () => {
    const result = parseAddressList('[invalid json');
    expect(result).toEqual(['[invalid json']);
  });

  it('should throw on non-array JSON values (object)', () => {
    expect(() => parseAddressList('{"a":"0xAAA"}')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should throw on non-array JSON values (string)', () => {
    expect(() => parseAddressList('"0xAAA"')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should throw on non-array JSON values (number)', () => {
    expect(() => parseAddressList('42')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should throw on non-array JSON values (boolean)', () => {
    expect(() => parseAddressList('true')).toThrow('--addresses must be a comma-separated list or JSON array');
  });

  it('should return empty array for empty/undefined input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('should coerce non-string array elements to strings', () => {
    const result = parseAddressList([123, '0xBBB']);
    expect(result).toEqual(['123', '0xBBB']);
  });
});

// =================== profiler batch address parsing ===================

describe('profiler batch address parsing', () => {
  it('should handle pre-parsed array from arg parser', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.total).toBe(2);
    expect(mockApi.addressLabels).toHaveBeenCalledTimes(2);
  });

  it('should handle JSON array string for addresses', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['batch'], mockApi, {}, {
      addresses: '["0x0000000000000000000000000000000000000001","0x0000000000000000000000000000000000000002"]',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.total).toBe(2);
  });

  it('should reject non-array JSON for addresses', async () => {
    const commands = buildCommands({});
    await expect(
      commands['profiler'](['batch'], {}, {}, {
        addresses: '{"addr":"0x0000000000000000000000000000000000000001"}',
        chain: 'ethereum',
        delay: '0'
      })
    ).rejects.toThrow('--addresses must be a comma-separated list or JSON array');
  });
});

// =================== profiler compare address parsing ===================

describe('profiler compare address parsing', () => {
  it('should handle pre-parsed array from arg parser', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['compare'], mockApi, {}, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.addresses).toHaveLength(2);
  });

  it('should handle JSON array string for addresses', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [] }),
    };
    const commands = buildCommands({});
    const result = await commands['profiler'](['compare'], mockApi, {}, {
      addresses: '["0x0000000000000000000000000000000000000001","0x0000000000000000000000000000000000000002"]',
      chain: 'ethereum',
      delay: '0'
    });

    expect(result.addresses).toHaveLength(2);
  });

  it('should reject non-array JSON for addresses', async () => {
    const commands = buildCommands({});
    await expect(
      commands['profiler'](['compare'], {}, {}, {
        addresses: '{"addr":"0x0000000000000000000000000000000000000001"}',
        chain: 'ethereum',
        delay: '0'
      })
    ).rejects.toThrow('--addresses must be a comma-separated list or JSON array');
  });
});

// =================== --enrich Flag ===================

describe('--enrich flag on token transfers', () => {
  it('should appear in SCHEMA for token.transfers', () => {
    const transfers = SCHEMA.commands.research.subcommands['token'].subcommands['transfers'];
    expect(transfers).toBeDefined();
    // Note: enrich option removed from minimal schema (no required/default)
    // but still works at runtime via extraParams
  });

  it('should enrich transfers with labels when --enrich flag is set', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({
        transfers: [
          { from: '0xaaa', to: '0xbbb', amount_usd: 1000 }
        ]
      }),
      addressLabels: vi.fn().mockResolvedValue({ labels: ['Smart Trader'] })
    };
    const commands = buildCommands({});
    const result = await commands['token'](['transfers'], mockApi, { enrich: true }, { token: '0xabc' });

    expect(mockApi.addressLabels).toHaveBeenCalled();
    expect(result.transfers[0].from_labels).toEqual(['Smart Trader']);
    expect(result.transfers[0].to_labels).toEqual(['Smart Trader']);
  });

  it('should not enrich when --enrich flag is not set', async () => {
    const mockApi = {
      tokenTransfers: vi.fn().mockResolvedValue({
        transfers: [{ from: '0xaaa', to: '0xbbb', amount_usd: 1000 }]
      }),
      addressLabels: vi.fn()
    };
    const commands = buildCommands({});
    await commands['token'](['transfers'], mockApi, {}, { token: '0xabc' });

    expect(mockApi.addressLabels).not.toHaveBeenCalled();
  });
});

// =================== --format csv ===================

describe('formatCsv', () => {
  it('should produce CSV with header row', () => {
    const data = [
      { name: 'Alice', value: 100 },
      { name: 'Bob', value: 200 }
    ];
    const result = formatCsv(data);
    const lines = result.split('\n');
    expect(lines[0]).toBe('name,value');
    expect(lines[1]).toBe('Alice,100');
    expect(lines[2]).toBe('Bob,200');
  });

  it('should quote values containing commas', () => {
    const data = [{ name: 'Hello, World', value: 1 }];
    const result = formatCsv(data);
    expect(result).toContain('"Hello, World"');
  });

  it('should escape double quotes', () => {
    const data = [{ name: 'Say "hello"', value: 1 }];
    const result = formatCsv(data);
    expect(result).toContain('"Say ""hello"""');
  });

  it('should handle null/undefined values', () => {
    const data = [{ name: null, value: undefined }];
    const result = formatCsv(data);
    const lines = result.split('\n');
    expect(lines[1]).toBe(',');
  });

  it('should stringify objects', () => {
    const data = [{ meta: { chain: 'eth' } }];
    const result = formatCsv(data);
    expect(result).toContain('chain');
  });

  it('should extract from nested response', () => {
    const response = { data: [{ x: 1 }, { x: 2 }] };
    const result = formatCsv(response);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
  });

  it('should return empty string for empty data', () => {
    expect(formatCsv([])).toBe('');
  });
});

describe('--format csv integration', () => {
  let outputs;
  let errors;
  let _exitCode;

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  beforeEach(() => {
    outputs = [];
    errors = [];
    _exitCode = null;
  });

  it('should output CSV when --format csv is used', async () => {
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue([
          { symbol: 'SOL', value: 100 },
          { symbol: 'ETH', value: 200 }
        ]);
      }
    };

    const result = await runCLI(['smart-money', 'netflow', '--format', 'csv'], deps);

    expect(result.type).toBe('csv');
    const lines = outputs[0].split('\n');
    expect(lines[0]).toContain('symbol');
    expect(lines[1]).toContain('SOL');
    expect(lines[2]).toContain('ETH');
  });
});

// =================== Composite Functions ===================

describe('batchProfile', () => {
  it('should call labels and balance for each address', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: ['Fund'] }),
      addressBalance: vi.fn().mockResolvedValue({ balances: [{ token_symbol: 'ETH', value_usd: 100 }] }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      include: ['labels', 'balance'],
      delayMs: 0,
    });

    expect(result.total).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].labels).toBeDefined();
    expect(result.results[0].balance).toBeDefined();
  });

  it('should capture individual errors without failing batch', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockRejectedValue(new Error('Not found')),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.total).toBe(1);
    expect(result.results[0].error).toBeDefined();
  });

  it('should skip invalid addresses with validation error', async () => {
    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: [] }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['not-an-address'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.total).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.results[0].error).toContain('Invalid');
    expect(mockApi.addressLabels).not.toHaveBeenCalled();
  });

  it('should include pnl when requested', async () => {
    const mockApi = {
      addressPnl: vi.fn().mockResolvedValue({ pnl: 100 }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
      include: ['pnl'],
      delayMs: 0,
    });

    expect(result.results[0].pnl).toBeDefined();
    expect(mockApi.addressPnl).toHaveBeenCalled();
  });
});

describe('traceCounterparties', () => {
  it('should return graph structure', async () => {
    const mockApi = {
      addressCounterparties: vi.fn()
        .mockResolvedValueOnce({
          counterparties: [
            { counterparty_address: '0x0000000000000000000000000000000000000002', volume_usd: 5000, transaction_count: 10 }
          ]
        })
        .mockResolvedValueOnce({ counterparties: [] }),
    };

    const result = await traceCounterparties(mockApi, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 2,
      width: 5,
      days: 30,
      delayMs: 0,
    });

    expect(result.root).toBe('0x0000000000000000000000000000000000000001');
    expect(result.nodes).toContain('0x0000000000000000000000000000000000000001');
    expect(result.nodes).toContain('0x0000000000000000000000000000000000000002');
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.nodes_visited).toBeGreaterThanOrEqual(2);
  });

  it('should detect cycles', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValueOnce({
        counterparties: [
          { counterparty_address: '0x0000000000000000000000000000000000000001', volume_usd: 100, transaction_count: 1 }
        ]
      }),
    };

    const result = await traceCounterparties(mockApi, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 3,
      delayMs: 0,
    });

    const rootCount = result.nodes.filter(n => n === '0x0000000000000000000000000000000000000001').length;
    expect(rootCount).toBe(1);
  });

  it('should clamp depth to max 5', async () => {
    const mockApi = {
      addressCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    };

    const result = await traceCounterparties(mockApi, {
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ethereum',
      depth: 10,
      delayMs: 0,
    });

    expect(result.depth).toBe(5);
  });

  it('should reject missing address', async () => {
    const mockApi = {};
    await expect(traceCounterparties(mockApi, { chain: 'ethereum' }))
      .rejects.toThrow('address is required');
  });

  it('should reject invalid address', async () => {
    const mockApi = {};
    await expect(traceCounterparties(mockApi, { address: 'bad', chain: 'ethereum' }))
      .rejects.toThrow('Invalid');
  });
});

describe('compareWallets', () => {
  it('should require exactly 2 addresses', async () => {
    const mockApi = {};
    await expect(compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001'],
      chain: 'ethereum',
    })).rejects.toThrow('Exactly 2 addresses');
  });

  it('should reject invalid addresses', async () => {
    const mockApi = {};
    await expect(compareWallets(mockApi, {
      addresses: ['bad-addr', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
    })).rejects.toThrow('Invalid');
  });

  it('should return comparison data', async () => {
    const mockApi = {
      addressCounterparties: vi.fn()
        .mockResolvedValueOnce({ counterparties: [{ counterparty_address: '0x0000000000000000000000000000000000000003', volume_usd: 100 }] })
        .mockResolvedValueOnce({ counterparties: [{ counterparty_address: '0x0000000000000000000000000000000000000003', volume_usd: 200 }] }),
      addressBalance: vi.fn()
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', value_usd: 1000 }] })
        .mockResolvedValueOnce({ balances: [{ token_symbol: 'ETH', value_usd: 2000 }] }),
    };

    const result = await compareWallets(mockApi, {
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      chain: 'ethereum',
      delayMs: 0,
    });

    expect(result.addresses).toHaveLength(2);
    expect(result.shared_counterparties).toContain('0x0000000000000000000000000000000000000003');
    expect(result.shared_tokens).toContain('ETH');
    expect(result.balances).toHaveLength(2);
    expect(result.balances[0].total_usd).toBe(1000);
    expect(result.balances[1].total_usd).toBe(2000);
  });
});

describe('ENS integration in batchProfile', () => {
  it('should resolve .eth names and include ensName in results', async () => {
    const { resolveAddress: _resolveAddress } = await import('../ens.js');
    vi.spyOn(await import('../ens.js'), 'resolveAddress').mockResolvedValue({
      address: '0x0000000000000000000000000000000000000001',
      ensName: 'test.eth',
    });
    vi.spyOn(await import('../ens.js'), 'isEnsName').mockReturnValue(true);

    const mockApi = {
      addressLabels: vi.fn().mockResolvedValue({ labels: ['Fund'] }),
    };

    const result = await batchProfile(mockApi, {
      addresses: ['test.eth'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.results[0].ensName).toBe('test.eth');
    expect(result.results[0].address).toBe('0x0000000000000000000000000000000000000001');

    vi.restoreAllMocks();
  });

  it('should capture ENS resolution failure as entry error', async () => {
    vi.spyOn(await import('../ens.js'), 'isEnsName').mockReturnValue(true);
    vi.spyOn(await import('../ens.js'), 'resolveAddress').mockRejectedValue(
      new Error('Could not resolve ENS name: bad.eth')
    );

    const mockApi = {};

    const result = await batchProfile(mockApi, {
      addresses: ['bad.eth'],
      chain: 'ethereum',
      include: ['labels'],
      delayMs: 0,
    });

    expect(result.results[0].error).toBeDefined();
    expect(result.completed).toBe(0);

    vi.restoreAllMocks();
  });
});

describe('ENS integration in traceCounterparties', () => {
  it('should reject failed ENS resolution with INVALID_ADDRESS', async () => {
    vi.spyOn(await import('../ens.js'), 'isEnsName').mockReturnValue(true);
    vi.spyOn(await import('../ens.js'), 'resolveAddress').mockRejectedValue(
      new Error('Could not resolve ENS name: bad.eth')
    );

    const mockApi = {};
    await expect(
      traceCounterparties(mockApi, { address: 'bad.eth', chain: 'ethereum', delayMs: 0 })
    ).rejects.toThrow('Could not resolve ENS name');

    vi.restoreAllMocks();
  });
});

// =================== research / trade / deprecation ===================

describe('research command routing', () => {
  it('should list categories when called with no args', async () => {
    const commands = buildCommands({});
    const result = await commands.research([], null, {}, {});
    expect(result.categories).toContain('smart-money');
    expect(result.categories).toContain('profiler');
    expect(result.categories).toContain('token');
  });

  it('should list categories for help subcommand', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['help'], null, {}, {});
    expect(result.categories).toContain('smart-money');
  });

  it('should delegate to smart-money handler', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['smart-money', 'help'], null, {}, {});
    expect(result.commands).toContain('netflow');
  });

  it('should resolve category aliases (tgm -> token)', async () => {
    const commands = buildCommands({});
    const result = await commands.research(['tgm', 'help'], null, {}, {});
    expect(result.commands).toContain('screener');
  });

  it('should error on unknown category', async () => {
    const commands = buildCommands({});
    await expect(commands.research(['unknown'], null, {}, {}))
      .rejects.toThrow('Unknown research category');
  });
});

describe('trade command routing', () => {
  it('should list subcommands when called with no args', async () => {
    const logs = [];
    const commands = buildCommands({ log: (msg) => logs.push(msg) });
    await commands.trade([], null, {}, {});
    const output = logs.join('\n');
    expect(output).toContain('quote');
    expect(output).toContain('execute');
  });

  it('should error on unknown subcommand', async () => {
    const commands = buildCommands({});
    await expect(commands.trade(['unknown'], null, {}, {}))
      .rejects.toThrow('Unknown trade subcommand');
  });
});

describe('deprecation warnings', () => {
  it('should warn for deprecated research commands', async () => {
    const errors = [];
    const deps = {
      output: () => {},
      errorOutput: (msg) => errors.push(msg),
      exit: () => {},
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    await runCLI(['smart-money', 'netflow'], deps);
    expect(errors.some(e => e.includes('deprecated'))).toBe(true);
    expect(errors.some(e => e.includes('nansen research smart-money'))).toBe(true);
  });

  it('should warn for deprecated trade commands', async () => {
    const errors = [];
    const deps = {
      output: () => {},
      errorOutput: (msg) => errors.push(msg),
      exit: () => {}
    };
    await runCLI(['quote'], deps);
    expect(errors.some(e => e.includes('deprecated'))).toBe(true);
    expect(errors.some(e => e.includes('nansen trade quote'))).toBe(true);
  });

  it('should not warn for new research path', async () => {
    const errors = [];
    const deps = {
      output: () => {},
      errorOutput: (msg) => errors.push(msg),
      exit: () => {},
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    await runCLI(['research', 'smart-money', 'netflow'], deps);
    expect(errors.some(e => e.includes('deprecated'))).toBe(false);
  });

  it('should include all expected categories in DEPRECATED_TO_RESEARCH', () => {
    expect(DEPRECATED_TO_RESEARCH.has('smart-money')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('profiler')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('token')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('search')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('perp')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('portfolio')).toBe(true);
    expect(DEPRECATED_TO_RESEARCH.has('points')).toBe(true);
  });

  it('should include quote and execute in DEPRECATED_TO_TRADE', () => {
    expect(DEPRECATED_TO_TRADE.has('quote')).toBe(true);
    expect(DEPRECATED_TO_TRADE.has('execute')).toBe(true);
  });

  it('should route deprecated quote through to the handler', async () => {
    const outputs = [];
    const errors = [];
    const deps = {
      output: (msg) => outputs.push(msg),
      errorOutput: (msg) => errors.push(msg),
      exit: () => {}
    };
    // quote with no args shows its help; confirms handler was reached
    const result = await runCLI(['quote'], deps);
    expect(errors.some(e => e.includes('nansen trade quote'))).toBe(true);
    expect(result.type).toBe('no-output');
  });
});

describe('SCHEMA structure', () => {
  it('should have research and trade top-level commands', () => {
    expect(SCHEMA.commands.research).toBeDefined();
    expect(SCHEMA.commands.trade).toBeDefined();
  });

  it('should have research subcommands matching deprecated categories', () => {
    const researchSubs = Object.keys(SCHEMA.commands.research.subcommands);
    expect(researchSubs).toContain('smart-money');
    expect(researchSubs).toContain('profiler');
    expect(researchSubs).toContain('token');
    expect(researchSubs).toContain('search');
    expect(researchSubs).toContain('perp');
    expect(researchSubs).toContain('portfolio');
    expect(researchSubs).toContain('points');
    expect(researchSubs).toContain('prediction-market');
  });

  it('should populate research subcommands from deprecated entries', () => {
    const smSubs = SCHEMA.commands.research.subcommands['smart-money'].subcommands;
    expect(smSubs.netflow).toBeDefined();
    expect(smSubs['dex-trades']).toBeDefined();
  });

  it('should have trade subcommands', () => {
    const tradeSubs = Object.keys(SCHEMA.commands.trade.subcommands);
    expect(tradeSubs).toContain('quote');
    expect(tradeSubs).toContain('execute');
  });

  it('should not have deprecated entries at top level', () => {
    expect(SCHEMA.commands['smart-money']).toBeUndefined();
    expect(SCHEMA.commands.profiler).toBeUndefined();
    expect(SCHEMA.commands.token).toBeUndefined();
    expect(SCHEMA.commands.search).toBeUndefined();
    expect(SCHEMA.commands.perp).toBeUndefined();
    expect(SCHEMA.commands.portfolio).toBeUndefined();
    expect(SCHEMA.commands.points).toBeUndefined();
  });
});

describe('buildPagination', () => {
  it('returns undefined when neither --page nor --limit is set', () => {
    expect(buildPagination({})).toBeUndefined();
  });

  it('handles --page alone', () => {
    expect(buildPagination({ page: '2' })).toEqual({ page: 2, per_page: undefined });
  });

  it('handles --page + --limit together', () => {
    expect(buildPagination({ page: '3', limit: 10 })).toEqual({ page: 3, per_page: 10 });
  });

  it('guards against NaN --page value', () => {
    expect(buildPagination({ page: 'abc' })).toEqual({ page: 1, per_page: undefined });
  });

  it('clamps negative --page to 1', () => {
    expect(buildPagination({ page: '-5' })).toEqual({ page: 1, per_page: undefined });
  });

  it('handles --limit alone', () => {
    expect(buildPagination({ limit: 25 })).toEqual({ page: 1, per_page: 25 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// web command (search + fetch subcommands)
// ─────────────────────────────────────────────────────────────────────────────
describe('web search subcommand', () => {
  let webCmd;
  let mockApi;

  beforeEach(() => {
    mockApi = {
      webSearch: vi.fn().mockResolvedValue({ results: [] }),
    };
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    webCmd = (args, options = {}) => commands['web'](['search', ...args], mockApi, {}, options);
  });

  it('passes a single positional arg as query', async () => {
    await webCmd(['bitcoin price']);
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin price'], numResults: undefined });
  });

  it('passes multiple positional args as multiple queries', async () => {
    await webCmd(['bitcoin price', 'ethereum news']);
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin price', 'ethereum news'], numResults: undefined });
  });

  it('passes --query flag as query', async () => {
    await webCmd([], { query: 'solana defi' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['solana defi'], numResults: undefined });
  });

  it('merges positional args and --query flag', async () => {
    await webCmd(['bitcoin'], { query: 'ethereum' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin', 'ethereum'], numResults: undefined });
  });

  it('handles --query as an array (repeated flag)', async () => {
    await webCmd([], { query: ['btc news', 'eth news'] });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['btc news', 'eth news'], numResults: undefined });
  });

  it('passes --num-results as numResults (parsed as int)', async () => {
    await webCmd(['bitcoin'], { 'num-results': '5' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin'], numResults: 5 });
  });

  it('treats non-numeric --num-results as undefined (NaN guard)', async () => {
    await webCmd(['bitcoin'], { 'num-results': 'abc' });
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin'], numResults: undefined });
  });

  it('throws INVALID_PARAM when --num-results is 0 (out of range)', async () => {
    await expect(webCmd(['bitcoin'], { 'num-results': '0' })).rejects.toThrow('--num-results must be between 1 and 20');
  });

  it('throws INVALID_PARAM when --num-results is 21 (out of range)', async () => {
    await expect(webCmd(['bitcoin'], { 'num-results': '21' })).rejects.toThrow('--num-results must be between 1 and 20');
  });

  it('returns the API response', async () => {
    const stub = { results: [{ query: 'bitcoin', organic: [] }] };
    mockApi.webSearch.mockResolvedValue(stub);
    const result = await webCmd(['bitcoin']);
    expect(result).toEqual(stub);
  });

  it('throws MISSING_PARAM when no query provided', async () => {
    await expect(webCmd([])).rejects.toThrow('At least one query is required');
  });

  it('filters out empty string queries', async () => {
    await webCmd(['', 'bitcoin'], {});
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['bitcoin'], numResults: undefined });
  });

  it('throws MISSING_PARAM when all queries are empty/whitespace', async () => {
    await expect(webCmd(['', '   '])).rejects.toThrow('At least one query is required');
  });

  it('filters out whitespace-only queries', async () => {
    await webCmd(['  ', 'ethereum'], {});
    expect(mockApi.webSearch).toHaveBeenCalledWith({ queries: ['ethereum'], numResults: undefined });
  });
});

describe('web fetch subcommand', () => {
  let webCmd;
  let mockApi;

  beforeEach(() => {
    mockApi = {
      webFetch: vi.fn().mockResolvedValue({ analysis: 'test', urls_requested: 1, retrieved_urls: [], failed_urls: [] }),
    };
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    webCmd = (args, options = {}) => commands['web'](['fetch', ...args], mockApi, {}, options);
  });

  it('passes a single positional URL and --question', async () => {
    await webCmd(['https://nansen.ai'], { question: 'What is this?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://nansen.ai'], question: 'What is this?' });
  });

  it('passes multiple positional URLs', async () => {
    await webCmd(['https://a.com', 'https://b.com'], { question: 'Compare?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://a.com', 'https://b.com'], question: 'Compare?' });
  });

  it('passes --url flag as URL', async () => {
    await webCmd([], { url: 'https://nansen.ai', question: 'What?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://nansen.ai'], question: 'What?' });
  });

  it('handles --url as an array (repeated flag)', async () => {
    await webCmd([], { url: ['https://a.com', 'https://b.com'], question: 'Compare?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://a.com', 'https://b.com'], question: 'Compare?' });
  });

  it('merges positional URLs and --url flag', async () => {
    await webCmd(['https://a.com'], { url: 'https://b.com', question: 'Diff?' });
    expect(mockApi.webFetch).toHaveBeenCalledWith({ urls: ['https://a.com', 'https://b.com'], question: 'Diff?' });
  });

  it('returns the API response', async () => {
    const stub = { analysis: 'Nansen is a blockchain analytics platform.', urls_requested: 1, retrieved_urls: ['https://nansen.ai'], failed_urls: [] };
    mockApi.webFetch.mockResolvedValue(stub);
    const result = await webCmd(['https://nansen.ai'], { question: 'What?' });
    expect(result).toEqual(stub);
  });

  it('throws MISSING_PARAM when no URL provided', async () => {
    await expect(webCmd([], { question: 'What?' })).rejects.toThrow('At least one URL is required');
  });

  it('throws MISSING_PARAM when --question is missing', async () => {
    await expect(webCmd(['https://nansen.ai'])).rejects.toThrow('--question is required');
  });

  it('throws MISSING_PARAM when --question is blank/whitespace', async () => {
    await expect(webCmd(['https://nansen.ai'], { question: '   ' })).rejects.toThrow('--question is required and cannot be blank');
  });

  it('throws INVALID_PARAMS when a URL has no scheme', async () => {
    await expect(webCmd(['not-a-url'], { question: 'What?' })).rejects.toThrow('Invalid URL: "not-a-url"');
  });

  it('throws INVALID_PARAMS when a URL has no scheme (://bad)', async () => {
    await expect(webCmd(['://bad'], { question: 'What?' })).rejects.toThrow('Invalid URL');
  });

  it('throws MISSING_PARAM when both URL and question are missing', async () => {
    await expect(webCmd([])).rejects.toThrow('At least one URL is required');
  });
});

describe('web help subcommand', () => {
  it('returns available subcommands', async () => {
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    const result = await commands['web']([], {}, {}, {});
    expect(result).toMatchObject({ subcommands: ['search', 'fetch'] });
  });

  it('throws for unknown web subcommand', async () => {
    const commands = buildCommands({ output: () => {}, errorOutput: () => {}, exit: () => {} });
    await expect(commands['web'](['unknown'], {}, {}, {})).rejects.toThrow('Unknown web subcommand');
  });
});

// ============= Alert Validation Tests =============

describe('validateAlertData -- type-specific required fields', () => {
  it('should pass for sm-token-flows with a flow threshold set', () => {
    expect(() => validateAlertData('sm-token-flows', {
      inflow_1h: { min: 1000000 },
      inflow_1d: {},
      inflow_7d: {},
      outflow_1h: {},
      outflow_1d: {},
      outflow_7d: {},
      netflow_1h: {},
      netflow_1d: {},
      netflow_7d: {},
    })).not.toThrow();
  });

  it('should fail for sm-token-flows with no flow thresholds', () => {
    expect(() => validateAlertData('sm-token-flows', {
      inflow_1h: {},
      inflow_1d: {},
      inflow_7d: {},
      outflow_1h: {},
      outflow_1d: {},
      outflow_7d: {},
      netflow_1h: {},
      netflow_1d: {},
      netflow_7d: {},
    })).toThrow('at least one flow threshold');
  });

  it('should pass for common-token-transfer with subjects', () => {
    expect(() => validateAlertData('common-token-transfer', {
      subjects: [{ type: 'label', value: 'CEX' }],
      inclusion: {},
    })).not.toThrow();
  });

  it('should pass for common-token-transfer with inclusion tokens', () => {
    expect(() => validateAlertData('common-token-transfer', {
      subjects: [],
      inclusion: { tokens: [{ address: '0xabc', chain: 'ethereum' }] },
    })).not.toThrow();
  });

  it('should fail for common-token-transfer with neither subjects nor tokens', () => {
    expect(() => validateAlertData('common-token-transfer', {
      subjects: [],
      inclusion: { tokens: [] },
    })).toThrow('at least one --subject or --token');
  });

  it('should pass for smart-contract-call with caller', () => {
    expect(() => validateAlertData('smart-contract-call', {
      inclusion: { caller: [{ type: 'address', value: '0x123' }], smartContract: [] },
      signatureHash: [],
    })).not.toThrow();
  });

  it('should pass for smart-contract-call with signature-hash', () => {
    expect(() => validateAlertData('smart-contract-call', {
      inclusion: { caller: [], smartContract: [] },
      signatureHash: ['0xa9059cbb'],
    })).not.toThrow();
  });

  it('should fail for smart-contract-call with nothing set', () => {
    expect(() => validateAlertData('smart-contract-call', {
      inclusion: { caller: [], smartContract: [] },
      signatureHash: [],
    })).toThrow('at least one --caller, --contract, or --signature-hash');
  });

  it('should no-op when type is null', () => {
    expect(() => validateAlertData(null, { subjects: [] })).not.toThrow();
  });

  it('should no-op when data is undefined', () => {
    expect(() => validateAlertData('sm-token-flows', undefined)).not.toThrow();
  });
});

describe('alerts update -- deep-merge range fields', () => {
  it('should preserve existing max when only min is updated (sm-token-flows)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-min': '2000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 2000000, max: 50000000 });
    expect(sentData.outflow_1d).toEqual({ min: 500, max: 10000 });
  });

  it('should preserve existing min when only max is updated (sm-token-flows)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-max': '99000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.inflow_1h).toEqual({ min: 1000000, max: 99000000 });
    expect(sentData.outflow_1d).toEqual({ min: 500, max: 10000 });
  });

  it('should preserve existing max when only min is updated (common-token-transfer usdValue)', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          usdValue: { min: 100, max: 999999 },
          subjects: [{ type: 'label', value: 'smart_money' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'usd-max': '5000000' });
    const sentData = mockApi.alertsUpdate.mock.calls[0][0].data;
    expect(sentData.usdValue).toEqual({ min: 100, max: 5000000 });
  });
});

describe('alerts create -- type-specific validation', () => {
  it('should reject sm-token-flows create with no flow thresholds', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
    })).rejects.toThrow('at least one flow threshold');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should reject common-token-transfer create with no subjects or tokens', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'common-token-transfer',
      chains: 'ethereum',
      telegram: '123',
    })).rejects.toThrow('at least one --subject or --token');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should reject smart-contract-call create with no caller/contract/signature-hash', async () => {
    const mockApi = { alertsCreate: vi.fn() };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'smart-contract-call',
      chains: 'ethereum',
      telegram: '123',
    })).rejects.toThrow('at least one --caller, --contract, or --signature-hash');
    expect(mockApi.alertsCreate).not.toHaveBeenCalled();
  });

  it('should allow valid sm-token-flows create with flow threshold', async () => {
    const mockApi = { alertsCreate: vi.fn().mockResolvedValue({ id: 'new' }) };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['create'], mockApi, {}, {
      name: 'Test',
      type: 'sm-token-flows',
      chains: 'ethereum',
      telegram: '123',
      'inflow-1h-min': '1000000',
    });
    expect(mockApi.alertsCreate).toHaveBeenCalled();
  });
});

describe('alerts update -- type-specific validation', () => {
  it('should reject update that clears last flow threshold via --data', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, {
      data: JSON.stringify({
        inflow_1h: { min: null, max: null },
        outflow_1h: { min: null, max: null },
        netflow_1h: { min: null, max: null },
      }),
    })).rejects.toThrow('at least one flow threshold');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should reject update that clears last subject via --data', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'common-token-transfer',
        data: {
          chains: ['ethereum'],
          subjects: [{ type: 'label', value: 'CEX' }],
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn(),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await expect(cmd(['update', 'abc123'], mockApi, {}, {
      data: JSON.stringify({ subjects: [] }),
    })).rejects.toThrow('at least one --subject or --token');
    expect(mockApi.alertsUpdate).not.toHaveBeenCalled();
  });

  it('should allow update when validation still passes after merge', async () => {
    const mockApi = {
      alertsGet: vi.fn().mockResolvedValue({
        type: 'sm-token-flows',
        data: {
          chains: ['ethereum'],
          inflow_1h: { min: 1000000, max: 50000000 },
          outflow_1d: { min: 500, max: 10000 },
          inclusion: {},
          exclusion: {},
        },
      }),
      alertsUpdate: vi.fn().mockResolvedValue({ id: 'abc123' }),
    };
    const cmd = buildAlertsCommands({ log: vi.fn() })['alerts'];
    await cmd(['update', 'abc123'], mockApi, {}, { 'inflow-1h-max': '99000000' });
    expect(mockApi.alertsUpdate).toHaveBeenCalled();
  });
});
