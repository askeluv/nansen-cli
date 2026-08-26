---
"nansen-cli": patch
---

trade execute: confirm EVM transactions against the hash derived locally from
the signed bytes instead of trusting the broadcaster's reported hash, and fail
closed if they disagree. Once a transaction has been broadcast, every uncertain
outcome now aborts the whole execute instead of silently trying the next quote
(which could broadcast a second transaction): a hash mismatch, a signed
transaction we cannot re-derive a hash for, and a receipt-confirmation timeout
(distinguished from a genuine on-chain revert) are all fatal across the swap,
approval, and revoke paths. Broadcaster hashes are also compared
prefix-insensitively, so a bare (0x-less) hash is no longer a false mismatch.
