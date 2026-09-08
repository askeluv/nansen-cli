---
"nansen-cli": patch
---

x402 auto-pay now signs only for supported schemes and recognized payment networks (exact Solana mainnet CAIP-2 binding), and derives the EIP-712 chain id from the validated network. The EIP-712 domain version is now required across all signing backends (local, WalletConnect, Privy) so a missing version can no longer be silently defaulted to a wrong value, while a null/empty remote chain id is treated as unspecified rather than a conflict.
