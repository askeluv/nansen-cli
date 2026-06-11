/**
 * Nansen CLI - x402 Auto-Payment Handler
 * Detects 402 responses and auto-signs payment using local wallet.
 * Supports EVM (EIP-3009 on Base) and Solana (SPL TransferChecked).
 */

import { createEvmPaymentPayload, isEvmNetwork, PERMIT2_ADDRESS } from './x402-evm.js';
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
    // UTF-8 decode (not atob → Latin-1) — server sends UTF-8 bytes
    // for fields like extra.name = 'USD₮0'.
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

// ERC-20 allowance(owner, spender) selector for the Permit2 preflight.
const ALLOWANCE_SELECTOR = '0xdd62ed3e';

/**
 * Check whether `owner` has approved Permit2 to spend `token`.
 * Permit2-based payments are doomed without this one-time on-chain approval,
 * so skip those entries early instead of burning a failed verify round-trip.
 * Returns true when the allowance is unknown (RPC failure) — let the server
 * decide rather than block a possibly-valid payment.
 */
async function hasPermit2Allowance(network, token, owner) {
  const rpc = getEvmRpcUrl(network);
  if (!rpc) return true;
  try {
    const ownerArg = owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const spenderArg = PERMIT2_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const resp = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_call',
        params: [{ to: token, data: `${ALLOWANCE_SELECTOR}${ownerArg}${spenderArg}` }, 'latest'],
      }),
    });
    const data = await resp.json();
    if (typeof data.result !== 'string') return true;
    return BigInt(data.result) > 0n;
  } catch {
    return true;
  }
}

/**
 * Build a payment signature for a single requirement.
 * @returns {string|null} Base64 payment signature, or null on failure
 */
async function buildPaymentForRequirement(requirement, exported, url) {
  if (isEvmNetwork(requirement.network)) {
    if ((requirement.extra || {}).assetTransferMethod === 'permit2-exact') {
      const approved = await hasPermit2Allowance(
        requirement.network,
        requirement.asset,
        exported.evm.address,
      );
      if (!approved) {
        console.error(
          `[x402] Skipping ${requirement.network} permit2 option: wallet has not ` +
          `approved Permit2 (${PERMIT2_ADDRESS}) for token ${requirement.asset}. ` +
          `Send a one-time approve(${PERMIT2_ADDRESS}, <amount>) from the wallet to enable it.`,
        );
        return null;
      }
    }
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
 * x402 payment tokens per EVM network, matching the stablecoins the API
 * advertises in 402 `accepts` entries. `decimals` matters: USDT on BNB Smart
 * Chain uses 18 decimals, unlike the 6-decimal tokens on Base and X Layer.
 */
// RPC endpoint per supported x402 EVM network.
export const EVM_X402_RPCS = {
  'eip155:8453': CHAIN_RPCS.base,
  'eip155:196': CHAIN_RPCS.xlayer,
  'eip155:56': CHAIN_RPCS.bsc,
};

function getEvmRpcUrl(network) {
  return EVM_X402_RPCS[network] || null;
}

// Known payment tokens per network, in the order servers typically advertise
// them. A network can accept several stablecoins (BSC accepts four); `decimals`
// is per token — every BSC stablecoin is an 18-decimal BEP-20 deployment,
// unlike the 6-decimal tokens on Base and X Layer.
export const EVM_X402_TOKENS = {
  'eip155:8453': [
    { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }, // Base USDC
  ],
  'eip155:196': [
    { token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', symbol: 'USDT0', decimals: 6 }, // X Layer USDT0
  ],
  'eip155:56': [
    { token: '0xcE24439F2D9C6a2289F741120FE202248B666666', symbol: 'U', decimals: 18 }, // United Stables
    { token: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', symbol: 'USD1', decimals: 18 }, // World Liberty Financial USD
    { token: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 }, // Tether USD
    { token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 }, // Binance-Peg USD Coin
  ],
};

/**
 * Check stablecoin balance for x402 payment wallet on the given network.
 * Pass the token contract paid with (`asset`) to check that specific token;
 * otherwise the network's first known token is checked.
 * Returns `{ balance, symbol }` (USD amount + token symbol) or null if check fails.
 */
export async function checkX402Balance(network, asset = null) {
  try {
    const { listWallets, exportWallet: _exportWallet } = await import('./wallet.js');
    const wallets = listWallets();
    if (!wallets.defaultWallet) return null;

    // Find wallet addresses without needing password
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
      const balance = accounts.length === 0
        ? 0
        : parseFloat(accounts[0].account.data.parsed.info.tokenAmount.uiAmountString || '0');
      return { balance, symbol: 'USDC' };
    }

    if (network.startsWith('eip155:')) {
      // Default to Base USDC if the network is unknown so existing wallets keep working.
      const tokens = EVM_X402_TOKENS[network] || EVM_X402_TOKENS['eip155:8453'];
      const entry = (asset
        && tokens.find(t => t.token.toLowerCase() === asset.toLowerCase()))
        || tokens[0];
      const { token, symbol, decimals } = entry;
      const rpc = getEvmRpcUrl(network) || EVM_X402_RPCS['eip155:8453'];
      const addr = walletInfo.evm.replace('0x', '').toLowerCase().padStart(64, '0');
      const resp = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_call',
          params: [{ to: token, data: `0x70a08231${addr}` }, 'latest'],
        }),
      });
      const data = await resp.json();
      return { balance: parseInt(data.result, 16) / 10 ** decimals, symbol };
    }

    return null;
  } catch {
    return null;
  }
}
