---
name: nansen-trading
description: Execute DEX swaps on Solana or Base. Use when buying or selling a token, getting a swap quote, or executing a trade.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
        - NANSEN_WALLET_PASSWORD
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---

# Trade

Two-step flow: quote then execute. **Trades are irreversible once on-chain.**

**Prerequisite:** You need a wallet first. Run `nansen wallet create` before trading.

## Quote

By default, `--amount` is in USD (agent-safe — no base unit math needed):

```bash
# Sell $20 worth of SOL for USDC
nansen trade quote --chain solana --from SOL --to USDC --amount 20

# Sell $50 worth of ETH for USDC on Base
nansen trade quote --chain base --from ETH --to USDC --amount 50
```

### Amount Units

| Unit | Flag | Example | Meaning |
|------|------|---------|---------|
| USD (default) | `--amount-unit usd` | `--amount 20` | $20 worth |
| Token | `--amount-unit token` | `--amount 1.5` | 1.5 tokens (e.g. 1.5 SOL) |
| Base | `--amount-unit base` | `--amount 1000000000` | Raw base units (lamports, wei) |

### Amount Side

| Side | Flag | Meaning |
|------|------|---------|
| Sell (default) | `--amount-side sell` | Amount is what you're selling (exactIn) |
| Buy | `--amount-side buy` | Amount is what you want to receive (exactOut) |

```bash
# Buy $100 worth of ETH (receive side)
nansen trade quote --chain base --from USDC --to ETH --amount 100 --amount-side buy
```

### Token-unit examples

```bash
# Sell 1.5 SOL for USDC
nansen trade quote --chain solana --from SOL --to USDC --amount 1.5 --amount-unit token

# Sell 0.01 ETH for USDC on Base
nansen trade quote --chain base --from ETH --to USDC --amount 0.01 --amount-unit token
```

### Base-unit examples (backward compatible)

```bash
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000 --amount-unit base
nansen trade quote --chain base --from ETH --to USDC --amount 1000000000000000000 --amount-unit base
```

Symbols resolve automatically: `SOL`, `ETH`, `USDC`, `USDT`, `WETH`. Raw addresses also work.

## Execute

```bash
nansen trade execute --quote <quote-id>
```

## Agent pattern

```bash
# Pipe quote ID directly into execute
quote_id=$(nansen trade quote --chain solana --from SOL --to USDC --amount 20 2>&1 | grep "Quote ID:" | awk '{print $NF}')
nansen trade execute --quote "$quote_id"
```

## Common Token Addresses

| Token | Chain | Address |
|-------|-------|---------|
| SOL | Solana | `So11111111111111111111111111111111111111112` |
| USDC | Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| ETH | Base | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Token Decimals Reference

| Token | Decimals | 1 token = |
|-------|----------|-----------|
| SOL | 9 | `1000000000` |
| ETH | 18 | `1000000000000000000` |
| USDC | 6 | `1000000` |

## Flags

| Flag | Purpose |
|------|---------|
| `--chain` | `solana` or `base` |
| `--from` | Source token (symbol or address) |
| `--to` | Destination token (symbol or address) |
| `--amount` | Amount to trade (default: USD) |
| `--amount-unit` | Unit: `usd` (default), `token`, or `base` |
| `--amount-side` | Side: `sell` (default) or `buy` |
| `--wallet` | Wallet name (default: default wallet) |
| `--slippage` | Slippage tolerance as decimal (e.g. 0.03) |
| `--quote` | Quote ID for execute |
| `--no-simulate` | Skip pre-broadcast simulation |

## Environment Variables

| Var | Purpose |
|-----|---------|
| `NANSEN_WALLET_PASSWORD` | **Required for `trade execute`.** Wallet encryption password — persisted in `~/.nansen/.env`. Source before executing: `source ~/.nansen/.env && nansen trade execute ...` |
| `NANSEN_API_KEY` | API key (also set via `nansen login`) |

> **Agents:** Never hold a wallet password only in session memory. If `NANSEN_WALLET_PASSWORD` is not in `~/.nansen/.env`, follow the setup flow in the nansen-wallet-manager skill Password Policy to generate and persist one before proceeding.

## Notes

- Quotes expire after ~1 hour. If execute fails, get a fresh quote.
- A wallet is required even for quotes (the API builds sender-specific transactions).
- ERC-20 swaps may require an approval step — execute handles this automatically.
- USD conversion uses CoinGecko free API for price lookups. For exotic tokens, use `--amount-unit token` or `--amount-unit base`.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
