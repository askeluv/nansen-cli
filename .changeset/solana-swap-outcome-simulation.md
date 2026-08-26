---
"nansen-cli": minor
---

Verify a Solana swap's simulated on-chain outcome before signing (local, Privy, and WalletConnect wallets), mirroring the existing EVM balance-delta check. The CLI simulates the aggregator's transaction and confirms the wallet's balance changes match the quote — input spent within your max, expected output received, no other asset drained — refusing to sign on a mismatch or an in-simulation revert. Covered by the existing `--no-verify-outcome` flag; degrades with a warning (and still signs) when no simulation-capable RPC is available, so an RPC outage never blocks a trade. New env var: `NANSEN_SOLANA_SIM_RPC`.
