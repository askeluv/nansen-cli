---
"nansen-cli": patch
---

Fix exactOut `--max-input` so it bounds the slippage-buffered approval, not the bare quote input. Previously an exactOut ERC-20 quote whose raw input equalled the cap (e.g. 1,000,000 at 3% slippage) passed the max-input filter and was saved, but execution scoped a larger approval (1,030,000) that the approval encoder then rejected for exceeding the cap — bricking the trade across local, Privy, and WalletConnect flows. Both the quote-time filter and the execute-time spend check now measure the same buffered amount the approval encoder does, so a quote that clears the cap can always be signed.
