---
"nansen-cli": patch
---

Fix x402 payment header decoding and WalletConnect payment payload encoding to use UTF-8 instead of Latin-1. Previously the `Payment-Required` header was decoded with `atob()`, which corrupted multi-byte UTF-8 chars in fields like `extra.name = 'USD₮0'`. The corrupted name then signed the wrong EIP-712 domain and the server rejected with `invalid_exact_evm_signature`. X Layer USDT0 payments now sign correctly; Base USDC was unaffected because `'USD Coin'` is pure ASCII.
