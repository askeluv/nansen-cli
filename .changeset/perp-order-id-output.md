---
"nansen-cli": minor
---

`nansen perp order` and `perp close` now print the Hyperliquid order id (`oid`) and fill (size @ avg price) returned by the exchange, plus a ready-to-run `nansen perp cancel` command for any resting order — mirroring how spot trading surfaces its quote id. TP/SL bracket legs are labelled (parent / take-profit / stop-loss).
