import { describe, it, expect } from 'vitest';

import { assertEvmBridgeStepIntent, preflightEvmBridgeSteps } from '../bridge.js';
import { encodeApproveCalldata } from '../trade-validation.js';

// Real captured shapes (base -> hyperliquid, USDC): the Relay router is both
// the approve spender and the deposit `to`, and the deposit call decodes to a
// fixed 4-arg layout (depositor, token, amount, id). See the deposit-leg
// hardening plan for how these were captured (read-only quotes, no funds moved).

const ROUTER = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SIGNER = '0x8cb9c3f23c7d600fb430bbd171a313d9ea61cebc';
const ATTACKER = '0x' + 'ee'.repeat(20);
const MAX_UINT256 = (1n << 256n) - 1n;

const word = h => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const depositCalldata = ({ depositor = SIGNER, token = USDC, amount = 2000000n, id = '0x'.padEnd(66, 'a') } = {}) =>
  '0xe8017952' + word(depositor) + word(token) + word(amount.toString(16)) + word(id);

const approveCalldata = (spender, amount) => '0x095ea7b3' + word(spender) + word(amount.toString(16));

const intent = { chain: 'base', signerAddress: SIGNER, requestedAmountBaseUnits: '2000000' };

describe('assertEvmBridgeStepIntent — approve leg', () => {
  it('refuses an approve sent to a contract other than the origin chain USDC', () => {
    // A spender==ROUTER and amount<=requested calldata that targets some other
    // ERC-20 the wallet holds would otherwise look "safe" by AC1's spender/amount
    // checks alone — the approve's own `to` must also be pinned.
    const otherToken = '0x' + 'cd'.repeat(20);
    const txData = { to: otherToken, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected contract/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('refuses approve(attacker, MAX_UINT256)', () => {
    const txData = { to: USDC, data: approveCalldata(ATTACKER, MAX_UINT256), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected spender/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('refuses approve(ROUTER, MAX_UINT256) — proves the MAX guard, not just the spender guard', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, MAX_UINT256), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unlimited/);
  });

  it('refuses an approve amount over the requested cap', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000001n), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/exceeds the request's maximum input/);
  });

  it('re-encodes a valid approve at exactly the requested cap', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    const { data } = assertEvmBridgeStepIntent(txData, intent);
    expect(data).toBe(encodeApproveCalldata(ROUTER, 2000000n, { maxAllowance: 2000000n }));
    expect(data.length).toBe(138);
  });

  it('refuses when no reviewed amount was recorded to cap against', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    const noAnchor = { ...intent, requestedAmountBaseUnits: null };
    expect(() => assertEvmBridgeStepIntent(txData, noAnchor)).toThrow(/AMOUNT_MISMATCH|no reviewed amount/);
    try {
      assertEvmBridgeStepIntent(txData, noAnchor);
    } catch (e) {
      expect(e.code).toBe('AMOUNT_MISMATCH');
    }
  });
});

describe('assertEvmBridgeStepIntent — deposit leg', () => {
  it('refuses a deposit sent to an unexpected `to`', () => {
    const txData = { to: ATTACKER, data: depositCalldata(), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected contract/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('refuses the real `to` with an unexpected selector', () => {
    const txData = { to: ROUTER, data: '0xdeadbeef' + word(SIGNER), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected method/);
  });

  it('accepts a valid deposit unchanged', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0' };
    const { data } = assertEvmBridgeStepIntent(txData, intent);
    expect(data).toBe(txData.data);
  });

  it('refuses when arg0 (depositor) is redirected away from the signer', () => {
    const txData = { to: ROUTER, data: depositCalldata({ depositor: ATTACKER }), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/SIGNER_MISMATCH|signing wallet/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('SIGNER_MISMATCH');
    }
  });

  it('refuses when arg1 (token) is not the origin chain USDC', () => {
    const otherToken = '0x' + 'ab'.repeat(20);
    const txData = { to: ROUTER, data: depositCalldata({ token: otherToken }), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected token/);
  });

  it('refuses when arg2 (amount) exceeds what was requested', () => {
    const txData = { to: ROUTER, data: depositCalldata({ amount: 2000001n }), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/more than the 2000000 base units/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('AMOUNT_MISMATCH');
    }
  });

  it('accepts arg2 exactly at the requested amount', () => {
    const txData = { to: ROUTER, data: depositCalldata({ amount: 2000000n }), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).not.toThrow();
  });

  it('refuses when no reviewed amount was recorded to check the deposit against', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0' };
    const noAnchor = { ...intent, requestedAmountBaseUnits: null };
    expect(() => assertEvmBridgeStepIntent(txData, noAnchor)).toThrow(/AMOUNT_MISMATCH|no reviewed amount/);
  });
});

describe('assertEvmBridgeStepIntent — cross-cutting', () => {
  it('refuses a non-zero native value on an approve step', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0x1' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/non-zero native value/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('refuses a non-zero native value on a deposit step', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0x1' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/non-zero native value/);
  });

  it('refuses missing transaction data', () => {
    expect(() => assertEvmBridgeStepIntent({ to: ROUTER }, intent)).toThrow(/no transaction data/);
    try {
      assertEvmBridgeStepIntent({ to: ROUTER }, intent);
    } catch (e) {
      expect(e.code).toBe('INVALID_INPUT');
    }
  });

  it('refuses a deposit-selector call with malformed (wrong-length) calldata', () => {
    const txData = { to: ROUTER, data: '0xe8017952' + word(SIGNER), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/malformed deposit calldata/);
    try {
      assertEvmBridgeStepIntent(txData, intent);
    } catch (e) {
      expect(e.code).toBe('INVALID_INPUT');
    }
  });
});

describe('preflightEvmBridgeSteps — plan-level bound', () => {
  const approveStep = () => ({
    id: 'approve',
    items: [{ status: 'incomplete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }],
  });
  const depositStep = () => ({
    id: 'deposit',
    items: [{ status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } }],
  });

  it('accepts the legitimate [approve, deposit] plan', () => {
    expect(() => preflightEvmBridgeSteps([approveStep(), depositStep()], intent)).not.toThrow();
  });

  it('accepts a deposit-only plan (no approve needed)', () => {
    expect(() => preflightEvmBridgeSteps([depositStep()], intent)).not.toThrow();
  });

  it('refuses a plan that repeats [approve, deposit] to amplify past the cap', () => {
    // Every item passes per-item binding (spender/router/token/amount all valid),
    // but two deposits of `requested` each would pull 2x what the user reviewed —
    // ERC-20 approve overwrites the allowance, so the second pair drains again.
    const plan = [approveStep(), depositStep(), approveStep(), depositStep()];
    expect(() => preflightEvmBridgeSteps(plan, intent)).toThrow(/at most one of each/);
    try {
      preflightEvmBridgeSteps(plan, intent);
    } catch (e) {
      expect(e.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('refuses a plan with two deposits sharing one approve', () => {
    expect(() => preflightEvmBridgeSteps([approveStep(), depositStep(), depositStep()], intent))
      .toThrow(/at most one of each/);
  });

  it('refuses multiple approve/deposit items bundled in a single step', () => {
    const bundled = {
      id: 'bundle',
      items: [
        { status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } },
        { status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } },
      ],
    };
    expect(() => preflightEvmBridgeSteps([bundled], intent)).toThrow(/at most one of each/);
  });

  it('does not count already-complete (resumed) items toward the bound', () => {
    // A resumed plan may carry a completed approve/deposit plus the remaining
    // leg; the completed ones are skipped for signing, so they must not trip the
    // amplification guard.
    const resumed = [
      { id: 'approve', items: [{ status: 'complete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }] },
      { id: 'approve2', items: [{ status: 'incomplete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }] },
      depositStep(),
    ];
    expect(() => preflightEvmBridgeSteps(resumed, intent)).not.toThrow();
  });
});
