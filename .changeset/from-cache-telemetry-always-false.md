---
"nansen-cli": patch
---

Fix the `from_cache` telemetry field always reporting a miss. The tracking call sites read `result.fromCache`, but the cache marker is recorded on the payload's `_meta`, so the field was `undefined` on every command — including responses served entirely from the local cache. Cache-hit state is now recorded on the API instance, which also covers commands whose handler rebuilds its result and so drops any marker carried on the body.
