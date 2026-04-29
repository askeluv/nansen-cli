/**
 * Tests for X Layer chain support
 */

import { describe, it, expect } from 'vitest';
import { EVM_CHAIN_IDS, EVM_CHAINS } from '../chain-ids.js';
import { CHAIN_RPCS } from '../rpc-urls.js';

describe('X Layer chain configuration', () => {
  it('has chain ID 196 in EVM_CHAIN_IDS', () => {
    expect(EVM_CHAIN_IDS.xlayer).toBe(196);
  });

  it('is listed in EVM_CHAINS', () => {
    expect(EVM_CHAINS).toContain('xlayer');
  });

  it('has an RPC URL configured', () => {
    expect(CHAIN_RPCS.xlayer).toBeDefined();
    expect(CHAIN_RPCS.xlayer).toMatch(/^https:\/\//);
  });

  it('RPC URL points to okx.com', () => {
    expect(CHAIN_RPCS.xlayer).toContain('xlayerrpc.okx.com');
  });
});
