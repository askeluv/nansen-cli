---
"nansen-cli": patch
---

Fix `nansen wallet list` polluting stdout with its human-readable summary, which made the output impossible for an agent to `JSON.parse`. The decorated summary (wallet names, EVM/Solana addresses, default marker) now goes to stderr, and the command returns a structured `{ wallets }` value so stdout carries only clean JSON — matching how research commands emit their data. The empty case (`No wallets found`) likewise prints its hint to stderr and still emits `{ "wallets": [] }` on stdout.
