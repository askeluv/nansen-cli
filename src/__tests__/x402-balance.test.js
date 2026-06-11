/**
 * Tests for the x402 EVM payment-token registry used by balance checks.
 */

import { describe, it, expect } from 'vitest';
import { EVM_X402_TOKENS, EVM_X402_RPCS } from '../x402.js';

describe('EVM_X402_TOKENS registry', () => {
  it('covers Base, X Layer, and BNB Smart Chain', () => {
    expect(Object.keys(EVM_X402_TOKENS).sort()).toEqual(
      ['eip155:196', 'eip155:56', 'eip155:8453'],
    );
  });

  it('lists the four BSC stablecoins with eip3009-capable tokens first', () => {
    const symbols = EVM_X402_TOKENS['eip155:56'].map(t => t.symbol);
    expect(symbols).toEqual(['U', 'USD1', 'USDT', 'USDC']);
  });

  it('uses 18 decimals for every BSC token and 6 elsewhere', () => {
    for (const t of EVM_X402_TOKENS['eip155:56']) {
      expect(t.decimals, t.symbol).toBe(18);
    }
    expect(EVM_X402_TOKENS['eip155:8453'][0].decimals).toBe(6);
    expect(EVM_X402_TOKENS['eip155:196'][0].decimals).toBe(6);
  });

  it('pins the expected token contracts', () => {
    expect(EVM_X402_TOKENS['eip155:8453'][0].token)
      .toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // Base USDC
    const bsc = Object.fromEntries(
      EVM_X402_TOKENS['eip155:56'].map(t => [t.symbol, t.token]),
    );
    expect(bsc.U).toBe('0xcE24439F2D9C6a2289F741120FE202248B666666');
    expect(bsc.USD1).toBe('0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d');
    expect(bsc.USDT).toBe('0x55d398326f99059fF775485246999027B3197955');
    expect(bsc.USDC).toBe('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
  });

  it('resolves an RPC URL for every network', () => {
    for (const network of Object.keys(EVM_X402_TOKENS)) {
      expect(EVM_X402_RPCS[network], `rpc for ${network}`).toMatch(/^https?:\/\//);
    }
  });
});
