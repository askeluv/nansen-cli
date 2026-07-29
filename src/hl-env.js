/**
 * Nansen CLI — which Hyperliquid network we are talking to.
 *
 * Its own module because both halves of the HL path need it and neither should
 * have to import the other: hl-action.js builds actions (pure, golden-vector
 * pinned) and hl-client.js submits them. Deriving the network from one place
 * keeps a signed action in step with the URL it is submitted to.
 */

export const HL_MAINNET_API_URL = 'https://api.hyperliquid.xyz';
export const HL_TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';

// Resolve the HL API base. NANSEN_HL_API_URL overrides it (tests, or pointing at
// the testnet); defaults to mainnet.
export function hlApiUrl() {
  return process.env.NANSEN_HL_API_URL || HL_MAINNET_API_URL;
}

// Which HL network the resolved base URL points at.
//
// Actions are network-specific in two places: the L1 phantom agent's `source`
// ("a" mainnet, "b" testnet) and the `hyperliquidChain` field of a user-signed
// action ("Mainnet"/"Testnet"). Both used to be hardcoded to mainnet, so
// pointing NANSEN_HL_API_URL at the testnet signed mainnet-shaped actions that
// the testnet rejects.
//
// Anything not recognisably the testnet host is treated as mainnet, which keeps
// a local mock (tests) on the mainnet vectors.
export function hlNetwork() {
  let host;
  try {
    host = new URL(hlApiUrl()).hostname.toLowerCase();
  } catch {
    return 'Mainnet';
  }
  return host.includes('hyperliquid-testnet') ? 'Testnet' : 'Mainnet';
}
