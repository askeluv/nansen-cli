---
"nansen-cli": patch
---

Honor the original HTTP method on x402 paid retries so GET/DELETE/PATCH requests are not resent as POST after payment.
