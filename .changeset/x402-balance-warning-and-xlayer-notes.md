---
"nansen-cli": patch
---

Fix x402 low-balance warning to use the actual stablecoin symbol (USDC or USDT0) returned by `checkX402Balance()` instead of hardcoding "USDC".
