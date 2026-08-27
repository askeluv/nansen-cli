---
"nansen-cli": patch
---

Fix `trade execute` crashing on Solana-source bridge quotes from the Relay aggregator, which return raw uncompiled instructions instead of a ready-to-sign transaction. These are now compiled client-side before signing.
