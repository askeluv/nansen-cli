---
"nansen-cli": patch
---

trade execute: confirm EVM transactions against the hash derived locally from
the signed bytes instead of trusting the broadcaster's reported hash, and fail
closed if they disagree.
