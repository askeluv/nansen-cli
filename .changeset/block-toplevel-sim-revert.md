---
"nansen-cli": patch
---

Harden swap-outcome verification error handling: a revert reported by the simulation endpoint as a top-level JSON-RPC error (rather than a per-call status) now fails closed (blocks the swap) instead of degrading, and a non-2xx simulation response (e.g. HTTP 401 "Invalid API key") now degrades with the real status and message instead of a misleading "returned no call result" warning.
