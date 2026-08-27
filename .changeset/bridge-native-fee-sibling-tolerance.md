---
"nansen-cli": patch
---

Trade safety: tolerate a bounded native-token fee on cross-chain bridge swaps. The pre-signing swap-outcome check rejected any non-input token leaving the wallet, which could reject a legitimate bridge that pays its network fee in the native token on a token-input route. The tolerance is capped and applies only to the native token on bridges; every other token, and all same-chain swaps, stay strict.
