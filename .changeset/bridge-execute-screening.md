---
"nansen-cli": patch
---

`bridge execute` now re-screens the wallet against the compliance blocklist immediately before signing, and fails closed if the check can't be completed — matching what the perp commands already did. Bridge quotes stay valid for an hour and the EVM deposit leg broadcasts straight to a public RPC, so previously nothing re-checked the wallet between the quote and the transaction that moves funds.
