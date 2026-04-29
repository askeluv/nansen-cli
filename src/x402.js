/**
 * Nansen CLI - x402 Auto-Payment Handler
 * Detects 402 responses and auto-signs payment using local wallet.
 * Supports EVM (EIP-3009 on Base) and Solana (SPL TransferChecked).
 */

import { createEvmPaymentPayload, isEvmNetwork } from './x402-evm.js';
import {
  createSvmPaymentPayload,
  isSvmNetwork,
  fetchRecentBlockhash,
  getSolanaRpcUrl,
} from './x402-svm.js';
import { resolvePassword } from './keychain.js';
import { CHAIN_RPCS } from './rpc-urls.js';

/**
 * Parse PaymentRequirements from a 402 response.
 * @param {Response} response - The 402 HTTP response
 * @returns {object|null} Parsed requirements or null
 */
export function parsePaymentRequirements(response) {
  const header = response.headers.get('payment-required');
  if (!header) return null;

  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    // V2 format: { accepts: [...], ... }
    if (decoded.accepts && Array.isArray(decoded.accepts)) {
      return decoded.accepts;
    }
    // Can be a single object or array of requirements
    return Array.isArray(decoded) ? decoded : [decoded];
  } catch {
    return null;
  }
}

/**
 * Rank payment requirements. Prefers EVM (gasless) over Solana.
 * Returns all supported requirements in priority order.
 */
function rankRequirements(requirements) {
  const ranked = [];
  // EVM first (gasless for client)
  for (const r of requirements) {
    if (isEvmNetwork(r.network)) ranked.push(r);
  }
  // Then Solana
  for (const r of requirements) {
    if (isSvmNetwork(r.network)) ranked.push(r);
  }
  return ranked;
}

/**
 * Build a payment signature for a single requirement.
 * @returns {string|null} Base64 payment signature, or null on failure
 */
async function buildPaymentForRequirement(requirement, exported, url) {
  if (isEvmNetwork(requirement.network)) {
    return createEvmPaymentPayload(
      requirement,
      exported.evm.privateKey,
      exported.evm.address,
      url,
    );
  }

  if (isSvmNetwork(requirement.network)) {
    const rpcUrl = getSolanaRpcUrl(requirement.network);
    const blockhash = await fetchRecentBlockhash(rpcUrl);
    return createSvmPaymentPayload(
      requirement,
      exported.solana.privateKey,
      exported.solana.address,
      url,
      blockhash,
    );
  }

  return null;
}

/**
 * Generate payment signatures for all viable payment options, in priority order.
 * Yields { signature, network } objects. Caller should try each until one succeeds.
 *
 * @param {Response} response - The 402 HTTP response
 * @param {string} url - The original request URL
 * @param {object} options - { password, walletName }
 * @returns {AsyncGenerator<{ signature: string, network: string }>}
 */
export async function* createPaymentSignatures(response, url, options = {}) {
  const requirements = parsePaymentRequirements(response);
  if (!requirements || requirements.length === 0) return;

  const ranked = rankRequirements(requirements);
  if (ranked.length === 0) return;

  let exportWallet, listWallets, getWalletConfig;
  try {
    const walletMod = await import('./wallet.js');
    exportWallet = walletMod.exportWallet;
    listWallets = walletMod.listWallets;
    getWalletConfig = walletMod.getWalletConfig;
  } catch {
    return;
  }

  const walletConfig = getWalletConfig();
  const password = walletConfig.passwordHash
    ? (options.password || resolvePassword() || null)
    : null;
  if (walletConfig.passwordHash && password === null) return;

  const wallets = listWallets();
  if (wallets.wallets.length === 0) return;

  const walletName = options.walletName || wallets.defaultWallet;
  if (!walletName) return;

  let exported;
  try {
    exported = exportWallet(walletName, password);
  } catch {
    return;
  }

  for (const req of ranked) {
    try {
      const sig = await buildPaymentForRequirement(req, exported, url);
      if (sig) yield { signature: sig, network: req.network, asset: req.asset };
    } catch {
      // This payment option failed to build, try next
      continue;
    }
  }
}

/**
 * Attempt to auto-pay a 402 response (single-shot, returns first viable signature).
 * For fallback support, use createPaymentSignatures() instead.
 *
 * @param {Response} response - The 402 HTTP response
 * @param {string} url - The original request URL
 * @param {object} options - { password, walletName }
 * @returns {string|null} Payment-Signature header value, or null if can't pay
 */
export async function createPaymentSignature(response, url, options = {}) {
  for await (const { signature } of createPaymentSignatures(response, url, options)) {
    return signature;
  }
  return null;
}

/**
 * Map EVM chainId to RPC URL for balance checks.
 */
const CHAIN_ID_TO_RPC = {
  8453: () => CHAIN_RPCS.base,
  196:  () => CHAIN_RPCS.xlayer,
};

/**
 * Check stablecoin balance for x402 payment wallet.
 * Returns balance in USD (number) or null if check fails.
 *
 * @param {string} network - CAIP-2 network, e.g. "eip155:8453" or "solana:..."
 * @param {string} [asset] - Token contract address. EVM only: falls back to Base USDC if omitted.
 */
export async function checkX402Balance(network, asset) {
  try {
    const { listWallets, exportWallet: _exportWallet } = await import('./wallet.js');
    const wallets = listWallets();
    if (!wallets.defaultWallet) return null;

    const walletInfo = wallets.wallets.find(w => w.name === wallets.defaultWallet);
    if (!walletInfo) return null;

    if (network.startsWith('solana:')) {
      const { getSolanaRpcUrl } = await import('./x402-svm.js');
      const rpcUrl = getSolanaRpcUrl(network);
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenAccountsByOwner',
          params: [walletInfo.solana, { mint: USDC_MINT }, { encoding: 'jsonParsed' }],
        }),
      });
      const data = await resp.json();
      const accounts = data.result?.value || [];
      if (accounts.length === 0) return 0;
      return parseFloat(accounts[0].account.data.parsed.info.tokenAmount.uiAmountString || '0');
    }

    if (network.startsWith('eip155:')) {
      const chainId = parseInt(network.split(':')[1], 10);
      const rpcGetter = CHAIN_ID_TO_RPC[chainId];
      if (!rpcGetter) return null;
      const rpcUrl = rpcGetter();

      const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
      const tokenAddress = asset || USDC_BASE;
      const addr = walletInfo.evm.replace('0x', '').toLowerCase().padStart(64, '0');
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_call',
          params: [{ to: tokenAddress, data: `0x70a08231${addr}` }, 'latest'],
        }),
      });
      const data = await resp.json();
      return parseInt(data.result, 16) / 1e6;
    }

    return null;
  } catch {
    return null;
  }
}
