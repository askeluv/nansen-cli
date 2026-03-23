---
"nansen-cli": patch
---

Suppress misleading PASSWORD_REQUIRED error when `--provider privy` is specified. Privy wallets don't need a password — only the Privy-specific credentials error is now shown when PRIVY_APP_ID/PRIVY_APP_SECRET are missing.
