/**
 * WalletConnect Trading & Transfer Support
 *
 * Allows signing and broadcasting transactions via a WalletConnect-connected wallet
 * (hardware wallets, mobile wallets) instead of local key storage.
 * Uses the walletconnect CLI binary (subprocess-based, same as x402).
 *
 * Supports EVM chains and Solana (trading only).
 */

import { wcExec } from './walletconnect-exec.js';
import { base58Encode } from './wallet.js';

const SOLANA_MAINNET_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * Extract the first JSON line from walletconnect CLI output.
 * The CLI may print status messages before the JSON result.
 */
function parseWcJson(output) {
  const lines = output.split('\n');
  const startIdx = lines.findIndex(l => l.trimStart().startsWith('{'));
  if (startIdx === -1) throw new Error('No JSON output from walletconnect');

  // Handle multi-line JSON: collect lines until braces balance
  let braces = 0;
  const jsonLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    jsonLines.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
    }
    if (braces === 0) break;
  }
  return JSON.parse(jsonLines.join('\n'));
}

/**
 * Get the address of the connected WalletConnect wallet.
 * Returns the first account address, or null if not connected / binary missing.
 *
 * @param {string} [chainType] - Optional: 'evm' or 'solana'. Filters accounts by chain prefix.
 *   No arg = first account (backward compat).
 */
export async function getWalletConnectAddress(chainType) {
  try {
    const output = await wcExec('walletconnect', ['whoami', '--json'], 3000);
    const data = JSON.parse(output);
    if (data.connected === false) return null;
    const accounts = data.accounts || [];
    if (!accounts.length) return null;

    if (chainType === 'solana') {
      // Match Solana mainnet only — reject devnet/testnet to prevent wrong-network trades
      const solAccount = accounts.find(a => a.chain === SOLANA_MAINNET_CHAIN);
      return solAccount?.address || null;
    }
    if (chainType === 'evm') {
      const evmAccount = accounts.find(a => a.chain?.startsWith('eip155:'));
      return evmAccount?.address || null;
    }
    // No filter — return first account address (backward compat)
    return accounts[0]?.address || null;
  } catch {
    return null;
  }
}

/**
 * Send a transaction via WalletConnect.
 *
 * The connected wallet signs and may broadcast the transaction.
 * Returns either { txHash } (wallet broadcast) or { signedTransaction } (we broadcast).
 *
 * @param {object} txData - Transaction data: { to, data, value, gas, chainId }
 * @param {number} [timeoutMs=120000] - Timeout for user approval
 * @returns {{ txHash?: string, signedTransaction?: string }}
 */
export async function sendTransactionViaWalletConnect(txData, timeoutMs = 120000) {
  // The walletconnect CLI expects chainId as "eip155:<id>" string format
  const chainId = txData.chainId
    ? (String(txData.chainId).startsWith('eip155:') ? txData.chainId : `eip155:${txData.chainId}`)
    : undefined;

  const payload = {
    to: txData.to,
    data: txData.data || '0x',
    value: txData.value ? '0x' + BigInt(txData.value).toString(16) : '0x0',
    gas: txData.gas ? '0x' + BigInt(txData.gas).toString(16) : undefined,
    chainId,
  };

  const output = await wcExec('walletconnect', ['send-transaction', JSON.stringify(payload)], timeoutMs);
  const result = parseWcJson(output);

  if (result.transactionHash) return { txHash: result.transactionHash };
  if (result.txHash) return { txHash: result.txHash };
  if (result.signedTransaction) return { signedTransaction: result.signedTransaction };

  throw new Error('Unexpected response from walletconnect send-transaction');
}

/**
 * Send an ERC-20 approval via WalletConnect.
 *
 * Builds approve(spender, MAX_UINT256) calldata and delegates to sendTransactionViaWalletConnect.
 *
 * @param {string} tokenAddress - ERC-20 token contract
 * @param {string} spenderAddress - Approval target (e.g. DEX router)
 * @param {number} chainId - EIP-155 chain ID
 * @returns {{ txHash?: string, signedTransaction?: string }}
 */
export async function sendApprovalViaWalletConnect(tokenAddress, spenderAddress, chainId) {
  // ERC-20 approve(address spender, uint256 amount) selector = 0x095ea7b3
  const MAX_UINT256_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const data = '0x095ea7b3'
    + spenderAddress.slice(2).toLowerCase().padStart(64, '0')
    + MAX_UINT256_HEX;

  return sendTransactionViaWalletConnect({
    to: tokenAddress,
    data,
    value: '0',
    gas: '100000',
    chainId,
  });
}

/**
 * Sign a Solana transaction via WalletConnect.
 *
 * The wallet signs the transaction and returns either:
 * - { signedTransaction: "<base58>" } — full signed transaction
 * - { signature: "<base58>" } — raw Ed25519 signature only
 *
 * @param {string} txBase58 - Base58-encoded Solana transaction
 * @param {number} [timeoutMs=120000] - Timeout for user approval
 * @returns {{ signedTransaction?: string, signature?: string }}
 */
export async function sendSolanaTransactionViaWalletConnect(txBase58, timeoutMs = 120000) {
  const payload = {
    transaction: txBase58,
    chainId: SOLANA_MAINNET_CHAIN,
  };

  const output = await wcExec('walletconnect', ['send-transaction', JSON.stringify(payload)], timeoutMs);
  const result = parseWcJson(output);

  if (result.signedTransaction) return { signedTransaction: result.signedTransaction };
  if (result.signature) return { signature: result.signature };
  // Some wallets (e.g. Phantom) return 'transaction' instead of 'signedTransaction'
  if (result.transaction) return { signedTransaction: result.transaction };

  throw new Error('Unexpected response from walletconnect Solana sign');
}

/**
 * Sign a Solana message via WalletConnect.
 *
 * Used for challenge-response authentication (e.g., Jupiter Limit Order V2).
 * Returns the raw Ed25519 signature as base58.
 *
 * @param {Buffer} messageBuffer - Raw message bytes to sign
 * @param {number} [timeoutMs=120000] - Timeout for user approval
 * @returns {{ signature: string }} Base58-encoded signature
 */
export async function signSolanaMessageViaWalletConnect(messageBuffer, timeoutMs = 120000) {
  const payload = {
    message: base58Encode(messageBuffer),
    chainId: SOLANA_MAINNET_CHAIN,
  };

  const output = await wcExec('walletconnect', ['sign-message', JSON.stringify(payload)], timeoutMs);
  const result = parseWcJson(output);

  if (result.signature) return { signature: result.signature };

  throw new Error('Unexpected response from walletconnect sign-message');
}
