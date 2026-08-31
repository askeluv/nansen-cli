---
"nansen-cli": patch
---

Harden the Hyperliquid bridge deposit leg: EVM approvals are now re-scoped to the requested amount (never unlimited) and the deposit target contract/method is pinned, so a tampered quote can't drain the wallet.
