---
"nansen-cli": patch
---

`perp` and `bridge` no longer serve any API response from the `--cache` store, and `bridge execute` no longer retries its submission.

- **Compliance screening** is always a live check. Every mutating command re-screens the signing wallet immediately before signing; with `--cache` that verdict could previously come from a cache written up to five minutes earlier, which is exactly the window the check exists to close.
- **`bridge execute`** sets `retry: false`. It proxies to Relay's `/authorize` and Hyperliquid's `/exchange`, neither of which is idempotent, so an automatic re-send on a 500 or 502 could submit the same signed action twice.
- **Bridge status polling** now observes progress under `--cache`. The cache key is endpoint plus body, so every poll for a given request id hit the same key and the loop would re-read one stale verdict for the whole TTL.
- **Perp reads** (`positions`, `orders`, `account`, `meta`) and **bridge quotes** bypass the cache too: they either report live balances to the user or feed a signing decision — `close` sizes its order from the positions read, and asset ids come from `meta`.

`bridge execute` also refuses to sign a step whose EIP-712 type definition is missing or whose `primaryType` matches no entry in it. With an empty field list the digest is still well-formed but commits to none of the action's contents, so it would have produced a valid-looking signature over nothing.
