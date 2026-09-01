---
"nansen-cli": patch
---

Refuse x402 auto-payments whose payment requirement is missing a payTo/pay_to recipient, matching the existing missing-amount check. Previously this fell through to the per-signing-path field validation inconsistently, and the WalletConnect path had no check at all.
