---
"nansen-cli": patch
---

Fix x402 low-balance warning to use the actual stablecoin symbol (USDC or USDT0) instead of hardcoding "USDC", and flag X Layer USDT0 as temporarily unavailable in the no-API-key 402 error message and AGENTS.md so users don't try to fund a broken option.
