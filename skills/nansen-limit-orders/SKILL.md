---
name: nansen-limit-orders
description: Set up limit-order workflows by pairing a wallet's external buy or sell order with a smart alert on that wallet. Use when a user wants a narrow, best-effort settlement signal without implying that nansen-cli places native limit orders.
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
a smart alert after the order settles on-chain.

`nansen-cli` does **not** currently place resting/native limit orders. The
real split today is:

- `nansen trade quote/execute` handles immediate swaps only, and only on
  `solana` and `base`, through `trading-api.nansen.ai`.
- `nansen alerts ...` is separate and uses the smart-alert API.

The supported workflow is:

1. Place the resting limit order on the venue or product that actually supports it.
2. Keep the same wallet as the settlement wallet.
3. Create a companion `common-token-transfer` smart alert scoped to that wallet,
   chain, and token.
4. Treat the alert as a best-effort settlement signal. Whether it shows up as
   `buy` or `sell` versus a generic transfer depends on how the venue settles
   and how the alerting backend classifies the event.

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

If the user wants an immediate swap in the CLI first, the real command surface is:

```bash
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
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

## Alert Guidance

Start with the narrowest `common-token-transfer` shape:

- `--chains <chain>`
- `--events buy` for expected buys, `--events sell` for expected sells
- `--subject address:<walletAddress>`
- `--token <tokenAddress:chain>`
- at least one notification channel

Optional hardening:

- Add `--usd-min <amount>` to suppress dust fills.
- Add `--description '<limit price / venue / notes>'` so the alert records the
  intended order context.

Classification caveat:

- If the venue settles the order in a way the alert backend classifies as a
  generic transfer instead of `buy` or `sell`, the narrow alert may miss it.
- Only widen to `--events buy,receive` or `--events sell,send` if the user
  accepts broader matching. That can catch unrelated token movements on the
  same wallet and is not precise fill detection.
- Do **not** recommend a wallet-wide transfer alert without a token filter.
  That is too broad and will overfire.

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
