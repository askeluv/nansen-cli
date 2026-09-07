---
"nansen-cli": patch
---

Limit-order create and cancel now verify the API-provided Solana transaction's simulated balance effect against the requested operation before signing, refusing to sign a deposit that would move unexpected funds out of the wallet or a cancel that fails to return the order's own deposited asset to it. Also closes a gap where a cancel could pass on an inflow of any asset (not just the deposited one), and a tiny native-SOL deposit could pass on a fee-only outflow.
