/**
 * Trade input validation for the Nansen CLI.
 * Catches common agent errors (wrong addresses, same-token swaps,
 * bad amounts) before any network call.
 */

import { validateAddress } from './api.js';

const SUPPORTED_CHAINS = ['solana', 'base'];

/**
 * Validate quote inputs before any network call.
 * Throws on validation failure with an actionable error message.
 */
export function validateQuoteInput({ chain, from, to, amount }) {
  // 1. Chain must be supported
  const normalizedChain = chain?.toLowerCase();
  if (!SUPPORTED_CHAINS.includes(normalizedChain)) {
    throw new Error(
      `Unsupported chain "${chain}". Supported chains: ${SUPPORTED_CHAINS.join(', ')}.`
    );
  }

  // 2. Amount must be a positive finite number
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error(
      `Invalid amount "${amount}". Must be a positive number.`
    );
  }

  // 3. Token address format must match the chain (reuses api.js validateAddress)
  const fromResult = validateAddress(from, normalizedChain);
  if (!fromResult.valid) {
    throw new Error(
      `Invalid sell token address for ${normalizedChain}. ${fromResult.error}`
    );
  }
  const toResult = validateAddress(to, normalizedChain);
  if (!toResult.valid) {
    throw new Error(
      `Invalid buy token address for ${normalizedChain}. ${toResult.error}`
    );
  }

  // 4. Sell and buy tokens must be different
  const fromNorm = normalizedChain === 'solana' ? from : from.toLowerCase();
  const toNorm = normalizedChain === 'solana' ? to : to.toLowerCase();
  if (fromNorm === toNorm) {
    throw new Error(
      `Cannot swap ${from} for itself. Sell and buy tokens must be different.`
    );
  }
}
