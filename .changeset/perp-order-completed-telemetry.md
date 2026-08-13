---
"nansen-cli": patch
---

`nansen perp order` / `perp close` now emit an anonymous `perp_order_completed` telemetry event after the Hyperliquid `/exchange` response is parsed. Perp orders bypass the Nansen API on submit (the CLI signs and posts straight to Hyperliquid), so this client-side event is the only signal that an order was placed. The payload is deliberately minimal — only the trade side and the Hyperliquid order id (omitted when it exceeded JS safe-integer precision); no asset, price, size, or fill detail is sent. The telemetry disclosure (CLI help footer and module docs) names exactly these fields. Honours the existing `DO_NOT_TRACK` / `NANSEN_NO_TELEMETRY` opt-out; order rejections remain covered by `cli_command_failed`.
