---
"nansen-cli": patch
---

Reject `--oid` values above 2^53-1 on `perp cancel`: large Hyperliquid uint64 order IDs would be silently rounded by JS Number, potentially cancelling the wrong order.
