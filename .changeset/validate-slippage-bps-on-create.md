---
"nansen-cli": patch
---

Validate `--slippage-bps` on `limit-order create`: values outside 0-10000 now fail with a clear error before any auth/API call.
