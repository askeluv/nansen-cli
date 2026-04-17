---
"nansen-cli": patch
---

Add the `nansen-limit-orders` agent skill for limit-order workflows. The skill documents the supported path in `nansen-cli`: place the order on the target venue with your wallet, then create a companion `common-token-transfer` smart alert so the wallet notifies when the buy or sell actually executes.
