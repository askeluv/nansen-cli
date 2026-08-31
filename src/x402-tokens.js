/**
 * Known x402 payment tokens per network.
 * Leaf module — imported by both x402.js and x402-policy.js to avoid circular deps.
 */

// Known payment tokens per EVM network (eip155:<chainId>).
// decimals is per token — BSC stablecoins are 18-decimal BEP-20 deployments,
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

// Known payment tokens on Solana.
export const SVM_X402_TOKENS = {
  solana: [
    { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  ],
};
