---
"nansen-cli": patch
---

Write the cost-map and update-check cache files atomically (temp file + rename) so concurrent `nansen` processes can no longer observe an empty or truncated cache.
