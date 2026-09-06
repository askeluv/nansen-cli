---
"nansen-cli": patch
---

Fail closed on an ambiguous broadcast failure in swap and bridge execute. When
`/execute` (swap) returns any 5xx (regardless of body shape — a structured 504
`UPSTREAM_TIMEOUT` is treated the same as a bare 502) or any other
uninterpretable response — or the POST, or reading its body, throws a network
error — after the signed tx was sent, or a bridge broadcast fails ambiguously,
the tx may already be live. The quote is now marked spent and the
run aborts — rather than trying the next candidate quote or leaving the quote
reusable — so a re-execute (or agent auto-retry) can't double-broadcast. Gasless
(Relay solver-paid) swaps additionally do not retry the `/execute` POST: the
signed authorization is broadcast by Relay's own wrapping tx, so a re-POST can't
be node-deduped and could trigger a second solve — a single attempt fails closed
instead. A bridge send is kept reusable only when the node's error proves the tx never
entered the mempool (a pre-broadcast validation rejection such as insufficient
funds); in-flight txpool states like "already known" or "nonce too low" fail
closed.
