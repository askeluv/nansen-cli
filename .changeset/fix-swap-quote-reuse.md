---
"nansen-cli": patch
---

Refuse to re-execute a swap quote that has already been broadcast, mirroring the single-use guard `nansen bridge execute` already had. `nansen trade execute` now marks the quote as spent (`executedAt`) the instant a transaction is broadcast — before waiting for its receipt — so a `RECEIPT_TIMEOUT` (the tx is on-chain but the command exits non-zero) no longer leaves the quote replayable. Retrying the same `--quote <id>` after such a failure previously re-signed and re-broadcast the swap under a fresh nonce instead of being refused.
