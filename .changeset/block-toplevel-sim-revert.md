---
"nansen-cli": patch
---

Swap-outcome verification now fails closed when a simulation endpoint reports a revert as a top-level JSON-RPC error (rather than a per-call status): such a swap is blocked instead of being waved through with a degrade warning.
