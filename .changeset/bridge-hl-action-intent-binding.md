---
"nansen-cli": patch
---

Bridge withdrawals now verify the Hyperliquid action's type, amount, network, and source token/routing fields against your request before signing, so a tampered quote cannot inflate a withdrawal, swap in a different token, or authorize on another account. The relayer authorization step is now pinned exactly to its real EIP-712 domain, field shape, and signing wallet, and its signature can only ever be submitted to the relayer's own fixed authorize endpoint — closing a gap where a malicious quote could have requested a signature over unrelated typed data and relayed it elsewhere. All of a withdrawal's steps are now checked against this before any of them are signed or posted, so a tampered step later in a multi-step quote (e.g. the real [authorize, sendAsset] order) can no longer let an earlier step reach the relayer first.
