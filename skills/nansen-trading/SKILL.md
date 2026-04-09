---
name: nansen-trading
description: Execute DEX swaps on Solana or Base, including cross-chain bridges. Use when buying or selling a token, getting a swap quote, or executing a trade.
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

Symbols resolve automatically: `SOL`, `ETH`, `USDC`, `USDT`, `WETH`. Raw addresses also work. Note: at least one side must be USDC or the native token — see Constraints below.

## Constraints

**Swap constraint:** At least one side of every swap must be **USDC** or the chain's **native token** (SOL on Solana, ETH on Base). Arbitrary token-to-token swaps (e.g. WETH→USDT, BONK→JUP) are rejected.

- USDC (Solana): `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- USDC (Base): `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Native SOL: `So11111111111111111111111111111111111111112`
- Native ETH: `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`

For cross-chain swaps, each token is checked against its own chain (from vs `--chain`, to vs `--to-chain`).

## Execute

```bash
nansen trade execute --quote <quote-id>
```

## Cross-Chain Swap

Bridge tokens between Solana and Base using `--to-chain`:

```bash
nansen trade quote \
  --chain base \
  --to-chain solana \
  --from USDC \
  --to USDC \
  --amount 1000000
```

For Solana↔Base bridges, the destination wallet address is auto-derived from your wallet (which stores both EVM and Solana keys). Override with `--to-wallet <address>` if needed.

Note: you need gas on the **source** chain to submit the initial transaction (e.g. SOL for Solana→Base, ETH for Base→Solana).

## Bridge Status

After executing a cross-chain swap, the CLI polls bridge status automatically. To check manually:

```bash
nansen trade bridge-status --tx-hash <hash> --from-chain base --to-chain solana
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

By default, `--amount` accepts **integer base units** (lamports, wei, etc). Use `--amount-unit token` for human-readable token amounts, or `--amount-unit usd` to specify a USD value — the CLI resolves price and decimals automatically.

```bash
# Base units (default)
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
# Token units (0.5 SOL = 500000000 lamports, resolved automatically)
nansen trade quote --chain solana --from SOL --to USDC --amount 0.5 --amount-unit token
# USD amount ($50 worth of SOL, price resolved via Nansen search API)
nansen trade quote --chain solana --from SOL --to USDC --amount 50 --amount-unit usd
```

| Token | Decimals | 1 token = |
|-------|----------|-----------|
| SOL | 9 | `1000000000` |
| ETH | 18 | `1000000000000000000` |
| USDC | 6 | `1000000` |

If the user says "$20 worth of X", use `--amount-unit usd` directly — no manual conversion needed. The CLI fetches the current price and converts for you.

## Flags

### `trade quote` flags

| Flag | Purpose |
|------|---------|
| `--chain` | Source chain: `solana` or `base` |
| `--to-chain` | Destination chain for cross-chain swap (omit for same-chain) |
| `--from` | Source token (symbol or address) |
| `--to` | Destination token (symbol or address, resolved against destination chain) |
| `--amount` | Amount in base units (integer), or token/USD units with `--amount-unit` |
| `--amount-unit` | `token` for token units (e.g. 0.5 SOL), `usd` for USD (e.g. 50), `base` = default |
| `--wallet` | Wallet name (default: default wallet) |
| `--to-wallet` | Destination wallet address (auto-derived for cross-chain if omitted) |
| `--slippage` | Slippage tolerance as decimal (e.g. 0.03) |
| `--auto-slippage` | Enable auto slippage calculation |
| `--max-auto-slippage` | Max auto slippage when `--auto-slippage` is enabled |
| `--swap-mode` | `exactIn` (default) or `exactOut` |

### `trade execute` flags

| Flag | Purpose |
|------|---------|
| `--quote` | Quote ID from `trade quote` |
| `--wallet` | Wallet name (default: default wallet) |
| `--quote-index` | Pin a specific quote by index (0-based) when multiple quotes were returned |
| `--no-simulate` | Skip pre-broadcast simulation |

### `trade bridge-status` flags

| Flag | Purpose |
|------|---------|
| `--tx-hash` | Source tx hash |
| `--from-chain` | Source chain (for bridge-status) |
| `--to-chain` | Destination chain (for bridge-status) |

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
