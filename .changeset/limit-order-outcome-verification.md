---
"nansen-cli": patch
---

Limit-order create and cancel now verify the API-provided Solana transaction's simulated balance effect against the requested operation before signing, refusing to sign a transaction that would move unexpected funds out of the wallet.
