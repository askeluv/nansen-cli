---
"nansen-cli": patch
---

Harden perp, swap, and bridge command safety:

- `perp order`/`close` now reject an invalid `--side` instead of silently opening the opposite direction, and `perp leverage` rejects an invalid `--margin-type` instead of silently switching to isolated.
- Perp numeric args (`--size`, `--price`, `--leverage`, `--oid`) are validated as positive numbers, with specific error messages instead of a generic usage banner.
- Perp commands now require an EVM wallet, with a clear error instead of querying for an `"undefined"` address.
- `trade quote` validates `--quote-index`, `--slippage`, and `--max-auto-slippage`, rejecting out-of-range values (e.g. a percent-vs-decimal slippage mix-up).
- `limit-order list` no longer aborts the whole render when one order has a non-integer amount.
- Quote loaders reject a cross-type quote (a bridge quote sent to `trade execute`, or a swap quote sent to `bridge execute`).
- `bridge execute` now refuses a quote that has already been executed, preventing an accidental double-bridge on retry.
- `bridge quote` accepts human amounts via `--amount-unit token|usd` (default stays base units), resolving token decimals per chain so the same `5` isn't 100x off between chains (USDC is 6 decimals on EVM, 8 on Hyperliquid). Hyperliquid USDC is floored to the bridge's 6-decimal precision to avoid a round-up-past-balance rejection.
- `perp meta` supports `--all` and `--filter <text>` so assets past the first 20 (e.g. HYPE) are listable.
- Deprecated top-level aliases now print a deprecation notice on stderr when run, not only in `--help`.
- `limit-order` rejects a zero-duration or past expiry instead of creating an order that expires immediately.
- A password with leading/trailing whitespace is no longer mangled when read back from the OS keychain.
- Nested backend error messages containing an apostrophe are no longer truncated.
