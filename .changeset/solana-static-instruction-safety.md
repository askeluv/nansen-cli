---
"nansen-cli": patch
---

`trade execute` on Solana now statically checks the aggregator's compiled instructions before signing, and rejects a transaction that grants a token delegate, changes a token account's authority, closes an account with its rent redirected to a stranger, or sets an excessive compute-budget priority fee — closing a class of drain vector a balance-delta simulation alone can't see.
