---
"nansen-cli": minor
---

x402 on BNB Smart Chain: support all four stablecoins the API now advertises (U, USD1, USDT, USDC) and add Permit2 payment signing. Payments route on the 402's `extra.assetTransferMethod` — `eip3009` keeps the existing gasless flow (U, USD1), while `permit2-exact` (USDT, USDC on BSC) signs a Permit2 `PermitWitnessTransferFrom` against the spender contract advertised in the 402. Permit2 entries are skipped with an actionable message when the wallet hasn't made the one-time `approve(Permit2, …)` for the token. Post-payment balance warnings now check the exact token paid with (per-token decimals) instead of one hardcoded token per network.
