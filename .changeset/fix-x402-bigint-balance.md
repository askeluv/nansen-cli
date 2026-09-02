---
"nansen-cli": patch
---

Use BigInt for EVM balance in `checkX402Balance` to avoid precision loss on 18-decimal tokens: `parseInt(hex, 16)` overflows `Number.MAX_SAFE_INTEGER` at ~9 tokens' worth of wei.
