---
"nansen-cli": patch
---

x402 auto-payment now refuses to sign payments for unknown tokens/networks and enforces a configurable per-payment USD cap (NANSEN_X402_MAX_AMOUNT, default $1.00) before signing.
