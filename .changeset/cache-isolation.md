---
"nansen-cli": patch
---

Isolate the response cache by credential and request context so cached
responses can no longer be shared across different API keys or API origins that
use the same cache directory. Cache keys now include the base URL, HTTP method,
and a hashed form of the effective credentials, and use SHA-256.
