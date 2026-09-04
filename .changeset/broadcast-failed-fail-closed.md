---
"nansen-cli": patch
---

Fail closed on an ambiguous broadcast failure in swap and bridge execute. When
`/execute` (swap) returns a non-JSON/502 response after the signed tx was
POSTed, or a bridge broadcast fails with a gateway/network error, the tx may
already be live on the backend. The quote is now marked spent and the run
aborts — rather than trying the next candidate quote or leaving the quote
reusable — so a re-execute (or agent auto-retry) can't double-broadcast. A
definitive node rejection (a JSON-RPC error) still leaves the quote reusable.
