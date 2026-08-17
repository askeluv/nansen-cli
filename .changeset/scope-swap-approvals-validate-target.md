---
"nansen-cli": minor
---

Harden EVM swap signing: scope ERC-20 approvals to the trade amount instead of granting an unlimited allowance, and validate the swap target before signing (reject an empty/zero address, a non-contract target, or a target equal to the token being sold). As a result, ERC-20 sells on Base now include a per-swap approval transaction. Native ETH swaps and all Solana swaps are unaffected. Note: this scopes approvals granted from now on; a pre-existing unlimited approval from an earlier version is not automatically reduced.

Also tightens the input validation on the quote a swap is signed from. Every approval-signing path (local, Privy, WalletConnect) now shares one encoder that requires a well-formed 20-byte spender, keeps the approved amount bounded (never unlimited) and within the request cap, and produces fixed-width approval calldata. And each quote is revalidated at execute time against the immutable request intent persisted when it was fetched (chain, token pair, mode, and amount), so a compromised or buggy quote response can't enlarge the input — and therefore the approval and native value — beyond what was requested.
