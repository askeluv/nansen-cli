import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

import { exportWallet, getWalletConfig, showWallet } from '../wallet.js';
import { retrievePassword } from '../keychain.js';
import {
  resolveEvmWallet,
  resolvePrivateKey,
  resolveSigningCredentials,
} from '../wallet-signing.js';

const ADDR = '0x' + 'ab'.repeat(20);

beforeEach(() => {
  vi.clearAllMocks();
  getWalletConfig.mockReturnValue({});
  retrievePassword.mockReturnValue({ password: null, source: null });
});

describe('resolveEvmWallet', () => {
  it('resolves the named wallet', () => {
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    expect(resolveEvmWallet('w')).toEqual({
      name: 'w',
      address: ADDR,
      provider: 'local',
      privyWalletIds: null,
    });
  });

  it('falls back to the configured default wallet', () => {
    getWalletConfig.mockReturnValue({ defaultWallet: 'main' });
    showWallet.mockReturnValue({ name: 'main', evm: ADDR, provider: 'local' });
    expect(resolveEvmWallet(undefined).name).toBe('main');
    expect(showWallet).toHaveBeenCalledWith('main');
  });

  it('reports NO_WALLET when there is nothing to resolve', () => {
    getWalletConfig.mockReturnValue({});
    expect(() => resolveEvmWallet(undefined)).toThrow(/No wallet found/);
    expect(showWallet).not.toHaveBeenCalled();
  });

  it('rejects a wallet with no EVM address, naming the feature', () => {
    // A Solana-only wallet used to reach the bridge API as wallet_address: null
    // and come back a 422.
    showWallet.mockReturnValue({ name: 'sol-only', evm: null, provider: 'local' });
    expect(() => resolveEvmWallet('sol-only', 'Bridging')).toThrow(
      /Wallet "sol-only" has no valid EVM address\. Bridging requires an EVM wallet\./,
    );
  });

  it('rejects a malformed EVM address', () => {
    showWallet.mockReturnValue({ name: 'bad', evm: '0xnothex', provider: 'local' });
    expect(() => resolveEvmWallet('bad')).toThrow(/no valid EVM address/);
  });
});

describe('resolvePrivateKey', () => {
  const wallet = { name: 'w', address: ADDR, provider: 'local' };

  it('exports with no password when the wallet is unencrypted', () => {
    getWalletConfig.mockReturnValue({});
    exportWallet.mockReturnValue({ evm: { privateKey: 'aa'.repeat(32) } });
    expect(resolvePrivateKey(wallet)).toBe('aa'.repeat(32));
    expect(exportWallet).toHaveBeenCalledWith('w', null);
  });

  it('reports PASSWORD_REQUIRED rather than "Incorrect password" when none was entered', () => {
    // The M6.1 regression: bridge.js called exportWallet(name, null), whose
    // password check reports "Incorrect password" for a password that never
    // existed — support noise pointing users at the wrong problem.
    getWalletConfig.mockReturnValue({ passwordHash: 'h' });
    retrievePassword.mockReturnValue({ password: null, source: null });
    let err;
    try {
      resolvePrivateKey(wallet);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('PASSWORD_REQUIRED');
    expect(err.message).not.toMatch(/Incorrect password/);
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('passes a retrieved password through to exportWallet', () => {
    getWalletConfig.mockReturnValue({ passwordHash: 'h' });
    retrievePassword.mockReturnValue({ password: 'pw', source: 'keychain' });
    exportWallet.mockReturnValue({ evm: { privateKey: 'bb'.repeat(32) } });
    expect(resolvePrivateKey(wallet)).toBe('bb'.repeat(32));
    expect(exportWallet).toHaveBeenCalledWith('w', 'pw');
  });
});

describe('resolveSigningCredentials', () => {
  it('returns a local key for a local wallet', () => {
    exportWallet.mockReturnValue({ evm: { privateKey: 'cc'.repeat(32) } });
    expect(resolveSigningCredentials({ name: 'w', provider: 'local' })).toEqual({
      provider: 'local',
      privateKey: 'cc'.repeat(32),
    });
  });

  it('does not try to export a Privy wallet', () => {
    expect(resolveSigningCredentials({ name: 'p', provider: 'privy' })).toEqual({
      provider: 'privy',
      privateKey: null,
    });
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('takes the resolved wallet, so it never re-reads the wallet file', () => {
    exportWallet.mockReturnValue({ evm: { privateKey: 'dd'.repeat(32) } });
    resolveSigningCredentials({ name: 'w', provider: 'local' });
    // M6.3: bridge execute resolved the wallet twice, which could pick a
    // different wallet than the one it had just screened.
    expect(showWallet).not.toHaveBeenCalled();
  });
});
