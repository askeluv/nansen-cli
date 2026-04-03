/**
 * x402 Auto-Payment via Open Wallet Standard (OWS)
 *
 * Detects locally-installed OWS wallets and uses them for x402 payment signing.
 * EVM: EIP-712 typed data signing (EIP-3009 TransferWithAuthorization)
 * Solana: SPL TransferChecked transaction signing
 *
 * OWS never exposes private keys — signing happens inside the OWS vault.
 */

import { createRequire } from 'module';
import { parsePaymentRequirements } from './x402.js';
import { isEvmNetwork } from './x402-evm.js';
import {
  isSvmNetwork,
  getSolanaRpcUrl,
  fetchRecentBlockhash,
  buildUnsignedSvmTransaction,
} from './x402-svm.js';
import {
  buildEIP712TypedData,
  buildPaymentSignatureHeader,
} from './walletconnect-x402.js';

// ---------------------------------------------------------------------------
// SDK Loading
// ---------------------------------------------------------------------------

const GLOBAL_NODE_PATHS = [
  '/opt/homebrew/lib/node_modules/',
  '/usr/local/lib/node_modules/',
];

let _sdkCache;
let _sdkResolved = false;

/**
 * Try to load @open-wallet-standard/core from global node_modules.
 * Returns the SDK object or null if OWS is not installed.
 */
export function loadOwsSdk() {
  if (_sdkResolved) return _sdkCache;
  _sdkResolved = true;

  for (const basePath of GLOBAL_NODE_PATHS) {
    try {
      const require = createRequire(basePath);
      _sdkCache = require('@open-wallet-standard/core');
      if (process.env.DEBUG) console.error(`[ows] Loaded SDK from ${basePath}`);
      return _sdkCache;
    } catch {
      continue;
    }
  }

  if (process.env.DEBUG) console.error('[ows] SDK not found in global node_modules');
  _sdkCache = null;
  return null;
}

/** Reset cached SDK (for testing). */
export function _resetSdkCache() {
  _sdkCache = undefined;
  _sdkResolved = false;
}

// ---------------------------------------------------------------------------
// Wallet Resolution
// ---------------------------------------------------------------------------

/**
 * Find an OWS wallet to use for x402 payments.
 * Checks OWS_WALLET env var first, then picks the first wallet with EVM + Solana accounts.
 *
 * @returns {{ name: string, evmAddress: string, solanaAddress: string }} or null
 */
export function findOwsWallet(sdk) {
  const envWallet = process.env.OWS_WALLET;

  if (envWallet) {
    try {
      const wallet = sdk.getWallet(envWallet);
      return extractAddresses(wallet);
    } catch {
      if (process.env.DEBUG) console.error(`[ows] Wallet "${envWallet}" not found`);
      return null;
    }
  }

  try {
    const wallets = sdk.listWallets();
    for (const wallet of wallets) {
      const result = extractAddresses(wallet);
      if (result) return result;
    }
  } catch {
    return null;
  }

  return null;
}

function extractAddresses(wallet) {
  if (!wallet || !wallet.accounts) return null;
  const evmAccount = wallet.accounts.find(a => a.chainId.startsWith('eip155:'));
  const solAccount = wallet.accounts.find(a => a.chainId.startsWith('solana:'));
  if (!evmAccount || !solAccount) return null;
  return {
    name: wallet.name,
    evmAddress: evmAccount.address,
    solanaAddress: solAccount.address,
  };
}

// ---------------------------------------------------------------------------
// Passphrase
// ---------------------------------------------------------------------------

function resolveOwsPassphrase() {
  return process.env.OWS_PASSPHRASE || null;
}

// ---------------------------------------------------------------------------
// EVM Payment (EIP-712 typed data → EIP-3009)
// ---------------------------------------------------------------------------

async function buildOwsEvmPayment(requirement, sdk, walletName, evmAddress, passphrase, url) {
  const typedData = buildEIP712TypedData({ fromAddress: evmAddress, requirement });

  const signResult = sdk.signTypedData(
    walletName,
    'evm',
    JSON.stringify(typedData),
    passphrase,
  );

  // OWS returns 65-byte hex (r + s + v) where v = 27 + recoveryId
  const signature = signResult.signature.startsWith('0x')
    ? signResult.signature
    : '0x' + signResult.signature;

  const authorization = {
    from: evmAddress,
    to: requirement.payTo,
    value: (requirement.amount || requirement.maxAmountRequired).toString(),
    validAfter: typedData.message.validAfter.toString(),
    validBefore: typedData.message.validBefore.toString(),
    nonce: typedData.message.nonce,
  };

  return buildPaymentSignatureHeader({
    signature,
    authorization,
    resource: { url, description: '', mimeType: '' },
    accepted: requirement,
  });
}

// ---------------------------------------------------------------------------
// Solana Payment (SPL TransferChecked)
// ---------------------------------------------------------------------------

async function buildOwsSvmPayment(requirement, sdk, walletName, solAddress, passphrase, url) {
  const rpcUrl = getSolanaRpcUrl(requirement.network);
  const recentBlockhash = await fetchRecentBlockhash(rpcUrl);

  const { txBase64 } = buildUnsignedSvmTransaction(
    requirement,
    solAddress,
    recentBlockhash,
  );

  const txHex = Buffer.from(txBase64, 'base64').toString('hex');

  const signResult = sdk.signTransaction(
    walletName,
    'solana',
    txHex,
    passphrase,
  );

  // Place OWS signature at slot 1 (client slot) in the transaction.
  // Tx layout: [1 byte compact-u16(2)] [64 bytes facilitator slot 0] [64 bytes client slot 1] [message...]
  const txBytes = Buffer.from(txBase64, 'base64');
  const sigBytes = Buffer.from(signResult.signature, 'hex');
  sigBytes.copy(txBytes, 1 + 64); // slot 1 starts at offset 65

  const payload = {
    x402Version: 2,
    payload: { transaction: txBytes.toString('base64') },
    accepted: requirement,
    resource: { url },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// ---------------------------------------------------------------------------
// Main Generator
// ---------------------------------------------------------------------------

/**
 * Generate payment signatures using OWS wallets, in priority order (EVM first, then Solana).
 * Same async-generator contract as createPaymentSignatures() in x402.js.
 *
 * @param {Response} response - The 402 HTTP response
 * @param {string} url - The original request URL
 * @yields {{ signature: string, network: string }}
 */
export async function* createOwsPaymentSignatures(response, url) {
  const requirements = parsePaymentRequirements(response);
  if (!requirements || requirements.length === 0) return;

  const sdk = loadOwsSdk();
  if (!sdk) return;

  const wallet = findOwsWallet(sdk);
  if (!wallet) return;

  const passphrase = resolveOwsPassphrase();

  // Rank: EVM first (gasless for client), then Solana
  const ranked = [
    ...requirements.filter(r => isEvmNetwork(r.network)),
    ...requirements.filter(r => isSvmNetwork(r.network)),
  ];

  for (const req of ranked) {
    try {
      let header;
      if (isEvmNetwork(req.network)) {
        header = await buildOwsEvmPayment(req, sdk, wallet.name, wallet.evmAddress, passphrase, url);
      } else if (isSvmNetwork(req.network)) {
        header = await buildOwsSvmPayment(req, sdk, wallet.name, wallet.solanaAddress, passphrase, url);
      }
      if (header) yield { signature: header, network: req.network };
    } catch (err) {
      if (process.env.DEBUG) console.error(`[ows] Signing failed for ${req.network}: ${err.message}`);
      continue;
    }
  }
}
