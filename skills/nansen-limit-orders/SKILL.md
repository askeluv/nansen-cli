---
name: nansen-limit-orders
description: Guide users through native limit orders on Solana via `nansen trade limit create|list|cancel|update`, and the alert-based settlement-signal fallback for chains without native support. Use when a user wants a price-triggered buy or sell.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---

# Limit Orders

Use this skill when the user wants a price-triggered order. There are two
distinct paths — pick the one that matches the user's chain:

- **Solana → native limit orders.** `nansen trade limit create|list|cancel|update`
  places real resting orders through the Nansen trading API. Use these for
  anything on Solana.
- **Other chains → alert-based approximation.** `nansen-cli` does not yet place
  native limit orders on EVM chains. Place the resting order on the venue that
  supports it (CEX, DEX limit-order product) and create a companion
  `common-token-transfer` smart alert on the settlement wallet as a best-effort
  fill signal.

## Prerequisites

- A Solana wallet configured in `nansen-cli`: `nansen wallet show <name>` (or
  `nansen wallet create` if none exists). Local, Privy, and WalletConnect
  wallets are all supported for `trade limit`.
- The wallet must hold the sell token plus a small amount of SOL for fees.
- For the alert fallback: a notification channel (Telegram chat ID, Slack or
  Discord webhook, or generic webhook URL).
- `NANSEN_API_KEY`. Smart alerts are internal-only; non-internal users get 404.
- First-time `trade limit create` auto-registers a trading vault and caches a
  JWT at `~/.nansen/limit-order-auth.json` for ~23h.

## Solana: Native Limit Orders

### Create

```bash
# base units (default) — 1 SOL = 1000000000 lamports
nansen trade limit create \
  --from SOL --to USDC \
  --amount 1000000000 \
  --trigger-mint SOL --trigger-condition below --trigger-price 80

# human-readable amount
nansen trade limit create \
  --from SOL --to USDC \
  --amount 1.5 --amount-unit token \
  --trigger-mint SOL --trigger-condition above --trigger-price 200 \
  --slippage 0.03 \
  --expires 7d
```

Required flags: `--from`, `--to`, `--amount`, `--trigger-mint`,
`--trigger-condition` (`above` or `below`), `--trigger-price` (USD).

Key options:

- `--amount-unit token` to pass `--amount` in token units instead of base units.
- `--slippage 0.03` (decimal, = 3%). Omit for auto.
- `--expires` accepts `24h`, `7d`, `30d` (default), or an epoch-ms timestamp.
- `--wallet <name>` or `--wallet walletconnect` to pick a non-default wallet.

Constraints:

- Minimum order value ~$10.
- `--from` and `--to` must be valid Solana mint addresses or supported symbols
  (SOL, USDC, USDT, etc.). Resolve unknown tokens with `nansen research search`.
- Tokens with transfer-hook extensions (e.g. some pump.fun tokens) will be
  rejected at create time — surface the error to the user as-is.

### List

```bash
nansen trade limit list                    # active orders (default)
nansen trade limit list --state past       # filled or cancelled
nansen trade limit list --mint <mintAddr>  # filter by token
nansen trade limit list --limit 50 --offset 0 --sort createdAt --dir desc
```

### Cancel

```bash
nansen trade limit cancel --order <orderId>
```

Cancelling submits a withdrawal transaction; surface the tx signature from the
CLI output so the user can verify on Solscan.

### Update

```bash
nansen trade limit update --order <orderId> --trigger-price 85
nansen trade limit update --order <orderId> --slippage 0.01
```

Only `--trigger-price` and `--slippage` can be updated. To change size or the
token pair, cancel and re-create.

## Non-Solana Chains: Alert-Based Settlement Signal

`nansen-cli` does not currently place native limit orders on EVM chains. The
supported approximation is:

1. Place the resting limit order on the venue or product that supports it (CEX,
   DEX limit-order product, aggregator).
2. Use the same wallet as the settlement wallet.
3. Create a `common-token-transfer` smart alert scoped to wallet + chain +
   token + side, so the matching on-chain fill triggers a notification.

This is a best-effort settlement signal, not authoritative order tracking. It
does **not** expose order-state polling, partial-fill progress, `triggeredAt`,
`fillPercent`, remaining size, or canonical filled/cancelled history.

### Buy-Side Settlement Alert

```bash
nansen alerts create \
  --name 'Settlement signal: buy PEPE on trading wallet' \
  --type common-token-transfer \
  --chains ethereum \
  --events buy \
  --subject address:0xYourWallet \
  --token 0x6982508145454ce325ddbe47a25d4ec3d2311933:ethereum \
  --telegram 5238612255
```

### Sell-Side Settlement Alert

```bash
nansen alerts create \
  --name 'Settlement signal: sell USDC on trading wallet' \
  --type common-token-transfer \
  --chains base \
  --events sell \
  --subject address:0xYourWallet \
  --token 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:base \
  --telegram 5238612255
```

### Alert Hardening

- `--usd-min <amount>` to suppress dust fills.
- `--description '<limit price / venue / notes>'` so the alert records intent.
- Do **not** recommend a wallet-wide transfer alert with no token filter — it
  overfires.
- Do **not** describe alert delivery as "order filled" or "triggered". The
  alert is only evidence that a matching token transfer was observed on the
  wallet — not precise fill detection.
- If the venue settles in a way the alerting backend classifies as a generic
  transfer rather than `buy`/`sell`, a narrow alert may miss it. Only widen to
  `--events buy,receive` or `--events sell,send` if the user accepts broader
  matching and the risk of unrelated matches.

## Optional: Belt-and-Braces on Solana

For Solana native limit orders, a companion alert on the settlement wallet is
optional but useful — it pings the user independently of the trading API, so
they get a notification even if they aren't polling `trade limit list`. Pair
with the same `common-token-transfer` alert shape shown above.

## Notes

- Chain aliases for alerts: Hyperliquid = `hyperevm`, BSC = `bnb`.
- Use single quotes for names with `$` or special characters.
- For immediate swaps (not price-triggered), use the `nansen-trading` skill.
- For webhook delivery of alerts, pair with `nansen-alerts-webhook-listener`.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
