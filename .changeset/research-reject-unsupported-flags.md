---
"nansen-cli": patch
---

`research historical-token-flow-summary` now errors immediately when `--page` or `--limit` are passed (the endpoint returns a single aggregated row and does not support pagination). `research historical-smart-money-balances` now errors when `--sort` or `--order-by` are passed (the endpoint does not support ordering). Previously both flags were silently dropped.
