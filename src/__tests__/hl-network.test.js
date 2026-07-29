import { describe, it, expect, afterEach } from 'vitest';

import { hlNetwork, HL_TESTNET_API_URL } from '../hl-env.js';
import {
  buildApproveBuilderFeeAction,
  buildUsdClassTransferAction,
  l1Eip712,
} from '../hl-action.js';

// M8: source/hyperliquidChain used to be hardcoded to mainnet, so pointing
// NANSEN_HL_API_URL at the testnet signed actions the testnet rejects. These pin
// that both fields follow the resolved base URL.

const prev = process.env.NANSEN_HL_API_URL;

afterEach(() => {
  if (prev === undefined) delete process.env.NANSEN_HL_API_URL;
  else process.env.NANSEN_HL_API_URL = prev;
});

describe('hlNetwork', () => {
  it('defaults to Mainnet', () => {
    delete process.env.NANSEN_HL_API_URL;
    expect(hlNetwork()).toBe('Mainnet');
  });

  it('reports Testnet for the HL testnet host', () => {
    process.env.NANSEN_HL_API_URL = HL_TESTNET_API_URL;
    expect(hlNetwork()).toBe('Testnet');
  });

  it('treats a local mock as Mainnet, so tests keep the mainnet vectors', () => {
    process.env.NANSEN_HL_API_URL = 'http://127.0.0.1:8787';
    expect(hlNetwork()).toBe('Mainnet');
  });

  it('falls back to Mainnet on an unparseable override rather than throwing', () => {
    process.env.NANSEN_HL_API_URL = 'not a url';
    expect(hlNetwork()).toBe('Mainnet');
  });
});

describe('action network derivation', () => {
  const action = { type: 'cancel', cancels: [{ a: 1, o: 2 }] };

  it('signs the L1 phantom agent with source "a" on mainnet', () => {
    delete process.env.NANSEN_HL_API_URL;
    expect(l1Eip712(action, null, 1).message.source).toBe('a');
  });

  it('signs the L1 phantom agent with source "b" on testnet', () => {
    process.env.NANSEN_HL_API_URL = HL_TESTNET_API_URL;
    expect(l1Eip712(action, null, 1).message.source).toBe('b');
  });

  it('carries hyperliquidChain Testnet into user-signed actions on testnet', () => {
    process.env.NANSEN_HL_API_URL = HL_TESTNET_API_URL;
    expect(
      buildApproveBuilderFeeAction({ maxFeeRate: '0.08%', builder: '0xb', nonce: 1 }).action
        .hyperliquidChain,
    ).toBe('Testnet');
    expect(
      buildUsdClassTransferAction({ amount: 5, toPerp: true, nonce: 1 }).action.hyperliquidChain,
    ).toBe('Testnet');
  });

  it('keeps hyperliquidChain Mainnet by default', () => {
    delete process.env.NANSEN_HL_API_URL;
    expect(
      buildApproveBuilderFeeAction({ maxFeeRate: '0.08%', builder: '0xb', nonce: 1 }).action
        .hyperliquidChain,
    ).toBe('Mainnet');
    expect(
      buildUsdClassTransferAction({ amount: 5, toPerp: true, nonce: 1 }).action.hyperliquidChain,
    ).toBe('Mainnet');
  });

  it('lets a caller pin the network explicitly', () => {
    delete process.env.NANSEN_HL_API_URL;
    expect(l1Eip712(action, null, 1, 'Testnet').message.source).toBe('b');
  });
});

describe('usdClassTransfer amount rendering', () => {
  it('renders a plain amount without trailing zeros', () => {
    expect(buildUsdClassTransferAction({ amount: 25, toPerp: true, nonce: 1 }).action.amount).toBe('25');
    expect(buildUsdClassTransferAction({ amount: 0.5, toPerp: false, nonce: 1 }).action.amount).toBe('0.5');
  });

  it('refuses an amount that would render in exponential notation', () => {
    // toFixed() switches to "1e+21" from 1e21 up, which HL's parser rejects —
    // previously signed as-is and rejected opaquely after the signature.
    expect(() => buildUsdClassTransferAction({ amount: 1e21, toPerp: true, nonce: 1 })).toThrow(
      /below 1e21/,
    );
  });

  it('refuses a non-positive or non-finite amount', () => {
    expect(() => buildUsdClassTransferAction({ amount: 0, toPerp: true, nonce: 1 })).toThrow(/Invalid/);
    expect(() => buildUsdClassTransferAction({ amount: -5, toPerp: true, nonce: 1 })).toThrow(/Invalid/);
    expect(() => buildUsdClassTransferAction({ amount: NaN, toPerp: true, nonce: 1 })).toThrow(/Invalid/);
    expect(() => buildUsdClassTransferAction({ amount: Infinity, toPerp: true, nonce: 1 })).toThrow(/Invalid/);
  });
});
