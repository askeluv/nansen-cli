import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The Hyperliquid bridge withdrawal signs a server-supplied action almost
// verbatim (only the EIP-712 domain is pinned client-side). These tests cover
// the intent-binding checks that refuse to sign an action whose type, amount,
// network, or authorize-signer don't match what the user reviewed — before
// anything is broadcast. Fixtures use the real captured wire shapes (relayer
// `destination`, 6-dp `amount` string, `NonceMapping` authorize payload).

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({ defaultWallet: 'w' })),
  exportWallet: vi.fn(() => ({ evm: { privateKey: '11'.repeat(32) } })),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: 'pw', source: 'keychain' })),
}));

const ethSignTypedDataV4 = vi.fn(async () => ({ signature: '0x' + '11'.repeat(65) }));
vi.mock('../privy.js', () => ({
  PrivyClient: vi.fn().mockImplementation(function () {
    this.ethSignTypedDataV4 = ethSignTypedDataV4;
  }),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { showWallet } from '../wallet.js';
import {
  buildBridgeCommands,
  decimalToScaled,
  assertHlBridgeActionIntent,
  assertHlBridgeAuthorizeIntent,
} from '../bridge.js';

const WALLET = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';
const RELAYER = '0x66cf0aace1b4e562593bec10ec7868fba9932224';

// The real captured sendAsset action (2 USDC withdrawal, HL -> base).
function sendAssetAction(overrides = {}) {
  return {
    type: 'sendAsset',
    hyperliquidChain: 'Mainnet',
    destination: RELAYER,
    sourceDex: '',
    destinationDex: '',
    token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
    amount: '2.000000',
    fromSubAccount: '',
    nonce: 1787885079283,
    ...overrides,
  };
}

// reviewedAmountBaseUnits is HL USDC's native 8-decimal base units (200000000 == 2.0).
const BASE_INTENT = { reviewedAmountBaseUnits: '200000000', hlNetwork: 'Mainnet', signerAddress: WALLET };

describe('assertHlBridgeActionIntent', () => {
  it('passes for sendAsset, Mainnet, amount equal to reviewed', () => {
    expect(() => assertHlBridgeActionIntent(sendAssetAction(), BASE_INTENT)).not.toThrow();
  });

  it('passes when the signed amount is below reviewed (one-sided cap)', () => {
    const action = sendAssetAction({ amount: '1.000000' });
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).not.toThrow();
  });

  it('passes even though destination is the relayer, not the user (destination is deliberately not bound)', () => {
    const action = sendAssetAction({ destination: RELAYER });
    expect(action.destination).not.toBe(WALLET);
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).not.toThrow();
  });

  it('throws UNEXPECTED_ACTION for a type off the allowlist', () => {
    const action = sendAssetAction({ type: 'usdClassTransfer' });
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(/unexpected action type/);
    try {
      assertHlBridgeActionIntent(action, BASE_INTENT);
    } catch (err) {
      expect(err.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('throws AMOUNT_MISMATCH when the signed amount exceeds reviewed beyond epsilon', () => {
    const action = sendAssetAction({ amount: '20.000000' });
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(/more than the 200000000 base units/);
    try {
      assertHlBridgeActionIntent(action, BASE_INTENT);
    } catch (err) {
      expect(err.code).toBe('AMOUNT_MISMATCH');
    }
  });

  it('throws UNEXPECTED_NETWORK when hyperliquidChain is not Mainnet', () => {
    const action = sendAssetAction({ hyperliquidChain: 'Testnet' });
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(/targets Hyperliquid "Testnet"/);
    try {
      assertHlBridgeActionIntent(action, BASE_INTENT);
    } catch (err) {
      expect(err.code).toBe('UNEXPECTED_NETWORK');
    }
  });

  it('throws UNEXPECTED_NETWORK when hyperliquidChain is missing (fails closed, not open)', () => {
    const action = sendAssetAction();
    delete action.hyperliquidChain;
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(/targets Hyperliquid "undefined"/);
  });

  // Regression guard for a real bug caught in review: an earlier version skipped
  // the amount cap whenever reviewedAmountBaseUnits was missing, which let a
  // malicious response strip the anti-drain control just by omitting the one
  // field the cap depended on. The cap must fail CLOSED, not open.
  it('throws AMOUNT_MISMATCH (fails closed) when reviewedAmountBaseUnits is missing', () => {
    const action = sendAssetAction({ amount: '999.000000' });
    expect(() =>
      assertHlBridgeActionIntent(action, { ...BASE_INTENT, reviewedAmountBaseUnits: null }),
    ).toThrow(/no reviewed amount recorded/);
  });

  // Regression guard for a real bug caught in review: an earlier version only
  // applied the amount cap `if (signed != null)` — an action with the amount
  // field omitted entirely sailed through with no error at all.
  it('throws AMOUNT_MISMATCH (fails closed) when the action has no amount field', () => {
    const action = sendAssetAction();
    delete action.amount;
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(/has no amount to verify/);
  });

  // Regression guard for a real bug caught in review: only type/network/amount
  // were checked; token, dex, and sub-account fields were copied from the
  // quote unexamined, so the amount cap didn't actually mean "the requested
  // USDC amount" — a malicious quote could swap in a different token or route
  // funds via a dex/sub-account leg while keeping the amount within cap.
  it('throws UNEXPECTED_ACTION for a source token other than HL spot USDC', () => {
    const action = sendAssetAction({ token: 'USDT:0xdeadbeef' });
    expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(/unexpected source token/);
  });

  it.each(['sourceDex', 'destinationDex', 'fromSubAccount'])(
    'throws UNEXPECTED_ACTION when %s is not empty',
    (field) => {
      const action = sendAssetAction({ [field]: 'perp' });
      expect(() => assertHlBridgeActionIntent(action, BASE_INTENT)).toThrow(new RegExp(`unexpected ${field}`));
    },
  );
});

describe('assertHlBridgeAuthorizeIntent', () => {
  // The real captured NonceMapping authorize payload (from a live read-only
  // `bridge quote`, 2026-08-28) — domain, types, and value together, since
  // assertHlBridgeAuthorizeIntent now pins the whole shape, not just the
  // value's wallet/depositor fields. Note the domain name is "RelayNonceMapping"
  // (not the plainer "Relay"), and wallet/depositor are `address`, id is
  // `bytes32`, nonce is `uint256` — verified by capture, not guessed.
  const nonceMappingSign = (valueOverrides = {}) => ({
    domain: { name: 'RelayNonceMapping', version: '2', chainId: 1, verifyingContract: '0x' + '0'.repeat(40) },
    types: { NonceMapping: [
      { name: 'chainId', type: 'string' },
      { name: 'wallet', type: 'address' },
      { name: 'depositor', type: 'address' },
      { name: 'id', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' },
    ] },
    primaryType: 'NonceMapping',
    value: {
      chainId: 'hyperliquid',
      wallet: WALLET,
      depositor: WALLET,
      id: '0xae2365f8c41c422a5ceb36ceddcd94f4b72651824f0baf38c9a31c1e1bd4825f',
      nonce: 1787885079283,
      ...valueOverrides,
    },
  });

  it('passes for a genuine NonceMapping with wallet/depositor equal the signer (case-insensitive)', () => {
    const sign = nonceMappingSign({ wallet: WALLET.toLowerCase() });
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).not.toThrow();
  });

  it('throws SIGNER_MISMATCH when wallet differs from the signer', () => {
    const sign = nonceMappingSign({ wallet: '0x' + '11'.repeat(20) });
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/but the signing wallet is/);
    try {
      assertHlBridgeAuthorizeIntent(sign, WALLET);
    } catch (err) {
      expect(err.code).toBe('SIGNER_MISMATCH');
    }
  });

  it('throws SIGNER_MISMATCH when depositor differs from the signer', () => {
    const sign = nonceMappingSign({ depositor: '0x' + '22'.repeat(20) });
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/but the signing wallet is/);
  });

  it('throws SIGNER_MISMATCH when wallet/depositor fields are absent (fails closed, not open)', () => {
    const sign = nonceMappingSign();
    delete sign.value.wallet;
    delete sign.value.depositor;
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/but the signing wallet is/);
  });

  // Regression guard for a real bug caught in review: an earlier version only
  // validated `value.wallet`/`value.depositor` IF PRESENT and never looked at
  // domain/types/primaryType at all — so a malicious quote could ask the
  // wallet to sign an entirely different EIP-712 message (any non-empty type
  // list, any domain) and relay the resulting signature to a URL of its
  // choosing. Every field below must now be pinned.
  it('throws UNEXPECTED_ACTION for a primaryType other than NonceMapping', () => {
    const sign = { ...nonceMappingSign(), primaryType: 'Permit', types: { Permit: [{ name: 'value', type: 'uint256' }] } };
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/unexpected EIP-712 type "Permit"/);
    try {
      assertHlBridgeAuthorizeIntent(sign, WALLET);
    } catch (err) {
      expect(err.code).toBe('UNEXPECTED_ACTION');
    }
  });

  it('throws UNEXPECTED_ACTION for a domain name other than RelayNonceMapping', () => {
    const sign = nonceMappingSign();
    sign.domain = { ...sign.domain, name: 'SomeOtherProtocol' };
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/unexpected signing domain/);
  });

  // Regression guard for a real bug caught in a second review round: an
  // earlier version checked only domain.name, leaving version/chainId/
  // verifyingContract (and field TYPES, and field ORDER) unchecked — an
  // altered domain version or reordered/retyped fields passed silently even
  // though they change the actual EIP-712 struct hash being signed.
  it.each(['version', 'chainId', 'verifyingContract'])(
    'throws UNEXPECTED_ACTION when domain.%s is altered',
    (field) => {
      const sign = nonceMappingSign();
      sign.domain = { ...sign.domain, [field]: field === 'chainId' ? 999 : 'altered' };
      expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/unexpected signing domain/);
    },
  );

  it('throws UNEXPECTED_ACTION when the NonceMapping field set is wrong (extra or missing fields)', () => {
    const missingField = nonceMappingSign();
    missingField.types.NonceMapping = missingField.types.NonceMapping.slice(0, 4);
    expect(() => assertHlBridgeAuthorizeIntent(missingField, WALLET)).toThrow(/unexpected field set/);

    const extraField = nonceMappingSign();
    extraField.types.NonceMapping = [...extraField.types.NonceMapping, { name: 'extra', type: 'string' }];
    expect(() => assertHlBridgeAuthorizeIntent(extraField, WALLET)).toThrow(/unexpected field set/);
  });

  it('throws UNEXPECTED_ACTION when a field is reordered (order affects the EIP-712 hash)', () => {
    const sign = nonceMappingSign();
    const [first, second, ...rest] = sign.types.NonceMapping;
    sign.types.NonceMapping = [second, first, ...rest];
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/unexpected field set/);
  });

  it('throws UNEXPECTED_ACTION when a field type is altered (e.g. address swapped for string)', () => {
    const sign = nonceMappingSign();
    sign.types.NonceMapping = sign.types.NonceMapping.map(f =>
      f.name === 'wallet' ? { ...f, type: 'string' } : f,
    );
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/unexpected field set/);
  });

  it('throws UNEXPECTED_NETWORK when chainId is not "hyperliquid"', () => {
    const sign = nonceMappingSign({ chainId: 'ethereum' });
    expect(() => assertHlBridgeAuthorizeIntent(sign, WALLET)).toThrow(/targets chain "ethereum"/);
  });
});

describe('decimalToScaled', () => {
  it('is exact for whole, zero-padded, and fractional decimal strings', () => {
    expect(decimalToScaled('2', 8)).toBe(200000000n);
    expect(decimalToScaled('2.000000', 8)).toBe(200000000n);
    expect(decimalToScaled('1.97859', 8)).toBe(197859000n);
  });

  it('rejects malformed input', () => {
    expect(() => decimalToScaled('1.2.3')).toThrow(/Cannot parse amount/);
    expect(() => decimalToScaled('abc')).toThrow(/Cannot parse amount/);
  });
});

// ── End-to-end through `execute`: both sign paths guarded, nothing broadcasts ──

let tmpHome;
let prevHome;
let quotesDir;

const depositStep = (actionTypeOverride, actionOverrides = {}) => ({
  id: 'deposit',
  kind: 'transaction',
  items: [{
    data: {
      action: {
        type: actionTypeOverride ?? 'sendAsset',
        parameters: {
          hyperliquidChain: 'Mainnet',
          destination: RELAYER,
          sourceDex: '',
          destinationDex: '',
          token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
          amount: '2.000000',
          fromSubAccount: '',
          nonce: 1787885079283,
          ...actionOverrides,
        },
      },
      eip712PrimaryType: 'HyperliquidTransaction:SendAsset',
      eip712Types: {
        'HyperliquidTransaction:SendAsset': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'destination', type: 'string' },
          { name: 'sourceDex', type: 'string' },
          { name: 'destinationDex', type: 'string' },
          { name: 'token', type: 'string' },
          { name: 'amount', type: 'string' },
          { name: 'fromSubAccount', type: 'string' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      nonce: 1787885079283,
    },
  }],
});

const authorizeStep = (authorizeOverrides = {}) => ({
  id: 'authorize',
  kind: 'signature',
  items: [{
    data: {
      sign: {
        domain: { name: 'RelayNonceMapping', version: '2', chainId: 1, verifyingContract: '0x' + '0'.repeat(40) },
        types: { NonceMapping: [
          { name: 'chainId', type: 'string' },
          { name: 'wallet', type: 'address' },
          { name: 'depositor', type: 'address' },
          { name: 'id', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
        ] },
        primaryType: 'NonceMapping',
        value: {
          chainId: 'hyperliquid',
          wallet: WALLET,
          depositor: WALLET,
          id: '0xae2365f8c41c422a5ceb36ceddcd94f4b72651824f0baf38c9a31c1e1bd4825f',
          nonce: 1787885079283,
          ...authorizeOverrides,
        },
      },
      post: { endpoint: '/authorize', body: {} },
    },
  }],
});

function writeQuote(quoteId, steps, { currencyIn, requestedAmountBaseUnits, walletProvider = 'local' } = {}) {
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify({
    quoteId,
    type: 'bridge',
    originChain: 'hyperliquid',
    destinationChain: 'base',
    walletProvider,
    walletAddress: WALLET,
    requestedAmountBaseUnits: requestedAmountBaseUnits ?? '200000000',
    timestamp: Date.now(),
    response: {
      execution_type: 'hyperliquid_signature',
      request_id: 'req-hl-intent',
      details: {
        currencyIn: currencyIn ?? { amount: '200000000', amountFormatted: '2.0' },
      },
      steps,
    },
  }));
}

function api(calls) {
  return {
    request: async (endpoint, body) => {
      calls?.push({ endpoint, target_url: body?.target_url });
      if (endpoint.includes('/sanctions/screen')) {
        return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
      }
      if (endpoint.includes('/bridge/status')) return { status: 'success', destination_tx_hashes: ['0xdone'] };
      // execute proxy
      if (body?.target_url === 'https://api.hyperliquid.xyz/exchange') {
        return { success: true, data: { status: 'ok' } };
      }
      return { success: true, data: { status: 'ok' } }; // relay authorize
    },
  };
}

const execute = (quoteId, options = {}, calls) =>
  buildBridgeCommands({ log: () => {} }).execute([], api(calls), {}, { quote: quoteId, ...options });

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-hl-intent-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
  showWallet.mockReturnValue({ name: 'w', evm: WALLET, provider: 'local' });
  ethSignTypedDataV4.mockClear();
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('bridge execute — Hyperliquid action intent binding', () => {
  it('rejects an inflated sendAsset amount before signing, leaving the quote unconsumed', async () => {
    writeQuote('bridge-inflated', [depositStep(undefined, { amount: '2000.000000' })]);
    await expect(execute('bridge-inflated')).rejects.toThrow(/more than the 200000000 base units/);
    const onDisk = JSON.parse(fs.readFileSync(path.join(quotesDir, 'bridge-inflated.json'), 'utf8'));
    expect(onDisk.executedAt).toBeUndefined();
  });

  it('rejects an action type off the allowlist', async () => {
    writeQuote('bridge-bad-type', [depositStep('usdClassTransfer')]);
    await expect(execute('bridge-bad-type')).rejects.toThrow(/unexpected action type/);
  });

  it('rejects an authorize payload naming a foreign depositor', async () => {
    writeQuote('bridge-foreign-depositor', [authorizeStep({ depositor: '0x' + '99'.repeat(20) })]);
    await expect(execute('bridge-foreign-depositor')).rejects.toThrow(/but the signing wallet is/);
  });

  it('rejects an authorize step whose typed-data is not a NonceMapping, before signing', async () => {
    const step = authorizeStep();
    step.items[0].data.sign.primaryType = 'Permit';
    step.items[0].data.sign.types = { Permit: [{ name: 'value', type: 'uint256' }] };
    writeQuote('bridge-authorize-not-nonce-mapping', [step]);
    await expect(execute('bridge-authorize-not-nonce-mapping')).rejects.toThrow(/unexpected EIP-712 type "Permit"/);
  });

  // The target URL is now built entirely from a hardcoded constant and never
  // from the server-supplied endpoint (only compared against it), so an
  // absolute attacker URL, an http:// downgrade, and an unexpected path on the
  // real host are all just "doesn't match" — one check covers all three.
  it.each([
    ['an absolute attacker-controlled URL', 'https://attacker.example.com/authorize'],
    ['an http (non-TLS) downgrade of the real host', 'http://api.relay.link/authorize'],
    ['an unexpected path on the real host', 'https://api.relay.link/exfiltrate'],
  ])('rejects an authorize POST target that is %s, before signing', async (_label, endpoint) => {
    const step = authorizeStep();
    step.items[0].data.post.endpoint = endpoint;
    writeQuote('bridge-authorize-bad-endpoint', [step]);
    await expect(execute('bridge-authorize-bad-endpoint')).rejects.toThrow(/unexpected authorize endpoint/);
  });

  it('Privy path: rejects an authorize POST target outside the pinned endpoint before ethSignTypedDataV4 is called', async () => {
    const step = authorizeStep();
    step.items[0].data.post.endpoint = 'https://attacker.example.com/authorize';
    writeQuote('bridge-authorize-bad-endpoint-privy', [step], { walletProvider: 'privy' });
    showWallet.mockReturnValue({ name: 'p', evm: WALLET, provider: 'privy', privyWalletIds: { evm: 'pw-1' } });
    await expect(execute('bridge-authorize-bad-endpoint-privy')).rejects.toThrow(/unexpected authorize endpoint/);
    expect(ethSignTypedDataV4).not.toHaveBeenCalled();
  });

  it('rejects a sendAsset action missing its amount field', async () => {
    const step = depositStep();
    delete step.items[0].data.action.parameters.amount;
    writeQuote('bridge-no-amount', [step]);
    await expect(execute('bridge-no-amount')).rejects.toThrow(/has no amount to verify/);
  });

  it('rejects a sendAsset action naming an unexpected source token', async () => {
    writeQuote('bridge-bad-token', [depositStep(undefined, { token: 'USDT:0xdeadbeef' })]);
    await expect(execute('bridge-bad-token')).rejects.toThrow(/unexpected source token/);
  });

  it('rejects when the quote currencyIn does not match the persisted requested amount', async () => {
    writeQuote('bridge-quote-drift', [depositStep()], { requestedAmountBaseUnits: '999999999' });
    await expect(execute('bridge-quote-drift')).rejects.toThrow(/Quote input .* does not match the requested/);
  });

  it('rejects a malformed currencyIn.amount with a CommandError, not a raw BigInt conversion error', async () => {
    writeQuote('bridge-malformed-currency-in', [depositStep()], {
      currencyIn: { amount: '2.5e3', amountFormatted: '2.5e3' },
    });
    await expect(execute('bridge-malformed-currency-in')).rejects.toThrow(/is not a valid amount/);
  });

  it('executes a clean captured-shape withdrawal end-to-end with no false-block', async () => {
    writeQuote('bridge-clean', [authorizeStep(), depositStep()]);
    await expect(execute('bridge-clean')).resolves.toBeUndefined();
  });

  it('rejects a tampered later step in the realistic [authorize, sendAsset] order before the authorize leg is ever posted', async () => {
    writeQuote('bridge-realistic-order-inflated', [authorizeStep(), depositStep(undefined, { amount: '2000.000000' })]);
    const calls = [];
    await expect(execute('bridge-realistic-order-inflated', {}, calls)).rejects.toThrow(/more than the 200000000 base units/);
    // Preflight must reject before the authorize step (first in the array) is
    // signed and POSTed to Relay — only the sanctions screen may have run.
    expect(calls.filter(c => c.endpoint.includes('/bridge/execute'))).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(quotesDir, 'bridge-realistic-order-inflated.json'), 'utf8'));
    expect(onDisk.executedAt).toBeUndefined();
  });

  it('Privy path: rejects a tampered later step in the realistic [authorize, sendAsset] order before ethSignTypedDataV4 is ever called', async () => {
    writeQuote('bridge-realistic-order-inflated-privy', [authorizeStep(), depositStep(undefined, { amount: '2000.000000' })], {
      walletProvider: 'privy',
    });
    showWallet.mockReturnValue({
      name: 'p',
      evm: WALLET,
      provider: 'privy',
      privyWalletIds: { evm: 'pw-1' },
    });
    await expect(execute('bridge-realistic-order-inflated-privy')).rejects.toThrow(/more than the 200000000 base units/);
    expect(ethSignTypedDataV4).not.toHaveBeenCalled();
  });

  // A good step FIRST, a bad step LATER: the preflight has to check every step's
  // full pre-signing surface (not just intent binding) before any of them sign,
  // or the good first step still gets signed/posted before the later one is
  // even looked at.
  it('rejects a bad authorize endpoint on a later step, before a clean earlier deposit step is signed', async () => {
    const badAuthorize = authorizeStep();
    badAuthorize.items[0].data.post.endpoint = 'https://attacker.example.com/authorize';
    writeQuote('bridge-good-first-bad-authorize-endpoint', [depositStep(), badAuthorize]);
    const calls = [];
    await expect(execute('bridge-good-first-bad-authorize-endpoint', {}, calls)).rejects.toThrow(/unexpected authorize endpoint/);
    expect(calls.filter(c => c.endpoint.includes('/bridge/execute'))).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(quotesDir, 'bridge-good-first-bad-authorize-endpoint.json'), 'utf8'));
    expect(onDisk.executedAt).toBeUndefined();
  });

  it('Privy path: rejects a bad authorize endpoint on a later step, before a clean earlier deposit step is signed', async () => {
    const badAuthorize = authorizeStep();
    badAuthorize.items[0].data.post.endpoint = 'https://attacker.example.com/authorize';
    writeQuote('bridge-good-first-bad-authorize-endpoint-privy', [depositStep(), badAuthorize], { walletProvider: 'privy' });
    showWallet.mockReturnValue({ name: 'p', evm: WALLET, provider: 'privy', privyWalletIds: { evm: 'pw-1' } });
    await expect(execute('bridge-good-first-bad-authorize-endpoint-privy')).rejects.toThrow(/unexpected authorize endpoint/);
    expect(ethSignTypedDataV4).not.toHaveBeenCalled();
  });

  it('rejects a later deposit step missing its EIP-712 types, before a clean earlier authorize step is signed', async () => {
    const noTypesDeposit = depositStep();
    noTypesDeposit.items[0].data.eip712Types = {};
    writeQuote('bridge-good-first-missing-types', [authorizeStep(), noTypesDeposit]);
    const calls = [];
    await expect(execute('bridge-good-first-missing-types', {}, calls)).rejects.toThrow(/missing its EIP-712 type definition/);
    expect(calls.filter(c => c.endpoint.includes('/bridge/execute'))).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(quotesDir, 'bridge-good-first-missing-types.json'), 'utf8'));
    expect(onDisk.executedAt).toBeUndefined();
  });

  it('Privy path: rejects a later deposit step missing its EIP-712 types, before a clean earlier authorize step is signed', async () => {
    const noTypesDeposit = depositStep();
    noTypesDeposit.items[0].data.eip712Types = {};
    writeQuote('bridge-good-first-missing-types-privy', [authorizeStep(), noTypesDeposit], { walletProvider: 'privy' });
    showWallet.mockReturnValue({ name: 'p', evm: WALLET, provider: 'privy', privyWalletIds: { evm: 'pw-1' } });
    await expect(execute('bridge-good-first-missing-types-privy')).rejects.toThrow(/missing its EIP-712 type definition/);
    expect(ethSignTypedDataV4).not.toHaveBeenCalled();
  });

  it('Privy path: rejects an inflated amount before ethSignTypedDataV4 is called', async () => {
    writeQuote('bridge-privy-inflated', [depositStep(undefined, { amount: '2000.000000' })], {
      walletProvider: 'privy',
    });
    showWallet.mockReturnValue({
      name: 'p',
      evm: WALLET,
      provider: 'privy',
      privyWalletIds: { evm: 'pw-1' },
    });
    await expect(execute('bridge-privy-inflated')).rejects.toThrow(/more than the 200000000 base units/);
    expect(ethSignTypedDataV4).not.toHaveBeenCalled();
  });
});
