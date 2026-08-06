---
"nansen-cli": patch
---

`bridge execute` now re-screens the wallet against the compliance blocklist immediately before signing, and fails closed if the check can't be completed — matching what the perp commands already did. Bridge quotes stay valid for an hour and the EVM deposit leg broadcasts straight to a public RPC, so previously nothing re-checked the wallet between the quote and the transaction that moves funds.

It also refuses to execute a quote with a wallet other than the one the quote was created for. Previously the signing wallet was resolved from `--wallet` or the current default independently of the quote, so a changed default (or an explicit `--wallet`) could sign with a different wallet than the one screened.
