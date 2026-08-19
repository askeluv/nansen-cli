---
"nansen-cli": patch
---

Fix `profiler labels`: call `/api/v1/profiler/address/labels` with its v1 request body — the beta endpoint previously used was removed from the Nansen API. `profiler batch --include labels` now returns the label array itself instead of the raw `{pagination, data}` envelope.
