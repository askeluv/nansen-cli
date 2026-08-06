---
"nansen-cli": patch
---

Close three residual safety gaps on the perp/bridge signing paths:

- `perp order` now rejects a take-profit or stop-loss price that rounds to zero at the asset's precision, instead of encoding a `triggerPx` of `0` and resting a dead protective order while the parent position opens unprotected. This extends the existing zero-price/size guard (which only covered the parent leg) to the TP/SL trigger legs.
- The Privy bridge signing path now refuses to sign an EIP-712 action whose primary type has no field definitions, matching the guard the local signing path already had. An empty type list produces a valid-looking signature that commits to none of the action's contents.
- The EVM bridge deposit leg resolves its nonce from the signing wallet's own address rather than the server-returned `txData.from`. The transaction is signed with the local key regardless of `from`, so the nonce must come from that account — and this stays correct even if a quote omits `from`.
