---
"nansen-cli": patch
---

Fix `--cache` reshaping a cached array response into an object. Endpoints that return a top-level JSON array were object-spread on a cache hit, so `[a, b]` came back as `{ 0: a, 1: b }` and every `Array.isArray()` branch downstream stopped matching — the first call printed rows and the second printed nothing. Cached arrays now stay arrays, and primitive response bodies are returned untouched instead of being exploded into character maps.
