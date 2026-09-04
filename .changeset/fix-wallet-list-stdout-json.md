---
"nansen-cli": patch
---

Fix `nansen wallet list` to emit only the JSON envelope on stdout, matching every other command. It previously wrote its human-readable summary directly to stdout via `console.log` and returned no data, so `nansen wallet list | jq .` had nothing valid to parse. The human-readable summary (and the "No wallets found" message) now goes to stderr, and stdout carries `{"success":true,"data":{"wallets":[...],"defaultWallet":...}}` — which also means `--pretty`, `--table`, and `--csv` now work on `wallet list` for free, consistent with the rest of the CLI.
