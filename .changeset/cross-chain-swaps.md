---
"nansen-cli": minor
---

Add cross-chain swap support between Solana and Base via Li.Fi bridge.

`nansen trade quote --chain base --to-chain solana --from ETH --to SOL --amount 0.01 --amount-unit token`
`nansen trade execute --quote <id>`

Bridge status can be checked with `nansen trade bridge-status`.
