/**
 * Nansen CLI — shared wallet resolution for the money paths (perp, bridge).
 *
 * Every command that signs needs the same three things: the wallet's EVM
 * address, a clear error when the wallet is encrypted but no password reached
 * us, and the signing material (a local private key, or a Privy handle).
 *
 * These lived twice — once in perp.js, once in bridge.js — and the copies had
 * already drifted: perp.js grew an explicit PASSWORD_REQUIRED error while
 * bridge.js kept calling exportWallet(name, null), which reports "Incorrect
 * password" for a password that was never entered. One copy means the next fix
 * can't land on one path and miss the other.
 */

import { CommandError } from './api.js';
import { retrievePassword } from './keychain.js';
import { exportWallet, getWalletConfig, showWallet } from './wallet.js';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Resolve --wallet (or the configured default) to a wallet with a usable EVM
// address. `context` names the feature in the error so the message stays
// actionable ("Hyperliquid perp trading requires an EVM wallet").
//
// Returns the resolved name alongside the address so callers can hand the same
// resolution to resolveSigningCredentials instead of looking the wallet up a
// second time — a second lookup can read a different wallet if the default
// changed in between, and it re-reads the wallet file for no reason.
export function resolveEvmWallet(walletName, context = 'This command') {
  const config = getWalletConfig();
  const name = walletName || config.defaultWallet;
  const wallet = name ? showWallet(name) : undefined;
  if (!wallet) {
    throw new CommandError('No wallet found. Create one with: nansen wallet create', 'NO_WALLET');
  }
  if (!wallet.evm || !EVM_ADDRESS_RE.test(wallet.evm)) {
    throw new CommandError(
      `Wallet "${wallet.name || name}" has no valid EVM address. ${context} requires an EVM wallet.`,
      'INVALID_WALLET',
    );
  }
  return {
    name: wallet.name || name,
    address: wallet.evm,
    provider: wallet.provider || 'local',
    privyWalletIds: wallet.privyWalletIds || null,
  };
}

// The local private key for an already-resolved wallet.
export function resolvePrivateKey(wallet) {
  const config = getWalletConfig();
  let password = null;
  if (config.passwordHash) {
    const { password: pw, source } = retrievePassword();
    if (source === 'file') {
      process.stderr.write('⚠️  Password loaded from ~/.nansen/wallets/.credentials (insecure).\n');
    }
    password = pw;
    // Distinguish "no password reached us" from "wrong password": without this,
    // exportWallet(name, null) fails with the misleading "Incorrect password"
    // even though nothing was entered. Mirror trade/limit-order's
    // PASSWORD_REQUIRED.
    if (!password) {
      throw new CommandError('Wallet is encrypted and no password was found.', 'PASSWORD_REQUIRED', {
        error: 'PASSWORD_REQUIRED',
        message: 'Wallet is encrypted and no password was found.',
        resolution: [
          'Set NANSEN_WALLET_PASSWORD environment variable',
          'Or run: nansen wallet create (password is saved to OS keychain automatically)',
        ],
      });
    }
  }
  const exported = exportWallet(wallet.name, password);
  return exported.evm.privateKey;
}

// Signing material for an already-resolved wallet. Privy wallets have no
// exportable key — the caller signs through the Privy client instead, using the
// privyWalletIds already on `wallet`.
export function resolveSigningCredentials(wallet) {
  if (wallet.provider === 'privy') {
    return { provider: 'privy', privateKey: null };
  }
  return { provider: 'local', privateKey: resolvePrivateKey(wallet) };
}
