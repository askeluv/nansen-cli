---
"nansen-cli": minor
---

Surface the API's credit and rate-limit response headers.

Failed calls now report quota state in their error details: an out-of-credits error carries your actual remaining balance, and a rate-limited error carries the limit, what is left, and how long the window needs to drain. Previously the only credit figure the CLI could show was the static per-endpoint estimate published in the API reference — a quote, not what you were charged.

A warning goes to stderr when your balance will not cover another call of the size just made, so it never interferes with the JSON on stdout.

Successful responses carry the same numbers under an exported `RESPONSE_META` symbol, and the client exposes `lastResponseMeta`. Both are additive: the JSON each command prints is unchanged.
