---
"nansen-cli": patch
---

Fix EVM swap execution when quotes omit gas limits: WalletConnect and local wallet paths now fall back to eth_estimateGas (×1.5) and then 210000, matching the Privy path.
