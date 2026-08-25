---
"nansen-cli": patch
---

Fix cross-chain bridges into native SOL being refused at execute time. The quote/intent binding compared the wrapped-SOL mint (how `--to SOL` resolves) against the System Program address that aggregators use as the native-SOL sentinel and rejected them as different tokens. Both spellings are now treated as the same asset.
