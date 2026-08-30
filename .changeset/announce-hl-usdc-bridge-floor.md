---
"nansen-cli": patch
---

`bridge quote` now prints a notice when a Hyperliquid USDC amount is floored to the 6-decimal precision the bridge signs, instead of adjusting the amount silently. The adjustment is unchanged (it's what keeps the persisted amount matching what gets signed); it's just no longer hidden.
