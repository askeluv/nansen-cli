---
"nansen-cli": patch
---

Validate the wallet name before the Privy pre-read in `wallet delete` and `wallet send`, routing both reads through `getWalletFile()` so the path stays confined to the wallets directory.
