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
 *   NANSEN_BSC_RPC        Custom BNB Smart Chain RPC
 *   NANSEN_XLAYER_RPC     Custom X Layer RPC
 *   NANSEN_SOLANA_RPC     Custom Solana RPC
 *   NANSEN_BASE_SIM_RPC   Custom Base simulation RPC (see SIMULATION_RPCS below)
 *
 * Simulation RPCs (SIMULATION_RPCS) are a SEPARATE registry from the cheap
 * defaults above. Swap-outcome verification (src/swap-simulation.js) needs an
 * endpoint that supports state-changing simulation with asset-transfer tracing
 * (`eth_simulateV1` / `debug_traceCall`), which the free public defaults in
 * CHAIN_RPCS deliberately DISABLE. Keeping the two registries apart means only
 * the (pricey) simulation calls hit the trace-capable endpoint; ordinary reads
 * (nonce, balance, allowance, eth_call revert check) stay on the cheap default.
 *
 * The shipped simulation endpoint is a Nansen-hosted service authenticated with
 * the user's existing Nansen API key (no secret in this public package): the
 * trace-capable upstream is reached server-side, so the baked default carries no
 * credential. With no NANSEN_BASE_SIM_RPC override, swap-outcome verification
 * uses this default; if the service is ever unreachable it degrades with a
 * warning rather than blocking the trade. To use your own endpoint (or for local
 * dev/e2e), point NANSEN_BASE_SIM_RPC at any trace-capable RPC in a gitignored .env.
 *
 * Backward-compat aliases (deprecated — prefer the forms above):
 *   NANSEN_RPC_BASE       Old name for NANSEN_BASE_RPC; trading.js previously read this
 *                         but transfer.js never did, so the two commands were inconsistent.
 *                         Both forms are now accepted here so existing .env files keep
 *                         working while new code uses the standardised NANSEN_BASE_RPC name.
 */

const DEFAULT_EVM_RPC      = 'https://eth.public-rpc.com';
const DEFAULT_BASE_RPC     = 'https://mainnet.base.org';
const DEFAULT_BSC_RPC      = 'https://bsc-dataseed.binance.org';
const DEFAULT_XLAYER_RPC   = 'https://rpc.xlayer.tech';
const DEFAULT_SOLANA_RPC   = 'https://api.mainnet-beta.solana.com';
const DEFAULT_ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const DEFAULT_POLYGON_RPC  = 'https://polygon-rpc.com';
const DEFAULT_BNB_RPC      = 'https://bsc-dataseed.bnbchain.org';

// `bsc` (x402.js) and `bnb` (bridge/perp) are both chain 56 — both keys are read.
export const CHAIN_RPCS = {
  ethereum: process.env.NANSEN_EVM_RPC      || DEFAULT_EVM_RPC,
  evm:      process.env.NANSEN_EVM_RPC      || DEFAULT_EVM_RPC,   // generic EVM fallback
  base:     process.env.NANSEN_BASE_RPC     || process.env.NANSEN_RPC_BASE || DEFAULT_BASE_RPC,
  bsc:      process.env.NANSEN_BSC_RPC      || DEFAULT_BSC_RPC,
  xlayer:   process.env.NANSEN_XLAYER_RPC   || DEFAULT_XLAYER_RPC,
  solana:   process.env.NANSEN_SOLANA_RPC   || DEFAULT_SOLANA_RPC,
  arbitrum: process.env.NANSEN_ARBITRUM_RPC || DEFAULT_ARBITRUM_RPC,
  polygon:  process.env.NANSEN_POLYGON_RPC  || DEFAULT_POLYGON_RPC,
  bnb:      process.env.NANSEN_BNB_RPC      || DEFAULT_BNB_RPC,
};

// Zero-config default for the shipped Nansen-hosted simulation endpoint. It
// authenticates with the user's existing Nansen API key (attached automatically
// by swap-simulation.js), and the trace-capable upstream is reached server-side —
// so this URL carries no secret and is safe to bake into a public package. Never
// embed an RPC URL that carries an inline token here; any embedded secret would
// leak on publish.
const DEFAULT_BASE_SIM_RPC = 'https://api.nansen.ai/api/v1/trade/simulate-swap';

// Separate registry for swap-outcome simulation (src/swap-simulation.js). These
// endpoints must support state-changing simulation with asset-transfer tracing
// (`eth_simulateV1` / `debug_traceCall`), which the CHAIN_RPCS public defaults
// disable. Only outcome verification reads this registry; every other RPC call
// stays on the cheap CHAIN_RPCS default. A null entry (no baked default and no
// override) signals "no sim-capable endpoint" to the caller, which degrades.
//
// Intentionally a mutable export: unit tests override an entry in-place (e.g.
// `SIMULATION_RPCS.base = ...`) to point at a mock or to null out the endpoint,
// restoring it in afterEach. Runtime code only ever reads it.
export const SIMULATION_RPCS = {
  base: process.env.NANSEN_BASE_SIM_RPC || DEFAULT_BASE_SIM_RPC,
};

// Nansen hosts the API key may be forwarded to. Kept to an explicit allowlist
// (not a `*.nansen.ai` wildcard): the key only ever authenticates the sim proxy
// on api.nansen.ai, and a wildcard would forward it to any subdomain that
// resolves — including a misconfigured or compromised one. Add new sim hosts
// here deliberately if one is ever introduced.
const NANSEN_HOSTED_SIM_HOSTS = new Set(['api.nansen.ai']);

/**
 * Whether a simulation URL is a Nansen-hosted endpoint that may receive the
 * user's Nansen API key. The key authenticates the shipped default proxy
 * (DEFAULT_BASE_SIM_RPC); a NANSEN_BASE_SIM_RPC override can point at ANY host
 * (dev node, third-party trace RPC), and forwarding the credential there would
 * leak it. So the key is attached ONLY when this returns true — every other
 * endpoint is called anonymously.
 *
 * Trust is: https + hostname is one of NANSEN_HOSTED_SIM_HOSTS. Anything else
 * (http, other host, unparseable) is untrusted and gets no key.
 */
export function isNansenHostedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return NANSEN_HOSTED_SIM_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
