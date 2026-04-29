---
"nansen-cli": minor
---

Add Relay aggregator support for Base↔Solana cross-chain swaps. Users now see Relay quotes alongside Li.Fi in `nansen trade quote --to-chain ...`, can execute them through `trade execute`, and optionally use Relay's gasless path with `--gasless` (local/Privy wallets only — not WalletConnect). `trade bridge-status` auto-detects which aggregator produced a tx (via a local tx record) and polls the right backend.
