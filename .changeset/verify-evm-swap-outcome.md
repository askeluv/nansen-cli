---
"nansen-cli": minor
---

Add EVM swap-outcome verification to `trade execute`. Before broadcasting a swap on an EVM chain (Base), the CLI now simulates the transaction and confirms the wallet's balance changes match the quote — the input is spent within your maximum, at least the expected output is received, and no other token leaves the wallet — refusing to sign when they don't. This runs on top of the existing pre-broadcast checks and needs a simulation-capable RPC (`NANSEN_BASE_SIM_RPC`); when none is available it degrades with a warning rather than blocking the trade. Skip it with `--no-verify-outcome`. Solana is unaffected.
