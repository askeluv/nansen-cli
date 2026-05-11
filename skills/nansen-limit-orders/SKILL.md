---
name: nansen-limit-orders
description: Guide users through native limit orders on Solana via `nansen trade limit-order create|list|cancel|update`, and the alert-based settlement-signal fallback for chains without native support. Use when a user wants a price-triggered buy or sell.
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

- **Solana → native limit orders.** `nansen trade limit-order create|list|cancel|update`
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
  wallets are all supported for `trade limit-order`.
- The wallet must hold the sell token plus a small amount of SOL for fees.
- For the alert fallback: a notification channel (Telegram chat ID, Slack or
  Discord webhook, or generic webhook URL).
- `NANSEN_API_KEY`. Smart alerts are internal-only; non-internal users get 404.
- First-time `trade limit-order create` auto-registers a trading vault and
  caches a JWT at `~/.nansen/limit-order-auth.json` for ~23h.

> **Two mechanisms, not one.** The limit order itself is **price-triggered** —
> it executes when the market price crosses the target. A companion smart
> alert is a **settlement confirmation** — it fires after the trade settles
> on-chain (i.e. when the bought token actually arrives in the wallet). They
> are independent: the order handles the trigger, the alert tells the user the
> fill landed.

## Solana: Native Limit Orders

### Create

```bash
# --amount is always in token units (e.g. 1 = 1 SOL, 80 = 80 USDC)
nansen trade limit-order create \
  --from SOL --to USDC \
  --amount 1 \
  --trigger-mint SOL --trigger-condition below --trigger-price 80

# with explicit slippage and expiry
nansen trade limit-order create \
  --from SOL --to USDC \
  --amount 1.5 \
  --trigger-mint SOL --trigger-condition above --trigger-price 200 \
  --slippage-bps 300 \
  --expires 7d
```

Required flags: `--from`, `--to`, `--amount`, `--trigger-mint`,
`--trigger-condition` (`above` or `below`), `--trigger-price` (USD).

Key options:

- `--amount` is always in **token units** (human-readable). `1.5` means 1.5 SOL,
  `80` means 80 USDC. There is no base-unit mode and no amount-unit override flag —
  do not pass one.
- `--slippage-bps <bps>` — basis points, integer 0–10000 (`300` = 3%, `100` = 1%).
  Omit for auto.
- `--expires` accepts `24h`, `7d`, `30d` (default), or an epoch-ms timestamp.
- `--wallet <name>` or `--wallet walletconnect` (alias `wc`) to pick a non-default
  wallet.

Constraints (all enforced server-side — surface errors to the user as-is):

- Minimum order value (~$10 last seen). Below this the API rejects the order.
- `--from` and `--to` must be valid Solana mint addresses or supported symbols
  (SOL, USDC, USDT, etc.). Resolve unknown tokens with `nansen research search`.
- Tokens with transfer-hook extensions (e.g. some pump.fun tokens) are rejected
  at create time.

### List

```bash
nansen trade limit-order list                    # default
nansen trade limit-order list --state active     # only open
nansen trade limit-order list --state past       # filled or cancelled
nansen trade limit-order list --mint <mintAddr>  # filter by token
nansen trade limit-order list --limit 50 --offset 0 --dir desc
```

Options: `--state active|past`, `--mint <addr>`, `--limit <n>` (default 20),
`--offset <n>`, `--sort <field>`, `--dir asc|desc` (default `desc`),
`--wallet <name>`.

### Cancel

```bash
nansen trade limit-order cancel --order <orderId>
```

Cancelling submits a withdrawal transaction; surface the tx signature from the
CLI output so the user can verify on Solscan.

### Update

```bash
nansen trade limit-order update --order <orderId> --trigger-price 85
nansen trade limit-order update --order <orderId> --slippage-bps 100
```

Only `--trigger-price` and `--slippage-bps` can be updated. To change size or
the token pair, cancel and re-create. Auto slippage can only be set at creation
time (by omitting `--slippage-bps` from `create`); `update` cannot revert a
fixed slippage back to auto.

## Non-Solana Chains: Alert-Based Settlement Signal

`nansen-cli` does not currently place native limit orders on EVM chains. The
supported approximation is:

1. Place the resting limit order on the venue or product that supports it (CEX,
   DEX limit-order product, aggregator). **The venue handles the price
   trigger.**
2. Use the same wallet as the settlement wallet.
3. Create a `common-token-transfer` smart alert scoped to wallet + chain +
   token + side. The alert fires **after** the trade settles — i.e. once the
   bought/sold token actually moves on-chain — as a fill-detected signal.

How the two mechanisms compose:

1. **Price hits target → the venue's limit order executes.** This is the
   trigger. `nansen-cli` is not involved.
2. **Token arrives in the wallet → the smart alert pings.** This is the
   settlement confirmation. The alert never sees the price trigger; it only
   sees the resulting transfer.

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

For Solana native limit orders, a companion `common-token-transfer` alert on
the settlement wallet is optional but useful. **It is a settlement
confirmation, not a price trigger.** The limit order itself handles the price
trigger; the alert fires when the bought token actually arrives in the wallet
(or, for sells, when the sold token leaves) — proof the on-chain fill landed,
delivered via Telegram/webhook independently of `trade limit-order list`
polling.

Some venues route fills through programs that the alerting backend may not
classify as `buy`/`sell`, so this is still a best-effort settlement signal,
not authoritative fill detection. Pair with the same `common-token-transfer`
alert shape shown above.

## What to Tell the User

When suggesting a companion alert, be explicit that two different mechanisms
are at work — users routinely conflate them:

- The **limit order** is the price trigger. It executes when the market price
  crosses the target.
- The **smart alert** is the settlement confirmation. It pings after the trade
  settles on-chain.

Suggested phrasing: _"When your order fills and the token arrives in your
wallet, you'll get a Telegram ping. The price trigger is handled by the limit
order itself — the alert just confirms the fill landed."_

Avoid wording that implies the alert "triggers" the order or that the alert
itself watches price. It does neither.

## Notes

- Chain aliases for alerts: Hyperliquid = `hyperevm`, BSC = `bnb`.
- Use single quotes for names with `$` or special characters.
- For immediate swaps (not price-triggered), use the `nansen-trading` skill.
- For webhook delivery of alerts, pair with `nansen-alerts-webhook-listener`.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
