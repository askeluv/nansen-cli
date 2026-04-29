/**
 * Canonical EVM chain name → numeric chain ID mapping.
 *
 * Single source of truth — import from here instead of defining inline.
 */

export const EVM_CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
  avalanche: 43114,
  bnb: 56,
  linea: 59144,
  scroll: 534352,
  mantle: 5000,
  xlayer: 196,
};

/**
 * All EVM chain names recognised by this CLI.
 * Used for address-format validation (0x...) and ENS resolution gating.
 * Import from here instead of defining an inline list per file.
 */
export const EVM_CHAINS = [
  'ethereum', 'arbitrum', 'base', 'bnb', 'polygon', 'optimism',
  'avalanche', 'linea', 'scroll', 'mantle', 'ronin',
  'sei', 'plasma', 'sonic', 'monad', 'hyperevm', 'iotaevm', 'xlayer',
];
