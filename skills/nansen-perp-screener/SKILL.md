---
name: nansen-perp-screener
description: "What is the state of the Hyperliquid perp market? Top contracts by volume/OI, trader leaderboard, and SM perp activity."
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

# Perp Market Scan

**Answers:** "What's the state of the Hyperliquid perp market right now?"

```bash
nansen research perp screener --sort volume:desc --limit 20
# → token_symbol, volume, buy/sell_volume, buy_sell_pressure, open_interest, funding, mark_price

nansen research perp leaderboard --days 7 --limit 20
# → trader_address, trader_address_label, total_pnl, roi, account_value

nansen research smart-money perp-trades --limit 20
# → token_symbol, side, action (Open/Close), value_usd, price_usd, trader_address_label
```

## New Filters (ECINT-6680)

### `--trader-type`
Filter by trader type. Accepted values: `all` (default), `sm`, `whale`, `public_figure`, `high_winrate_hl_perps_trader`.

```bash
# Show only whale traders
nansen research perp screener --trader-type whale --limit 10

# Show only smart money traders
nansen research perp screener --trader-type sm --limit 20

# Show high win-rate HL perps traders
nansen research perp screener --trader-type high_winrate_hl_perps_trader --limit 20
```

### `--sm-label-filter`
Comma-separated Nansen SM labels to filter by. Only applies when `--trader-type` is `all` or `sm`.

```bash
# Filter to a specific SM label
nansen research perp screener --trader-type sm --sm-label-filter "30D Smart Trader"

# Multiple labels
nansen research perp screener --sm-label-filter "30D Smart Trader,Smart LP"
```

### `--trader-label-filter`
Comma-separated HL perps trader labels to filter by. Only applies when `--trader-type` is `all` or `sm`.

```bash
# Filter to HL Perps Whale label
nansen research perp screener --trader-label-filter "HL Perps Whale"
```

### `--sectors-filter`
Comma-separated `category:subcategory` pairs to filter coins by sector.

```bash
# Filter to AI and DeFi crypto sectors
nansen research perp screener --sectors-filter "Crypto:AI,Crypto:DeFi" --trader-type whale

# Combine with trader type and limit
nansen research perp screener --sectors-filter "Crypto:AI,Crypto:DeFi" --trader-type whale --limit 10 --sort volume:desc
```

## Combined Examples

```bash
# Whale traders in AI crypto, sorted by volume
nansen research perp screener --trader-type whale --sectors-filter "Crypto:AI" --sort volume:desc --limit 10

# Smart money with specific label, last 7 days
nansen research perp screener --trader-type sm --sm-label-filter "30D Smart Trader" --days 7 --limit 20

# All traders in TradFi stocks sector
nansen research perp screener --sectors-filter "TradFi:Stocks" --sort open_interest:desc --limit 20
```
