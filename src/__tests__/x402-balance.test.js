/**
 * Tests for the x402 EVM payment-token registry used by balance checks.
 */

import { describe, it, expect } from 'vitest';
import { EVM_X402_TOKENS } from '../x402.js';
import { CHAIN_RPCS } from '../rpc-urls.js';

describe('EVM_X402_TOKENS registry', () => {
  it('covers Base, X Layer, and BNB Smart Chain', () => {
    expect(Object.keys(EVM_X402_TOKENS).sort()).toEqual(
      ['eip155:196', 'eip155:56', 'eip155:8453'],
    );
  });

  it('uses 18 decimals for BSC USDT and 6 for the others', () => {
    expect(EVM_X402_TOKENS['eip155:56'].decimals).toBe(18);
    expect(EVM_X402_TOKENS['eip155:8453'].decimals).toBe(6);
    expect(EVM_X402_TOKENS['eip155:196'].decimals).toBe(6);
  });

  it('pins the expected token contracts', () => {
    expect(EVM_X402_TOKENS['eip155:8453'].token)
      .toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // Base USDC
    expect(EVM_X402_TOKENS['eip155:56'].token)
      .toBe('0x55d398326f99059fF775485246999027B3197955'); // BSC USDT
  });

  it('resolves an RPC URL for every network', () => {
    for (const [network, cfg] of Object.entries(EVM_X402_TOKENS)) {
      expect(cfg.rpc, `rpc for ${network}`).toMatch(/^https?:\/\//);
    }
  });

  it('has a BSC entry in the shared RPC registry', () => {
    expect(CHAIN_RPCS.bsc).toMatch(/^https?:\/\//);
  });
});
