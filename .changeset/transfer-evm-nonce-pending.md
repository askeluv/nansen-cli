---
"nansen-cli": patch
---

Use `pending` nonce block tag for EVM sends: back-to-back transfers no longer risk reusing the same nonce when mempool transactions are queued.
