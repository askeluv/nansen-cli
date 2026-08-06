import { describe, it, expect } from 'vitest';
import {
  encodeMsgpack,
  floatToWire,
  pyRound,
  roundPrice,
  roundSize,
  actionHash,
  l1Eip712,
  buildOrderAction,
  buildCancelAction,
  buildCloseAction,
  buildLeverageAction,
} from '../hl-action.js';

// The Nansen builder code the API attaches to every order/close fill.
const BUILDER = { b: '0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f', f: 80 };
const ETH = { assetId: 1, szDecimals: 4 };
const BTC = { assetId: 0, szDecimals: 5 };

// ── Golden vectors ───────────────────────────────────────────────────
//
// Captured from the live nansen-api /perp/* prepare endpoints (the known-good
// Python path via hyperliquid-python-sdk) on 2026-07-23. Each asserts that the
// locally-built action reproduces the API's `action` AND that the phantom-agent
// connectionId (keccak of msgpack(action)‖nonce‖vault) matches byte-for-byte.
// If msgpack, rounding, or wire assembly drifts, the connectionId diverges and
// the test fails — no mainnet guess required. Regenerate with
// scratchpad/verify_batch.mjs against the live endpoints if the SDK bumps.

const GOLDEN = [
  {
    name: 'limit order (buy, Gtc, builder attached)',
    build: () => buildOrderAction({ coin: 'ETH', isBuy: true, size: 0.0123, price: 1850.7, orderType: 'limit', tif: 'Gtc', slippage: 0.03, reduceOnly: false, builder: BUILDER }, ETH),
    nonce: 1784805814604,
    action: { type: 'order', orders: [{ a: 1, b: true, p: '1850.7', s: '0.0123', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na', builder: BUILDER },
    connectionId: '0x0fa7293cb6fc5802d8b2169839d90eeec30a0ef0d09856b32d7977e807d2bd11',
  },
  {
    name: 'market order (slippage folded into Ioc price, size rounded)',
    build: () => buildOrderAction({ coin: 'ETH', isBuy: true, size: 0.0071111, price: 1850.7, orderType: 'market', slippage: 0.03, reduceOnly: false, builder: BUILDER }, ETH),
    nonce: 1784805870819,
    action: { type: 'order', orders: [{ a: 1, b: true, p: '1906.2', s: '0.0071', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na', builder: BUILDER },
    connectionId: '0x35f5e7cd138f400f406618d81c3d55043490c124d39e47e4c56c035c056a5882',
  },
  {
    name: 'order with TP/SL (normalTpsl grouping, banker-rounded SL 1700.25->1700.2)',
    build: () => buildOrderAction({ coin: 'ETH', isBuy: true, size: 0.05, price: 1850.7, orderType: 'limit', tif: 'Gtc', takeProfit: 2100.5, stopLoss: 1700.25, reduceOnly: false, builder: BUILDER }, ETH),
    nonce: 1784805872347,
    action: {
      type: 'order',
      orders: [
        { a: 1, b: true, p: '1850.7', s: '0.05', r: false, t: { limit: { tif: 'Gtc' } } },
        { a: 1, b: false, p: '2100.5', s: '0.05', r: true, t: { trigger: { isMarket: true, triggerPx: '2100.5', tpsl: 'tp' } } },
        { a: 1, b: false, p: '1700.2', s: '0.05', r: true, t: { trigger: { isMarket: true, triggerPx: '1700.2', tpsl: 'sl' } } },
      ],
      grouping: 'normalTpsl',
      builder: BUILDER,
    },
    connectionId: '0x5ea15b504a31fa6a0c29403fe7fae12db798f0ef24a5cad38a4e7c600de12470',
  },
  {
    name: 'BTC limit sell (5 sig-fig truncation 100123.456->100120, Alo)',
    build: () => buildOrderAction({ coin: 'BTC', isBuy: false, size: 0.001234, price: 100123.456, orderType: 'limit', tif: 'Alo', reduceOnly: false, builder: BUILDER }, BTC),
    nonce: 1784805873440,
    action: { type: 'order', orders: [{ a: 0, b: false, p: '100120', s: '0.00123', r: false, t: { limit: { tif: 'Alo' } } }], grouping: 'na', builder: BUILDER },
    connectionId: '0xac56926d68c9f0dad07712bdd7a7e6eb82b67f36ca518522c63264a773def4b6',
  },
  {
    name: 'cancel',
    build: () => buildCancelAction({ orderId: 123456789 }, ETH),
    nonce: 1784805874771,
    action: { type: 'cancel', cancels: [{ a: 1, o: 123456789 }] },
    connectionId: '0x21831e80ecfbfb90c14889317ab9b88626a52a82107527d924d1367683905086',
  },
  {
    name: 'close (market reduce-only, builder attached)',
    build: () => buildCloseAction({ size: 0.0071111, price: 1850.7, isBuy: false, slippage: 0.03, builder: BUILDER }, ETH),
    nonce: 1784805876384,
    action: { type: 'order', orders: [{ a: 1, b: false, p: '1795.2', s: '0.0071', r: true, t: { limit: { tif: 'Ioc' } } }], grouping: 'na', builder: BUILDER },
    connectionId: '0x1ba887e6fb1612668898392bd956ae12b175ea96c3ffef965bef4ed6117cd7a2',
  },
  {
    name: 'updateLeverage (cross)',
    build: () => buildLeverageAction({ leverage: 10, isCross: true }, ETH),
    nonce: 1784805877448,
    action: { type: 'updateLeverage', asset: 1, isCross: true, leverage: 10 },
    connectionId: '0x6ee8bba5f82c0cd32b2929ab67d0335c746926ec69d100ba2a15b748516f7924',
  },
];

describe('hl-action golden vectors (vs live API prepare)', () => {
  for (const g of GOLDEN) {
    it(g.name, () => {
      const { action } = g.build();
      // Key order is load-bearing (msgpack encodes maps in insertion order), so
      // compare the serialized form, not just deep structural equality.
      expect(JSON.stringify(action)).toBe(JSON.stringify(g.action));
      const eip = l1Eip712(action, null, g.nonce);
      expect(eip.message.connectionId).toBe(g.connectionId);
    });
  }
});

describe('floatToWire', () => {
  it('strips trailing zeros and the dot', () => {
    expect(floatToWire(1850.7)).toBe('1850.7');
    expect(floatToWire(0.0123)).toBe('0.0123');
    expect(floatToWire(2000)).toBe('2000');
    expect(floatToWire(100120)).toBe('100120');
  });
  it('throws when a value cannot be represented in 8 decimals', () => {
    expect(() => floatToWire(0.123456789)).toThrow(/rounding/);
  });
});

describe('pyRound (bankers rounding)', () => {
  it('rounds ties to even, not away from zero', () => {
    expect(pyRound(0.5, 0)).toBe(0); // 0 is even
    expect(pyRound(1.5, 0)).toBe(2); // 2 is even
    expect(pyRound(2.5, 0)).toBe(2); // 2 is even
    expect(pyRound(1700.25, 1)).toBe(1700.2); // 2 is even
  });
  it('handles negative ndigits without float dirt', () => {
    expect(pyRound(100123.456, -1)).toBe(100120);
  });
  it('does not treat values near a half as exact ties', () => {
    expect(pyRound(0.005, 2)).toBe(0.01);
    expect(pyRound(0.0049999, 2)).toBe(0);
  });
});

describe('roundPrice / roundSize', () => {
  it('applies 5 sig-figs then perp decimal cap', () => {
    // ETH szDecimals=4 -> price capped at 2 decimals; 5 sig-figs first.
    expect(roundPrice(1906.221, 4)).toBe(1906.2);
    // BTC szDecimals=5 -> 1 decimal; 100123.456 -> 100120.
    expect(roundPrice(100123.456, 5)).toBe(100120);
  });
  it('rounds size to szDecimals', () => {
    expect(roundSize(0.0071111, 4)).toBe(0.0071);
    expect(roundSize(0.001234, 5)).toBe(0.00123);
  });
});

describe('zero-rounded order values', () => {
  const builders = [
    params => buildOrderAction({ isBuy: true, orderType: 'limit', ...params }, BTC),
    params => buildCloseAction({ isBuy: false, ...params }, BTC),
  ];

  it.each(builders)('rejects a size that rounds to zero', build => {
    expect(() => build({ size: 0.000001, price: 100 })).toThrow(expect.objectContaining({ code: 'ZERO_SIZE' }));
  });

  it.each(builders)('rejects a price that rounds to zero', build => {
    expect(() => build({ size: 0.001, price: 0.0000001 })).toThrow(expect.objectContaining({ code: 'ZERO_PRICE' }));
  });

  // BTC szDecimals=5 -> price rounds to 1 decimal, so anything < 0.05 rounds to
  // zero. The parent leg has a valid price; only the protective leg rounds away.
  it('rejects a stop-loss that rounds to zero', () => {
    expect(() => buildOrderAction(
      { isBuy: true, orderType: 'limit', size: 0.001, price: 100, stopLoss: 0.03 }, BTC,
    )).toThrow(expect.objectContaining({ code: 'ZERO_PRICE' }));
  });

  it('rejects a take-profit that rounds to zero', () => {
    expect(() => buildOrderAction(
      { isBuy: false, orderType: 'limit', size: 0.001, price: 100, takeProfit: 0.03 }, BTC,
    )).toThrow(expect.objectContaining({ code: 'ZERO_PRICE' }));
  });
});

describe('encodeMsgpack primitives', () => {
  it('positive fixint', () => {
    expect(encodeMsgpack(0).equals(Buffer.from([0x00]))).toBe(true);
    expect(encodeMsgpack(127).equals(Buffer.from([0x7f]))).toBe(true);
  });
  it('uint8 / uint16 / uint32 width selection', () => {
    expect(encodeMsgpack(128).equals(Buffer.from([0xcc, 0x80]))).toBe(true);
    expect(encodeMsgpack(256).equals(Buffer.from([0xcd, 0x01, 0x00]))).toBe(true);
    expect(encodeMsgpack(123456789).equals(Buffer.from([0xce, 0x07, 0x5b, 0xcd, 0x15]))).toBe(true);
  });
  it('bool and fixstr', () => {
    expect(encodeMsgpack(true).equals(Buffer.from([0xc3]))).toBe(true);
    expect(encodeMsgpack(false).equals(Buffer.from([0xc2]))).toBe(true);
    expect(encodeMsgpack('na').equals(Buffer.from([0xa2, 0x6e, 0x61]))).toBe(true); // fixstr len 2 + "na"
  });
  it('fixmap preserves insertion order', () => {
    // {"a":1,"b":true} -> 0x82 a1 61 01 a1 62 c3
    const got = encodeMsgpack({ a: 1, b: true });
    expect(got.equals(Buffer.from([0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0xc3]))).toBe(true);
  });
});

describe('actionHash', () => {
  it('appends the null-vault byte and hashes to the golden connectionId', () => {
    const action = { type: 'cancel', cancels: [{ a: 1, o: 123456789 }] };
    const hash = actionHash(action, null, 1784805874771);
    expect('0x' + hash.toString('hex')).toBe('0x21831e80ecfbfb90c14889317ab9b88626a52a82107527d924d1367683905086');
  });
});
