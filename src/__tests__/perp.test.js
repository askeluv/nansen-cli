import { describe, it, expect } from 'vitest';
import { buildPerpCommands } from '../perp.js';

// These tests exercise client-side input validation only. Validation runs
// before any wallet resolution or network call, so a rejected input throws
// without needing a configured wallet.
const cmds = buildPerpCommands({ log: () => {} });

const baseOrder = {
  coin: 'ETH',
  side: 'buy',
  size: '0.01',
  price: '2000',
  type: 'limit',
  wallet: 'does-not-matter',
};

describe('perp order validation', () => {
  it('rejects a typo in --side instead of silently opening a short', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'xyz' }),
    ).rejects.toThrow(/Invalid --side "xyz"/);
  });

  it('rejects a near-miss synonym in --side', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'lng' }),
    ).rejects.toThrow(/Invalid --side/);
  });

  it('accepts long/short aliases', async () => {
    // These pass validation and fail later (no real wallet) — assert the
    // failure is NOT the side validation error.
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'long' }),
    ).rejects.not.toThrow(/Invalid --side/);
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'short' }),
    ).rejects.not.toThrow(/Invalid --side/);
  });

  it('rejects a negative --size', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, size: '-0.01' }),
    ).rejects.toThrow(/Invalid --size "-0.01"/);
  });

  it('rejects a non-numeric --size with a specific message (not the usage banner)', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, size: 'abc' }),
    ).rejects.toThrow(/Invalid --size "abc"/);
  });

  it('rejects a zero --price', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, price: '0' }),
    ).rejects.toThrow(/Invalid --price "0"/);
  });

  it('shows usage when a required arg is omitted', async () => {
    const { side, ...noSide } = baseOrder;
    void side;
    await expect(
      cmds.order([], null, {}, noSide),
    ).rejects.toThrow(/Usage: nansen perp order/);
  });
});

describe('perp close validation', () => {
  const baseClose = { coin: 'ETH', side: 'sell', size: '0.01', price: '2000', wallet: 'x' };

  it('only allows buy/sell for --side', async () => {
    await expect(
      cmds.close([], null, {}, { ...baseClose, side: 'long' }),
    ).rejects.toThrow(/Invalid --side "long"/);
  });

  it('rejects a negative --size', async () => {
    await expect(
      cmds.close([], null, {}, { ...baseClose, size: '-1' }),
    ).rejects.toThrow(/Invalid --size/);
  });
});

describe('perp leverage validation', () => {
  const baseLev = { coin: 'ETH', leverage: '3', wallet: 'x' };

  it('rejects a typo in --margin-type instead of silently switching to isolated', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, 'margin-type': 'xolated' }),
    ).rejects.toThrow(/Invalid --margin-type "xolated"/);
  });

  it('accepts cross/isolated', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, 'margin-type': 'isolated' }),
    ).rejects.not.toThrow(/Invalid --margin-type/);
  });

  it('rejects a zero --leverage with a specific message', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, leverage: '0' }),
    ).rejects.toThrow(/Invalid --leverage "0"/);
  });
});

describe('perp cancel validation', () => {
  it('rejects --oid 0 with a specific message (not the usage banner)', async () => {
    await expect(
      cmds.cancel([], null, {}, { coin: 'ETH', oid: '0', wallet: 'x' }),
    ).rejects.toThrow(/Invalid --oid "0"/);
  });
});
