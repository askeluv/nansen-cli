---
"nansen-cli": minor
---

Add x402 support for paying with USDT0 on X Layer alongside Base USDC and Solana SPL USDC. The CLI auto-signs the payment using whatever the API advertises in the 402 `accepts` list — no client-side allowlist, since `src/x402-evm.js` already reads `extra.name`, `extra.version`, and `asset` generically. New `NANSEN_XLAYER_RPC` env var overrides the default X Layer RPC, and `checkX402Balance()` now picks the right token + RPC based on the requirement's `network` field.

X Layer USDT0 is documented as temporarily unavailable until a server-side facilitator encoding fix ships; use Base USDC for x402 payments in the meantime.
