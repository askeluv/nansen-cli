---
"nansen-cli": patch
---

Fix potential path traversal in safeQuotesPath by rejecting absolute relative paths (Windows cross-drive escape).
