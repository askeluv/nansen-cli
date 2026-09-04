/**
 * Alerts command - numeric range validation
 *
 * buildRange() / parseFiniteNumber() feed --*-min/--*-max flags into the
 * alert payload sent to the API. Before this fix, a non-numeric value
 * (typo, empty string, etc.) silently became NaN, which JSON.stringify
 * then turns into `null` — so the filter the user asked for would vanish
 * from the request instead of failing loudly.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSmTokenFlowsData,
  buildCommonTokenTransferData,
  buildSmartContractCallData,
} from '../commands/alerts.js';

describe('alerts numeric range validation', () => {
  it('builds a valid range for sm-token-flows', () => {
    const data = buildSmTokenFlowsData({ 'inflow-1h-min': '1000000', 'inflow-1h-max': '5000000' });
    expect(data.inflow_1h).toEqual({ min: 1000000, max: 5000000 });
  });

  it('allows negative values (net outflow) instead of rejecting all negatives', () => {
    const data = buildSmTokenFlowsData({ 'netflow-1h-min': '-5000', 'netflow-1h-max': '10000' });
    expect(data.netflow_1h).toEqual({ min: -5000, max: 10000 });
  });

  it('rejects non-numeric --usd-min instead of silently sending null', () => {
    expect(() => buildCommonTokenTransferData({ 'usd-min': 'abc' })).toThrow(/--usd-min/);
  });

  it('rejects non-numeric --token-amount-max', () => {
    expect(() => buildCommonTokenTransferData({ 'token-amount-max': 'lots' })).toThrow(/--token-amount-max/);
  });

  it('rejects non-numeric --market-cap-min on sm-token-flows', () => {
    expect(() => buildSmTokenFlowsData({ 'market-cap-min': 'n/a' })).toThrow(/--market-cap-min/);
  });

  it('rejects non-numeric --token-age-max', () => {
    expect(() => buildSmTokenFlowsData({ 'token-age-max': 'seven' })).toThrow(/--token-age-max/);
  });

  it('rejects non-numeric --token-age-min/--token-age-max on common-token-transfer', () => {
    expect(() => buildCommonTokenTransferData({ 'token-age-min': 'x' })).toThrow(/--token-age-min/);
    expect(() => buildCommonTokenTransferData({ 'token-age-max': 'y' })).toThrow(/--token-age-max/);
  });

  it('rejects non-numeric --usd-max on smart-contract-call', () => {
    expect(() => buildSmartContractCallData({ 'usd-max': 'not-a-number' })).toThrow(/--usd-max/);
  });

  it('leaves ranges undefined when no min/max flags are given', () => {
    expect(buildSmTokenFlowsData({}).inflow_1h).toBeUndefined();
  });
});
