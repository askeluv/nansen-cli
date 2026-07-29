import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getEvmNonce } from '../trading.js';

// evmRpcCall goes through global fetch, so stubbing fetch exercises the real
// getEvmNonce end to end.
function mockRpc({ pending, latest }) {
  return vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    const result = body.params?.[1] === 'pending' ? pending : latest;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return { ok: true, status: 200, text: async () => payload };
  });
}

const ADDR = '0x' + 'ab'.repeat(20);
let prevFetch;

beforeEach(() => {
  prevFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = prevFetch;
});

describe('getEvmNonce', () => {
  it('returns a decimal number, not a hex string', async () => {
    // The regression that wedged a real deposit: bridge.js decoded the result a
    // second time, and parseInt(20, 16) is 32 — a wallet at nonce 20 signed at
    // nonce 32, which no node can execute. It stayed invisible below nonce 10,
    // where decimal and hex digits coincide.
    globalThis.fetch = mockRpc({ pending: '0x14', latest: '0x14' });
    const nonce = await getEvmNonce('base', ADDR);
    expect(nonce).toBe(20);
    expect(typeof nonce).toBe('number');
  });

  it('returns the pending count so sequential steps can be numbered', async () => {
    // approve then deposit: the second has to be numbered after the first while
    // the first is still in the mempool.
    globalThis.fetch = mockRpc({ pending: '0x15', latest: '0x14' });
    expect(await getEvmNonce('base', ADDR)).toBe(21);
  });

  it('allows a small pending gap', async () => {
    globalThis.fetch = mockRpc({ pending: '0x16', latest: '0x14' });
    expect(await getEvmNonce('base', ADDR)).toBe(22);
  });

  it('refuses to sign past a pile of unmined transactions', async () => {
    globalThis.fetch = mockRpc({ pending: '0x20', latest: '0x14' });
    await expect(getEvmNonce('base', ADDR)).rejects.toThrow(
      /has 12 unmined transactions queued on base/,
    );
  });

  it('names the stuck nonce and the recovery command', async () => {
    globalThis.fetch = mockRpc({ pending: '0x1e', latest: '0x14' });
    let err;
    try {
      await getEvmNonce('base', ADDR);
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/next mined nonce 20, next pending 30/);
    expect(err.message).toMatch(/--nonce 20 --priority-fee/);
    // The load-balanced-RPC caveat cost a debugging session; keep it in the message.
    expect(err.message).toMatch(/do not diagnose from one endpoint/);
  });

  it('reports an unreadable nonce rather than signing on NaN', async () => {
    globalThis.fetch = mockRpc({ pending: 'garbage', latest: '0x14' });
    await expect(getEvmNonce('base', ADDR)).rejects.toThrow(/Could not read the nonce/);
  });
});
