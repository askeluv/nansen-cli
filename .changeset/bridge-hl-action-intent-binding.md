---
"nansen-cli": patch
---

Bridge withdrawals now verify the Hyperliquid action's type, amount, and network — and the relayer authorization's wallet — against your request before signing, so a tampered quote cannot inflate a withdrawal or authorize on another account.
