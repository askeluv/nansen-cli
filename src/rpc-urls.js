/**
 * Single source of truth for chain RPC endpoints.
 *
 * Both trading.js and transfer.js read from here so that:
 *   (a) adding a new chain only requires one edit, and
 *   (b) env-var overrides work consistently across all commands.
 *
 * Override env vars:
 *   NANSEN_EVM_RPC        Custom Ethereum RPC (also used as generic EVM fallback)
 *   NANSEN_BASE_RPC       Custom Base RPC
 *   NANSEN_SOLANA_RPC     Custom Solana RPC
 *   NANSEN_XLAYER_RPC     Custom X Layer RPC
 *
 * Backward-compat aliases (deprecated — prefer the forms above):
 *   NANSEN_RPC_BASE       Old name for NANSEN_BASE_RPC; trading.js previously read this
 *                         but transfer.js never did, so the two commands were inconsistent.
 *                         Both forms are now accepted here so existing .env files keep
 *                         working while new code uses the standardised NANSEN_BASE_RPC name.
 */

const DEFAULT_EVM_RPC    = 'https://eth.public-rpc.com';
const DEFAULT_BASE_RPC   = 'https://mainnet.base.org';
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_XLAYER_RPC = 'https://xlayerrpc.okx.com';

export const CHAIN_RPCS = {
  ethereum: process.env.NANSEN_EVM_RPC    || DEFAULT_EVM_RPC,
  evm:      process.env.NANSEN_EVM_RPC    || DEFAULT_EVM_RPC,   // generic EVM fallback
  base:     process.env.NANSEN_BASE_RPC   || process.env.NANSEN_RPC_BASE || DEFAULT_BASE_RPC,
  solana:   process.env.NANSEN_SOLANA_RPC || DEFAULT_SOLANA_RPC,
  xlayer:   process.env.NANSEN_XLAYER_RPC || DEFAULT_XLAYER_RPC,
};
