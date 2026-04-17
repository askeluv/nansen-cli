---
"nansen-cli": patch
---

Add the `nansen-limit-orders` skill for limit-order workflows. The skill documents the supported `nansen-cli` path: use existing `trade quote/execute` commands for immediate swaps, keep any resting limit order on the external venue that supports it, and create a narrowly scoped `common-token-transfer` smart alert on the wallet as a best-effort settlement signal.
