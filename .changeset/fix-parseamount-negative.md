---
"nansen-cli": patch
---

Fix `parseAmount` silently producing wrong values for negative decimal inputs. Negative amounts are now rejected with a clear error.
