---
"nansen-cli": patch
---

Support x402 payments with USDT on BNB Smart Chain (`eip155:56`), which the Nansen API now advertises as a payment option. Payment signing already handled any EVM network generically; this adds BSC to the post-payment balance check with the correct token contract and 18-decimal precision (Base USDC and X Layer USDT0 use 6), plus a `bsc` entry in the shared RPC registry with a `NANSEN_BSC_RPC` override.
