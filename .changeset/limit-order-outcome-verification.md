---
"nansen-cli": patch
---

Limit-order create and cancel now verify the API-provided Solana transaction's simulated balance effect against the requested operation before signing, refusing to sign a deposit that would move unexpected funds out of the wallet or a cancel that fails to return funds to it.
