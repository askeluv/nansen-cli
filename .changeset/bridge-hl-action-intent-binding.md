---
"nansen-cli": patch
---

Bridge withdrawals now verify the Hyperliquid action's type, amount, network, and source token/routing fields against your request before signing, so a tampered quote cannot inflate a withdrawal, swap in a different token, or authorize on another account. The relayer authorization step is now pinned to its exact expected EIP-712 shape and signing wallet, and its signature can only be submitted to the relayer's own host — closing a gap where a malicious quote could have requested a signature over unrelated typed data and relayed it elsewhere.
