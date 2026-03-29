---
"nansen-cli": patch
---

Add balance pre-check before quote API calls. Validates sell token balance, auto-adjusts near-full-balance trades (≤2% over), and reserves gas fees for native token swaps (SOL/ETH).
