---
"nansen-cli": minor
---

Bind Solana swap execution (local, Privy, and WalletConnect) to the request intent persisted at quote time, closing the gap where Solana previously signed the aggregator's transaction verbatim with no validation. A compromised or buggy Trading API can no longer swap in a different token pair, inflate the input amount, or hand back a transaction built for a different wallet without the CLI refusing to sign. `--swap-mode exactOut` now requires `--max-input` on Solana too (previously EVM-only) — a spend ceiling derived from the API's own quote can't independently guard against an inflated one, so an explicit, user-supplied cap is required on every chain.
