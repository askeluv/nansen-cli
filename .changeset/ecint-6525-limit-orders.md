---
"nansen-cli": patch
---

Add the `nansen-limit-orders` skill. The skill teaches agents to use the native `nansen trade limit-order create|list|cancel|update` commands for Solana price-triggered orders, and documents the alert-based settlement-signal fallback (`common-token-transfer` smart alert on the settlement wallet) for chains without native limit-order support. Builds on the `trade limit-order` command surface added by #328.
