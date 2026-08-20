---
"nansen-cli": minor
---

Bind Solana swap execution (local, Privy, and WalletConnect) to the request intent persisted at quote time, closing the gap where Solana previously signed the aggregator's transaction verbatim with no validation. A compromised or buggy Trading API can no longer swap in a different token pair, inflate the input amount, or hand back a transaction built for a different wallet without the CLI refusing to sign. `--swap-mode exactOut` on Solana now also persists a derived spend ceiling (mirroring `--max-input` on EVM) so this check always has a bound to enforce, even without the flag.
