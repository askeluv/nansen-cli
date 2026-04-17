---
name: nansen-limit-orders
description: Set up limit-order workflows by pairing a wallet's external buy/sell order with a smart alert that fires when the order actually fills on-chain. Use when a user wants fill notifications for a specific wallet and token.
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

Use this skill when the user wants a limit-order workflow tied to a wallet plus
a smart alert when the order actually fills on-chain.

`nansen-cli` does **not** currently place resting/native limit orders. The
supported workflow is:

1. Place the limit order on the target venue with the wallet you care about.
2. Create a companion `common-token-transfer` smart alert on that same wallet.
3. When the venue executes the buy or sell, the alert notifies the user.

## Prerequisites

- A wallet in `nansen-cli` so you can resolve the monitored address:
  `nansen wallet show <name>`
- A token address or mint on the target chain. If the user only gives a symbol
  or name, resolve it first with `nansen research search`.
- A notification channel: Telegram chat ID, Slack/Discord webhook, or generic
  webhook URL.
- `NANSEN_API_KEY`. Smart alerts are internal-only; non-internal users get 404.

## Quick Reference

```bash
nansen wallet show <name>
nansen research search "<token query>" --limit 5
nansen alerts create --name <name> --type common-token-transfer \
  --chains <chain> --events <buy|sell> --subject address:<wallet> \
  --token <address:chain> --telegram <chatId>
```

## Workflow

```bash
nansen wallet show trading
# -> capture the wallet address for the relevant chain

nansen research search "PEPE" --limit 5
# -> use the exact token address/mint on the intended chain
```

After the order is placed on the external venue, create the companion alert.

### Buy Fill Alert

```bash
nansen alerts create \
  --name 'Fill: buy PEPE on trading wallet' \
  --type common-token-transfer \
  --chains ethereum \
  --events buy \
  --subject address:0xYourWallet \
  --token 0x6982508145454ce325ddbe47a25d4ec3d2311933:ethereum \
  --telegram 5238612255
```

### Sell Fill Alert

```bash
nansen alerts create \
  --name 'Fill: sell BONK on trading wallet' \
  --type common-token-transfer \
  --chains solana \
  --events sell \
  --subject address:YourSolanaWallet \
  --token DezXAZ8z7PnrnRJjz3wXBoRgixCa6B8hLtz6PMuBsqvE:solana \
  --telegram 5238612255
```

## Required Alert Shape

Use `common-token-transfer` with:

- `--chains <chain>`
- `--events buy` for buy orders, `--events sell` for sell orders
- `--subject address:<walletAddress>`
- `--token <tokenAddress:chain>`
- at least one notification channel

Optional hardening:

- Add `--usd-min <amount>` to suppress dust fills.
- Add `--description '<limit price / venue / notes>'` so the alert records the
  intended order context.
- If the venue reports transfers as generic movement rather than `buy`/`sell`,
  widen to `--events buy,receive` or `--events sell,send` only if the user
  accepts the broader match.

## Notes

- This skill is about the alert wiring, not order placement. Do **not** tell
  the user `nansen trade limit-order ...`; that command does not exist.
- For immediate swaps, use the `nansen-trading` skill and `nansen trade
  quote/execute`.
- For webhook delivery, pair this with the `nansen-alerts-webhook-listener`
  skill.
- Chain aliases for alerts: Hyperliquid = `hyperevm`, BSC = `bnb`.
- Use single quotes for names with `$` or special chars.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
