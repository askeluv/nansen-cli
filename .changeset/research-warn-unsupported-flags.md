---
"nansen-cli": patch
---

Warn to stderr when --page/--limit is passed to historical-token-flow-summary or --sort is passed to historical-smart-money-balances, since those endpoints silently ignore those flags.
