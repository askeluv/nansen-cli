---
"nansen-cli": patch
---

`nansen perp order` / `perp close` now emit an anonymous `perp_order_completed` telemetry event after the Hyperliquid `/exchange` response is parsed, capturing the order outcome — order id, filled/resting status, realized fill price/size versus requested, and per-leg take-profit/stop-loss bracket outcomes. Perp orders bypass the Nansen API on submit, so this client-side event is the only place these outcomes are observable. Honours the existing `DO_NOT_TRACK` / `NANSEN_NO_TELEMETRY` opt-out; order rejections remain covered by `cli_command_failed`.
