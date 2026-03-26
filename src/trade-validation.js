/**
 * Trade input validation for the Nansen CLI.
 * Catches common agent errors (wrong addresses, same-token swaps,
 * bad amounts) before any network call.
 */

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SUPPORTED_CHAINS = ['solana', 'base'];

const CHAIN_TYPES = {
  solana: 'solana',
  base: 'evm',
};

function validateAddressFormat(address, chain, side) {
  const chainType = CHAIN_TYPES[chain];
  if (chainType === 'evm') {
    if (!EVM_ADDRESS_RE.test(address)) {
      throw new Error(
        `Invalid ${side} token address for ${chain}. Expected a valid EVM address (0x followed by 40 hexadecimal characters), got: ${address}`
      );
    }
  } else if (chainType === 'solana') {
    if (!SOLANA_ADDRESS_RE.test(address)) {
      throw new Error(
        `Invalid ${side} token address for ${chain}. Expected a valid Solana address (base58-encoded, 32-44 characters), got: ${address}`
      );
    }
  }
}

/**
 * Validate quote inputs before any network call.
 * Throws on validation failure with an actionable error message.
 */
export function validateQuoteInput({ chain, from, to, amount }) {
  if (!SUPPORTED_CHAINS.includes(chain?.toLowerCase())) {
    throw new Error(
      `Unsupported chain "${chain}". Supported chains: ${SUPPORTED_CHAINS.join(', ')}.`
    );
  }
  const normalizedChain = chain.toLowerCase();

  const numAmount = parseFloat(amount);
  if (!amount || !Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error(
      `Invalid amount "${amount}". Must be a positive number.`
    );
  }

  validateAddressFormat(from, normalizedChain, 'sell');
  validateAddressFormat(to, normalizedChain, 'buy');

  const fromNorm = normalizedChain === 'solana' ? from : from.toLowerCase();
  const toNorm = normalizedChain === 'solana' ? to : to.toLowerCase();
  if (fromNorm === toNorm) {
    throw new Error(
      `Cannot swap ${from} for itself. Sell and buy tokens must be different.`
    );
  }
}
