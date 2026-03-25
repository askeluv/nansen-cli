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

```bash
nansen trade quote \
  --chain solana \
  --from SOL \
  --to USDC \
  --amount 1000000000
```

Symbols resolve automatically: `SOL`, `ETH`, `USDC`, `USDT`, `WETH`. Raw addresses also work.

## Execute

```bash
nansen trade execute --quote <quote-id>
```

## Agent pattern

```bash
# Pipe quote ID directly into execute
quote_id=$(nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000 2>&1 | grep "Quote ID:" | awk '{print $NF}')
nansen trade execute --quote "$quote_id"
```

## Common Token Addresses

| Token | Chain | Address |
|-------|-------|---------|
| SOL | Solana | `So11111111111111111111111111111111111111112` |
| USDC | Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| ETH | Base | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Amounts

By default, `--amount` accepts **integer base units** (lamports, wei, etc). Use `--amount-unit token` to specify human-readable token amounts instead — the CLI resolves decimals locally and sends base units to the API.

```bash
# Base units (default)
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
# Token units (0.5 SOL = 500000000 lamports, resolved automatically)
nansen trade quote --chain solana --from SOL --to USDC --amount 0.5 --amount-unit token
```

| Token | Decimals | 1 token = |
|-------|----------|-----------|
| SOL | 9 | `1000000000` |
| ETH | 18 | `1000000000000000000` |
| USDC | 6 | `1000000` |

If the user says "$20 worth of X", you must convert USD → token amount, then either pass base units or use `--amount-unit token`. For example, to buy $20 of SOL at $150/SOL: $20 ÷ $150 = 0.1333 SOL → `--amount 0.1333 --amount-unit token`. Use a price lookup (e.g. `nansen research token info`) to get the current price first.

## Flags

| Flag | Purpose |
|------|---------|
| `--chain` | `solana` or `base` |
| `--from` | Source token (symbol or address) |
| `--to` | Destination token (symbol or address) |
| `--amount` | Amount in base units (integer), or token units with `--amount-unit token` |
| `--amount-unit` | Set to `token` to specify amount in token units (e.g. 0.5 SOL) |
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

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
