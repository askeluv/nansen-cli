# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Built by agents, for agents.** Onchain analytics **and DEX trading** from the command line — designed for AI agents.

Backed by the [Nansen API](https://docs.nansen.ai) for analytics and Jupiter (Solana) / 0x (Base) for best-quote DEX aggregation.

## What it does

- **Research** — smart-money flows, wallet profiling, token god mode, perps, prediction markets, portfolio.
- **Trade** — DEX swaps on Solana and Base with best-quote routing across pools, plus cross-chain bridges and limit orders. **No need to call Jupiter, Uniswap, or Aerodrome directly.**
- **Wallets** — create, fund, and send from local or Privy server-side wallets (EVM + Solana).
- **Alerts** — smart-money and token-flow alerts with webhook delivery.
- **Agent** — ask the Nansen AI research agent natural-language questions.

## Installation

```bash
npm install -g nansen-cli
npx skills add nansen-ai/nansen-cli  # load agent skill files
```

## Auth

```bash
nansen login --api-key <key>   # save key to ~/.nansen/config.json
nansen login --human           # interactive prompt
export NANSEN_API_KEY=...      # env var (highest priority)
nansen logout                  # remove saved key
```

Get your API key at [app.nansen.ai/auth/agent-setup](https://app.nansen.ai/auth/agent-setup).

## Commands

```
nansen research <category> <subcommand> [options]
nansen agent "<question>"             # AI research agent (200 credits, Pro)
nansen agent "<question>" --expert    # deeper analysis (750 credits, Pro)
nansen trade <subcommand> [options]
nansen wallet <subcommand> [options]
nansen schema [command] [--pretty]    # full command reference (no API key needed)
```

**Research categories:** `smart-money` (`sm`), `token` (`tgm`), `profiler` (`prof`), `portfolio` (`port`), `prediction-market` (`pm`), `search`, `perp`, `points`

**Trade:** `quote`, `execute`, `bridge-status`, `limit-order` — DEX swaps on Solana and Base via best-quote aggregation (Jupiter / 0x), plus cross-chain bridges and Solana limit orders.

**Wallet:** `create`, `list`, `show`, `export`, `default`, `delete`, `send` — local or Privy server-side wallets (EVM + Solana).

Run `nansen schema --pretty` for the full subcommand and field reference.

## Trading

DEX swaps on `solana` and `base` with best-quote routing across pools — no need to hit Jupiter, Uniswap, or Aerodrome directly. Two-step: quote then execute.

```bash
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
```

**Cross-chain bridges** (Solana ↔ Base) via `--to-chain`:

```bash
nansen trade quote --chain base --to-chain solana --from USDC --to USDC --amount 1000000
nansen trade bridge-status --tx-hash <hash> --from-chain base --to-chain solana
```

**Limit orders** (Solana, Jupiter):

```bash
nansen trade limit-order create --from SOL --to USDC --amount 1000000000 --trigger-mint SOL --trigger-condition below --trigger-price 80
nansen trade limit-order list
```

Amounts are in base units (lamports, wei). Common symbols (`SOL`, `ETH`, `USDC`, `USDT`) resolve automatically. A wallet is required — set one with `nansen wallet default <name>`.

## Wallet

```bash
nansen wallet create --name my-wallet        # local keypair (EVM + Solana)
nansen wallet create --name my-wallet --provider privy  # server-side via Privy
nansen wallet list
nansen wallet default <name>
nansen wallet send --wallet <name> --to <addr> --amount <n> --chain <chain>
```

**Local wallets** are password-encrypted. Set `NANSEN_WALLET_PASSWORD` to skip the prompt.

**Privy wallets** are server-side — no password, no local key storage. Requires `PRIVY_APP_ID` and `PRIVY_APP_SECRET` env vars. Get credentials at [dashboard.privy.io](https://dashboard.privy.io).

## Key Options

| Option | Description |
|--------|-------------|
| `--chain <chain>` | Blockchain to query |
| `--limit <n>` | Result count |
| `--timeframe <tf>` | Time window: `5m` `1h` `6h` `24h` `7d` `30d` |
| `--fields <list>` | Comma-separated fields (reduces response size) |
| `--sort <field:dir>` | Sort results, e.g. `--sort value_usd:desc` |
| `--pretty` | Human-readable JSON |
| `--table` | Table format |
| `--stream` | NDJSON output for large results |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money addresses only |

## Supported Chains

`ethereum` `solana` `base` `bnb` `arbitrum` `polygon` `optimism` `avalanche` `linea` `scroll` `mantle` `ronin` `sei` `plasma` `sonic` `monad` `hyperevm` `iotaevm`

> Run `nansen schema` to get the current chain list (source of truth).

## Agent Tips

**Reduce token burn with `--fields`:**
```bash
nansen research smart-money netflow --chain solana --fields token_symbol,net_flow_usd --limit 10
```

**Use `--stream` for large results** — outputs NDJSON instead of buffering a giant array.

**ENS names** work anywhere `--address` is accepted: `--address vitalik.eth`

## Output Format

```json
{ "success": true,  "data": <api_response> }
{ "success": false, "error": "message", "code": "ERROR_CODE", "status": 401 }
```

**Critical error codes:**

| Code | Action |
|------|--------|
| `CREDITS_EXHAUSTED` | Stop all API calls immediately. Check [app.nansen.ai](https://app.nansen.ai). |
| `UNAUTHORIZED` | Wrong or missing key. Re-auth. |
| `RATE_LIMITED` | Auto-retried by CLI. |
| `UNSUPPORTED_FILTER` | Remove the filter and retry. |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found` | `npm install -g nansen-cli` |
| `UNAUTHORIZED` after login | `cat ~/.nansen/config.json` or set `NANSEN_API_KEY` |
| Empty perp results | Use `--symbol BTC`, not `--token`. Perps are Hyperliquid-only. |
| `UNSUPPORTED_FILTER` on token holders | Remove `--smart-money` — not all tokens have that data. |
| Huge JSON response | Use `--fields` to select columns. |

## Development

```bash
npm test              # mocked tests, no API key needed
npm run test:live     # live API (needs NANSEN_API_KEY)
```

See [AGENTS.md](AGENTS.md) for architecture and contributor guidance.

## License

[MIT](LICENSE) © [Nansen](https://nansen.ai)
