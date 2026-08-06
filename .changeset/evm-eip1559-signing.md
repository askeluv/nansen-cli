---
"nansen-cli": patch
---

EVM transactions are now signed as EIP-1559 (type 2) when the quote supplies fee caps, instead of being flattened into a legacy (type 0) transaction with a single gas price.

A legacy transaction pays exactly its `gasPrice`, so once the base fee rises above that value it is not merely slow — it can never be included at that nonce. A type-2 transaction pays base fee plus priority up to its cap, so it tolerates the fee moving between signing and inclusion. This affects `trade execute` and `bridge execute`, which share the signer.

`bridge execute` also stops discarding the fee fields the bridge quote provides. It previously overwrote them with a bare `eth_gasPrice` reading, producing a transaction priced at roughly the current base fee with almost no priority fee — which is what it takes to sit unmined on Base. Quoted fees are now kept, with the priority fee raised to a floor that Base will actually schedule and the cap lifted to cover both that and base-fee movement.

Two related robustness changes: signing now refuses outright when a quote carries no gas information at all, rather than falling back to a 1 wei gas price that produces a permanently unmineable transaction; and the receipt wait is longer, because by the time it runs the transaction is already broadcast, so giving up early reports a failure without undoing anything.
