/**
 * x402 Auto-Payment via Open Wallet Standard (OWS)
 *
 * Detects locally-installed OWS wallets and uses them for x402 payment signing.
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
      return _sdkCache;
    } catch {
      continue;
    }
  }

  _sdkCache = null;
  return null;
}

/** Reset cached SDK (for testing). */
export function _resetSdkCache() {
  _sdkCache = undefined;
  _sdkResolved = false;
}

/**
 * Find an OWS wallet to use for x402 payments.
 * Checks OWS_WALLET env var first, then picks the first wallet with EVM + Solana accounts.
 */
export function findOwsWallet(sdk) {
  const envWallet = process.env.OWS_WALLET;

  if (envWallet) {
    try {
      return extractAddresses(sdk.getWallet(envWallet));
    } catch {
      return null;
    }
  }

  try {
    for (const wallet of sdk.listWallets()) {
      const result = extractAddresses(wallet);
      if (result) return result;
    }
  } catch {
    // OWS SDK not functional
  }

  return null;
}

function extractAddresses(wallet) {
  if (!wallet?.accounts) return null;
  const evmAccount = wallet.accounts.find(a => a.chainId.startsWith('eip155:'));
  const solAccount = wallet.accounts.find(a => a.chainId.startsWith('solana:'));
  if (!evmAccount || !solAccount) return null;
  return {
    name: wallet.name,
    evmAddress: evmAccount.address,
    solanaAddress: solAccount.address,
  };
}

async function buildOwsEvmPayment({ requirement, sdk, walletName, address, passphrase, url }) {
  const typedData = buildEIP712TypedData({ fromAddress: address, requirement });

  // OWS returns 65-byte hex (r + s + v) where v = 27 + recoveryId
  const signResult = sdk.signTypedData(walletName, 'evm', JSON.stringify(typedData), passphrase);
  const signature = signResult.signature.startsWith('0x')
    ? signResult.signature
    : '0x' + signResult.signature;

  const authorization = {
    from: address,
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

async function buildOwsSvmPayment({ requirement, sdk, walletName, address, passphrase, url }) {
  const rpcUrl = getSolanaRpcUrl(requirement.network);
  const recentBlockhash = await fetchRecentBlockhash(rpcUrl);
  const { txBase64 } = buildUnsignedSvmTransaction(requirement, address, recentBlockhash);

  // OWS signTransaction accepts full tx bytes — it internally calls extract_signable_bytes
  // to strip the header + signature slots and signs only the message portion.
  const txBytes = Buffer.from(txBase64, 'base64');
  const signResult = sdk.signTransaction(walletName, 'solana', txBytes.toString('hex'), passphrase);

  // Place signature at slot 1 (client). Slot 0 (facilitator) stays zeros.
  // Layout: [compact-u16(2)] [64B slot 0] [64B slot 1] [message...]
  const rawSigHex = signResult.signature.startsWith('0x')
    ? signResult.signature.slice(2)
    : signResult.signature;
  const sigBytes = Buffer.from(rawSigHex, 'hex');
  if (sigBytes.length !== 64) throw new Error(`Expected 64-byte ed25519 signature, got ${sigBytes.length}`);
  sigBytes.copy(txBytes, 1 + 64);

  const payload = {
    x402Version: 2,
    payload: { transaction: txBytes.toString('base64') },
    accepted: requirement,
    resource: { url, description: '', mimeType: '' },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Generate payment signatures using OWS wallets, in priority order (EVM first, then Solana).
 * Same async-generator contract as createPaymentSignatures() in x402.js.
 */
export async function* createOwsPaymentSignatures(response, url) {
  const requirements = parsePaymentRequirements(response);
  if (!requirements || requirements.length === 0) return;

  const sdk = loadOwsSdk();
  if (!sdk) return;

  const wallet = findOwsWallet(sdk);
  if (!wallet) return;

  const passphrase = process.env.OWS_PASSPHRASE || null;

  const ranked = [
    ...requirements.filter(r => isEvmNetwork(r.network)),
    ...requirements.filter(r => isSvmNetwork(r.network)),
  ];

  for (const req of ranked) {
    try {
      let header;
      const opts = { requirement: req, sdk, walletName: wallet.name, passphrase, url };
      if (isEvmNetwork(req.network)) {
        header = await buildOwsEvmPayment({ ...opts, address: wallet.evmAddress });
      } else if (isSvmNetwork(req.network)) {
        header = await buildOwsSvmPayment({ ...opts, address: wallet.solanaAddress });
      }
      if (header) yield { signature: header, network: req.network };
    } catch {
      continue;
    }
  }
}
