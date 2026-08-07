---
"nansen-cli": patch
---

Surface richer API response metadata: the `X-Nansen-Credits-Cost` header now drives credit reporting (a concise `Credits: N (this call)` stderr line after each data command, falling back to the cached spec estimate when the header is absent), `requestId` is hoisted to the top level of the JSON error envelope (including `nansen agent` failures, which previously dropped it), and error codes now come from the API's stable `code` field when present — known codes map onto the existing error code enum, unknown ones pass through verbatim instead of being flattened. stdout JSON is unchanged; all new reporting goes to stderr.
