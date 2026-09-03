---
"nansen-cli": patch
---

Use BigInt for EVM balance in `checkX402Balance` to avoid precision loss on 18-decimal tokens (BSC stablecoins): `parseInt(hex, 16)` loses integer precision once the raw wei value exceeds `Number.MAX_SAFE_INTEGER` (~9.0e15 wei, i.e. ~0.009 tokens at 18 decimals), skewing the low-balance warning.
