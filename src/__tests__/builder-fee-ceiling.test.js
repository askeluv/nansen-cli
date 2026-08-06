import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(() => ({ name: 'w', evm: '0x' + 'ab'.repeat(20), provider: 'local' })),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(() => ({ evm: { privateKey: '11'.repeat(32) } })),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

vi.mock('../hl-client.js', () => ({
  submitExchange: vi.fn(async () => ({ status: 'ok', response: { data: { statuses: [{ resting: {} }] } } })),
}));

import { submitExchange } from '../hl-client.js';
import { buildPerpCommands } from '../perp.js';

// M4: the builder fee arrives from the API and approveBuilderFee authorises a
// *maximum* rate on Hyperliquid, so an unbounded value would be signed as given.
// Only threat model is a compromised or misconfigured API — defence in depth.

// Stub the proxy reads the order path makes: /perp/meta, /perp/builder-fee and
// /sanctions/screen. `requiredFee` is what the ceiling is being tested against.
function makeApi({ requiredFee, approved = false }) {
  return {
    request: vi.fn(async (endpoint) => {
      if (endpoint.includes('/perp/meta')) {
        return { assets: [{ name: 'ETH', asset_id: 1, sz_decimals: 4, max_leverage: 25 }] };
      }
      if (endpoint.includes('/perp/builder-fee')) {
        return {
          approved,
          required_fee: requiredFee,
          max_fee_rate: '0.08%',
          builder_address: '0x' + 'CD'.repeat(20),
        };
      }
      if (endpoint.includes('/sanctions/screen')) {
        return { results: [{ address: '0x' + 'ab'.repeat(20), sanctioned: false }] };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    }),
  };
}

const order = { coin: 'ETH', side: 'buy', size: '0.01', price: '2000', type: 'limit', wallet: 'w' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('builder fee ceiling', () => {
  it('accepts the published rate', async () => {
    const cmds = buildPerpCommands({ log: () => {} });
    await expect(cmds.order([], makeApi({ requiredFee: 80 }), {}, { ...order })).resolves.toBeUndefined();
    expect(submitExchange).toHaveBeenCalled();
  });

  it('refuses a fee above the ceiling, before signing anything', async () => {
    const cmds = buildPerpCommands({ log: () => {} });
    let err;
    try {
      await cmds.order([], makeApi({ requiredFee: 500 }), {}, { ...order });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('BUILDER_FEE_TOO_HIGH');
    expect(err.message).toMatch(/500 tenths of a basis point/);
    // Nothing may reach Hyperliquid: not the approval, not the order.
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('refuses a negative fee', async () => {
    const cmds = buildPerpCommands({ log: () => {} });
    await expect(cmds.order([], makeApi({ requiredFee: -1 }), {}, { ...order })).rejects.toThrow(
      /builder fee/,
    );
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('catches a units slip (a rate given in percent or bps reads far out of range)', async () => {
    const cmds = buildPerpCommands({ log: () => {} });
    // 8 bps expressed as 8000 tenths-of-a-bp by mistake = 0.8%, 10x the real fee.
    await expect(cmds.order([], makeApi({ requiredFee: 8000 }), {}, { ...order })).rejects.toThrow(
      /this CLI accepts/,
    );
  });

  it('names the rate and beneficiary before signing the approval', async () => {
    const lines = [];
    const cmds = buildPerpCommands({ log: (m) => lines.push(m) });
    await cmds.order([], makeApi({ requiredFee: 80, approved: false }), {}, { ...order });
    const approval = lines.find(l => l.includes('Approving Nansen builder fee'));
    expect(approval).toMatch(/max 0\.08%/);
    expect(approval).toMatch(new RegExp('0x' + 'cd'.repeat(20)));
  });

  it('skips the approval when the wallet has already approved', async () => {
    const lines = [];
    const cmds = buildPerpCommands({ log: (m) => lines.push(m) });
    await cmds.order([], makeApi({ requiredFee: 80, approved: true }), {}, { ...order });
    expect(lines.some(l => l.includes('Approving Nansen builder fee'))).toBe(false);
    // Just the order, no approval action.
    expect(submitExchange).toHaveBeenCalledTimes(1);
  });
});
