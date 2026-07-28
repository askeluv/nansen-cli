---
"nansen-cli": patch
---

`nansen bridge` supports `base -> hyperliquid` for deposits, and `hyperliquid -> base`, `hyperliquid -> ethereum`, `hyperliquid -> arbitrum` for withdrawals. Any other combination is rejected at quote time with the supported routes listed.

The route set is asymmetric because the two directions need different things from the client: a deposit broadcasts an EVM transaction and so needs a locally signable origin chain, while a withdrawal signs a Hyperliquid action and never touches the destination chain.
