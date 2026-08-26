---
"nansen-cli": minor
---

Validate Solana swap quotes against the original request before signing (local, Privy, and WalletConnect wallets). The CLI now checks that a quote's chain, token pair, amounts, and target wallet match what was requested at quote time and refuses to sign when they don't, bringing Solana in line with the existing EVM checks. `--swap-mode exactOut` now also requires `--max-input` on Solana (previously EVM-only), so the maximum spend is bounded by a value you supply rather than one taken from the quote itself.
