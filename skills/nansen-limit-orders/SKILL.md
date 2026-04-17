---
name: nansen-limit-orders
description: Create limit orders that pair a price target with a smart alert on the wallet. Use when setting up a buy/sell trigger and wanting to be notified when the wallet executes the matching trade.
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

Create a limit order and a companion **smart alert** on the wallet in one step.
The alert fires when the wallet executes the matching buy/sell on-chain so you
get a notification the moment the order is triggered.

The order intent (price target + side + amount) is stored locally in
`~/.nansen/limit-orders/`. The companion alert is a `common-token-transfer`
smart alert filtered to the wallet + token + side. Execution is **manual** —
use `nansen trade quote/execute` (or your venue of choice) when the price hits.

## Prerequisites

- A wallet (`nansen wallet create`) so the alert subject has a real address.
- A notification channel: a Telegram chat ID, Slack/Discord/webhook URL.
- `NANSEN_API_KEY` (smart alerts are an internal-only API).

## Quick Reference

```bash
nansen trade limit-order create --chain <chain> --side <buy|sell> \
  --token <symbol|address> --target-price <usd> --amount <units> \
  --telegram <chatId> [--wallet <name>] [options]

nansen trade limit-order list [--table]
nansen trade limit-order delete <orderId>
```

## Create

```bash
nansen trade limit-order create \
  --chain base \
  --side buy \
  --token USDC \
  --target-price 0.99 \
  --amount 100 --amount-unit usd \
  --telegram 5238612255
```

Returns a JSON record with both `orderId` and `alertId`:

```json
{
  "success": true,
  "data": {
    "orderId": "1731612345678-a1b2c3d4",
    "alertId": "alert-xyz",
    "walletName": "main",
    "walletAddress": "0xabc...",
    "chain": "base",
    "side": "buy",
    "tokenAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "tokenSymbol": "USDC",
    "targetPriceUsd": "0.99",
    "amount": "100",
    "amountUnit": "usd",
    "channels": ["telegram"]
  }
}
```

## Required Flags (create)

| Flag | Purpose |
|------|---------|
| `--chain <chain>`         | Chain to monitor (e.g. `solana`, `base`, `ethereum`). Must be supported by the smart-alert API. |
| `--side <buy\|sell>`      | Direction. `buy` fires on receive/buy events, `sell` on send/sell events. |
| `--token <symbol\|addr>`  | Target token. Symbols (`USDC`, `ETH`, `SOL`, etc.) resolve via the trade module; raw addresses also work. |
| `--target-price <usd>`    | Trigger price in USD. Recorded on the order — the alert fires on the on-chain trade, not on price ticks. |
| `--amount <units>`        | Order size. Base units by default. |
| One channel               | `--telegram <chatId>`, `--slack <url>`, `--discord <url>`, or `--webhook <url>`. |

## Optional Flags (create)

| Flag | Purpose |
|------|---------|
| `--wallet <name>`         | Wallet name (default: default wallet). Solana addr is used for `--chain solana`, EVM addr for EVM chains. |
| `--amount-unit <unit>`    | `base` (default), `token`, or `usd`. Tracked on the local record only. |
| `--name <name>`           | Alert + order name. Default: `Limit order <side> <token> @ $<price>`. |
| `--description <text>`    | Optional description for the alert. |
| `--webhook-secret <s>`    | HMAC signing secret for webhook payloads (≥16 chars, requires `--webhook`). |

## List

```bash
nansen trade limit-order list           # JSON array
nansen trade limit-order list --table   # human-readable table
```

## Delete

```bash
nansen trade limit-order delete <orderId>
```

Removes the local order record **and** the companion smart alert. If the alert
delete call fails (e.g. it was already deleted manually), the local record is
still removed and the response includes `alertDeleted: false` with the error.

## How the Companion Alert Works

For each limit order, a smart alert is created with this shape:

```js
{
  type: 'common-token-transfer',
  timeWindow: 'realtime',
  channels: [...],
  data: {
    chains: [<chain>],
    events: [<side>],                         // 'buy' or 'sell'
    subjects: [{ type: 'address', value: <walletAddress> }],
    inclusion: { tokens: [{ address: <token>, chain: <chain> }] },
  }
}
```

Tune or disable it directly via `nansen alerts toggle <alertId> --disabled` /
`nansen alerts update <alertId> ...` if you need to add a USD floor, expand
events, etc.

## Notes

- This skill does **not** execute the trade. It records intent and wires the
  notification. Pair it with `nansen trade quote/execute` to actually swap
  when the price target is hit.
- Chain aliases for alerts: Hyperliquid = `hyperevm`, BSC = `bnb`.
- Use single quotes for names with `$` or special chars: `--name 'Buy ETH @ $1900'`.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
