import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import {
  simulateAssetChanges,
  SwapSimulationError,
  hasSimulationRpc,
  EVM_NATIVE_SENTINEL,
} from '../swap-simulation.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const ERC1155_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ZERO = '0x0000000000000000000000000000000000000000';

const WALLET = '0x8cb9c3f23c7d600fb430bbd171a313d9ea61cebc';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const ROUTER = '0x57df6092665eb6058def53f94734a338a50f2e5f';
const NFT = '0x000000000000000000000000000000000000abcd';
const ATTACKER = '0x00000000000000000000000000000000deadbeef';

const pad = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const transferLog = (token, from, to, amount) => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data: hex(amount),
});
const approvalLog = (token, owner, spender, amount) => ({
  address: token,
  topics: [APPROVAL, pad(owner), pad(spender)],
  data: hex(amount),
});
// ERC-721 shares the Transfer signature but indexes the tokenId as a 4th topic
// (empty data). ERC-1155 TransferSingle indexes (operator, from, to).
const erc721TransferLog = (token, from, to, tokenId) => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to), pad(BigInt(tokenId).toString(16))],
  data: '0x',
});
const erc1155SingleLog = (token, operator, from, to) => ({
  address: token,
  topics: [ERC1155_SINGLE, pad(operator), pad(from), pad(to)],
  data: '0x' + '0'.repeat(128), // id + value, unread by the parser
});

function mockFetchOnce(body) {
  global.fetch = vi.fn().mockResolvedValue({
    status: 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}
function simV1(logs, { status = '0x1' } = {}) {
  return { jsonrpc: '2.0', id: 1, result: [{ calls: [{ status, logs }] }] };
}

describe('swap-simulation', () => {
  let originalBase;
  let originalFetch;
  beforeEach(() => {
    originalBase = SIMULATION_RPCS.base;
    originalFetch = global.fetch;
    SIMULATION_RPCS.base = 'http://sim.test/rpc';
  });
  afterEach(() => {
    SIMULATION_RPCS.base = originalBase;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('hasSimulationRpc', () => {
    it('reflects whether an endpoint is configured', () => {
      expect(hasSimulationRpc('base')).toBe(true);
      SIMULATION_RPCS.base = null;
      expect(hasSimulationRpc('base')).toBe(false);
      expect(hasSimulationRpc('ethereum')).toBe(false);
    });
  });

  describe('simulateAssetChanges (eth_simulateV1)', () => {
    it('parses a benign ERC-20 swap into signed per-token deltas', async () => {
      mockFetchOnce(simV1([
        transferLog(USDC, WALLET, ROUTER, 1_000_000n), // input out
        transferLog(DAI, ROUTER, WALLET, 999_000n), // output in
      ]));
      const { deltas, approvals, method } = await simulateAssetChanges(
        'base',
        { to: ROUTER, data: '0xabcd', value: '0x0' },
        { from: WALLET },
      );
      expect(method).toBe('eth_simulateV1');
      expect(deltas[USDC]).toBe(-1_000_000n);
      expect(deltas[DAI]).toBe(999_000n);
      expect(approvals).toEqual([]);
    });

    it('maps a zero-address (native ETH) transfer to the native sentinel and excludes gas', async () => {
      // traceTransfers emits native movement as a Transfer from the zero address;
      // gas is NOT a transfer log, so it never appears in the deltas.
      mockFetchOnce(simV1([
        transferLog(ZERO, WALLET, ROUTER, 1_500_000_000_000_000n), // 0.0015 ETH out
        transferLog(USDC, ROUTER, WALLET, 5_000_000n),
      ]));
      const { deltas } = await simulateAssetChanges(
        'base',
        { to: ROUTER, data: '0x', value: hex(1_500_000_000_000_000n) },
        { from: WALLET },
      );
      expect(deltas[EVM_NATIVE_SENTINEL]).toBe(-1_500_000_000_000_000n);
      expect(deltas[USDC]).toBe(5_000_000n);
    });

    it('captures approvals the wallet grants', async () => {
      mockFetchOnce(simV1([
        approvalLog(USDC, WALLET, ROUTER, 2_000_000n),
        transferLog(USDC, WALLET, ROUTER, 1_000_000n),
        transferLog(DAI, ROUTER, WALLET, 999_000n),
      ]));
      const { approvals } = await simulateAssetChanges(
        'base',
        { to: ROUTER, data: '0xabcd' },
        { from: WALLET },
      );
      expect(approvals).toEqual([{ token: USDC, spender: ROUTER, amount: 2_000_000n }]);
    });

    it('drops net-zero token deltas', async () => {
      mockFetchOnce(simV1([
        transferLog(USDC, WALLET, ROUTER, 1_000_000n),
        transferLog(USDC, ROUTER, WALLET, 1_000_000n), // net zero
        transferLog(DAI, ROUTER, WALLET, 5n),
      ]));
      const { deltas } = await simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET });
      expect(USDC in deltas).toBe(false);
      expect(deltas[DAI]).toBe(5n);
    });

    it('sends the Nansen apikey header only to a Nansen-hosted endpoint', async () => {
      SIMULATION_RPCS.base = 'https://api.nansen.ai/api/v1/trade/simulate-swap';
      mockFetchOnce(simV1([]));
      await simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET, apiKey: 'secret-key' });
      const [, opts] = global.fetch.mock.calls[0];
      expect(opts.headers.apikey).toBe('secret-key');
    });

    it('does NOT leak the apikey to a custom (non-Nansen) override RPC', async () => {
      // A NANSEN_BASE_SIM_RPC override can point at an arbitrary host; the user's
      // Nansen credential must never be forwarded there.
      SIMULATION_RPCS.base = 'http://sim.test/rpc';
      mockFetchOnce(simV1([]));
      await simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET, apiKey: 'secret-key' });
      const [, opts] = global.fetch.mock.calls[0];
      expect('apikey' in opts.headers).toBe(false);
    });

    it('flags an ERC-721 leaving the wallet as an NFT outflow', async () => {
      mockFetchOnce(simV1([
        transferLog(USDC, WALLET, ROUTER, 1_000_000n),
        transferLog(DAI, ROUTER, WALLET, 999_000n),
        erc721TransferLog(NFT, WALLET, ATTACKER, 7n), // NFT drained alongside the swap
      ]));
      const { deltas, nftOut } = await simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET });
      // The NFT is NOT folded into the fungible deltas (its tokenId is not a balance).
      expect(NFT in deltas).toBe(false);
      expect(nftOut).toEqual([{ standard: 'ERC-721', token: NFT }]);
    });

    it('flags an ERC-1155 leaving the wallet as an NFT outflow', async () => {
      mockFetchOnce(simV1([
        erc1155SingleLog(NFT, ROUTER, WALLET, ATTACKER),
      ]));
      const { nftOut } = await simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET });
      expect(nftOut).toEqual([{ standard: 'ERC-1155', token: NFT }]);
    });

    it('does not flag an inbound NFT (received, not sent)', async () => {
      mockFetchOnce(simV1([
        erc721TransferLog(NFT, ATTACKER, WALLET, 7n),
        erc1155SingleLog(NFT, ROUTER, ATTACKER, WALLET),
      ]));
      const { nftOut } = await simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET });
      expect(nftOut).toEqual([]);
    });

    it('throws SIM_REVERTED when the swap reverts in simulation', async () => {
      mockFetchOnce(simV1([], { status: '0x0' }));
      await expect(
        simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET }),
      ).rejects.toMatchObject({ code: 'SIM_REVERTED' });
    });

    it('throws NO_SIM_RPC when no endpoint is configured', async () => {
      SIMULATION_RPCS.base = null;
      await expect(
        simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET }),
      ).rejects.toMatchObject({ code: 'NO_SIM_RPC' });
    });

    it('throws SIM_RPC_ERROR on a non-JSON response', async () => {
      mockFetchOnce('<html>gateway timeout</html>');
      await expect(
        simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET }),
      ).rejects.toMatchObject({ code: 'SIM_RPC_ERROR' });
    });
  });

  describe('fallback to debug_traceCall', () => {
    it('falls back when eth_simulateV1 is unsupported and derives native from frame values', async () => {
      const calls = [];
      global.fetch = vi.fn().mockImplementation((url, opts) => {
        const req = JSON.parse(opts.body);
        calls.push(req.method);
        if (req.method === 'eth_simulateV1') {
          return Promise.resolve({
            status: 200,
            text: async () => JSON.stringify({ error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } }),
          });
        }
        // callTracer frame tree: ERC-20 output arrives via a log; native input is
        // the top-level frame value from the wallet.
        return Promise.resolve({
          status: 200,
          text: async () => JSON.stringify({
            result: {
              from: WALLET,
              to: ROUTER,
              value: hex(1_500_000_000_000_000n),
              logs: [transferLog(USDC, ROUTER, WALLET, 5_000_000n)],
              calls: [],
            },
          }),
        });
      });
      const { deltas, method } = await simulateAssetChanges(
        'base',
        { to: ROUTER, data: '0x', value: hex(1_500_000_000_000_000n) },
        { from: WALLET },
      );
      expect(calls).toEqual(['eth_simulateV1', 'debug_traceCall']);
      expect(method).toBe('debug_traceCall');
      expect(deltas[EVM_NATIVE_SENTINEL]).toBe(-1_500_000_000_000_000n);
      expect(deltas[USDC]).toBe(5_000_000n);
    });

    it('surfaces a silently-reverting sub-call as SIM_REVERTED (not an empty outcome)', async () => {
      // eth_simulateV1 unavailable → debug_traceCall. The top-level frame has no
      // error, but a sub-call reverted and nothing moved: report the revert
      // rather than returning empty deltas that fail downstream as a mismatch.
      global.fetch = vi.fn().mockImplementation((url, opts) => {
        const req = JSON.parse(opts.body);
        if (req.method === 'eth_simulateV1') {
          return Promise.resolve({ status: 200, text: async () => JSON.stringify({ error: { code: -32601, message: 'not available' } }) });
        }
        return Promise.resolve({
          status: 200,
          text: async () => JSON.stringify({
            result: { from: WALLET, to: ROUTER, value: '0x0', logs: [], calls: [{ from: ROUTER, to: USDC, value: '0x0', error: 'execution reverted', logs: [], calls: [] }] },
          }),
        });
      });
      await expect(
        simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET }),
      ).rejects.toMatchObject({ code: 'SIM_REVERTED' });
    });

    it('surfaces NOT_SIM_CAPABLE when both methods are unavailable', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ error: { code: -32601, message: 'method not found' } }),
      });
      await expect(
        simulateAssetChanges('base', { to: ROUTER, data: '0x' }, { from: WALLET }),
      ).rejects.toMatchObject({ code: 'NOT_SIM_CAPABLE' });
    });
  });

  it('SwapSimulationError carries its code', () => {
    const e = new SwapSimulationError('NO_SIM_RPC', 'nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NO_SIM_RPC');
  });
});
