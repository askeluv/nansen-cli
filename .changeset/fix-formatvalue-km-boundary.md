---
"nansen-cli": patch
---

Fix `formatValue` displaying `1000.00K` instead of `1.00M` when a value like 999999.995 rounds up at the K/M boundary.
