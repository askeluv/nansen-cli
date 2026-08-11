---
"nansen-cli": patch
---

Document the missing `trade quote` and `trade execute` options in `src/schema.json`: `--swap-mode`, `--slippage`, `--auto-slippage`, `--max-auto-slippage`, `--quote`, `--quote-index` and `--no-simulate`. These options are already implemented and documented for humans, but were absent from the machine-readable schema.
