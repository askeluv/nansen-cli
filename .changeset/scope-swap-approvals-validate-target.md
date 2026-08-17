---
"nansen-cli": patch
---

Harden EVM swap signing: scope ERC-20 approvals to the trade amount instead of granting an unlimited allowance, and validate the swap target before signing (reject an empty/zero address, a non-contract target, or a target equal to the token being sold). As a result, ERC-20 sells on Base now include a per-swap approval transaction. Native ETH swaps and all Solana swaps are unaffected.
