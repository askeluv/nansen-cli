---
"nansen-cli": patch
---

Add `src/hl-client.js`, the single direct-to-Hyperliquid submission path: `submitExchange()` POSTs a signed action straight to `api.hyperliquid.xyz/exchange` from the user's machine instead of routing it through the Nansen backend. Reads and market-data stay on the proxy.

It reproduces the backend proxy's failure handling that it replaces — throwing on a top-level `status: "err"` and on a per-action error nested in `response.data.statuses[].error` (a rejected order that Hyperliquid otherwise reports under a top-level `"ok"`) — so a rejected order can never be mistaken for a fill. The submit is deliberately not retried, since each carries a unique nonce and is not idempotent. The HL base URL is overridable via `NANSEN_HL_API_URL` (for testnet / tests).
