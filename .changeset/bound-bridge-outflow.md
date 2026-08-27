---
"nansen-cli": patch
---

Cross-chain (bridge) swaps now run swap-outcome verification instead of skipping it entirely. The output-arrival check is still skipped (the output settles on the destination chain), but the input-outflow cap and no-sibling-drain checks now run on the source-chain leg, closing a gap where a compromised quote's bridge instructions could move more than the declared input. Bridges also now require a positive input outflow (a no-op transaction no longer verifies) and still validate the quote's output-amount integrity, and the native-SOL bridge log no longer contradicts itself about whether the output check ran.
