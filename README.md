# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Built by agents, for agents.** Command-line interface for the [Nansen API](https://docs.nansen.ai), designed for AI agents.

## Installation

```bash
npm install -g nansen-cli
npx skills add nansen-ai/nansen-cli  # load agent skill files
```

## Auth

Three options — pick whichever fits your setup:

1. **API key** (subscription):
   ```bash
   nansen login --api-key <key>   # save key to ~/.nansen/config.json
   nansen login --human           # interactive prompt
   export NANSEN_API_KEY=...      # env var (highest priority)
   nansen logout                  # remove saved key
   ```
   Get your API key at [app.nansen.ai/auth/agent-setup](https://app.nansen.ai/auth/agent-setup).

2. **x402 micropayment** (no key needed): `nansen wallet create`, fund with USDC on Base or Solana, or USDT0 on X Layer, then call any endpoint — the CLI signs `Payment-Signature` headers automatically on 402 responses. See [Wallet](#wallet).

   > Note: X Layer USDT0 x402 payment support requires the OKX facilitator to be enabled on the server (see `x402_xlayer_wallet` / OKX env vars). If your API returns `invalid_exact_evm_signature` for X Layer, confirm the server is running a version that includes the OKX facilitator integration. Use Base USDC as a fallback.

3. **MPP via tempo** (no key needed): install the [tempo CLI](https://docs.tempo.xyz) separately, run `tempo wallet` to set up, then call the Nansen API through `tempo request`. The Nansen API selects the MPP rail when it sees `Authorization: Payment ...`. See [MPP / Tempo](#mpp--tempo) below.

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

**Trade:** `quote`, `execute`, `bridge-status` — DEX swaps on Solana and Base, including cross-chain bridges.

**Wallet:** `create`, `list`, `show`, `export`, `default`, `delete`, `send` — local or Privy server-side wallets (EVM + Solana).

Run `nansen schema --pretty` for the full subcommand and field reference.

## Trading

DEX swaps on `solana` and `base`. Two-step: quote then execute.

```bash
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
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

## MPP / Tempo

The Nansen API supports [MPP](https://mpp.dev/protocol) (Tempo's stablecoin payment rail) as an alternative to API keys and x402. MPP is handled by the **separate** [tempo CLI](https://docs.tempo.xyz) — `nansen-cli` itself does not sign MPP credentials. You use the two CLIs side-by-side.

**One-time setup:**

```bash
# 1. Install the tempo CLI
curl -fsSL https://tempo.xyz/install | bash
# 2. Log in + fund the tempo wallet
tempo wallet login
tempo wallet fund     # follow the on-screen instructions to deposit USDC
```

**Calling the Nansen API via tempo:**

```bash
tempo request POST https://api.nansen.ai/api/v1/smart-money/netflow \
  --json '{"chains":["solana"],"pagination":{"page":1,"page_size":10}}'
```

`tempo request` handles the full `Authorization: Payment` challenge/response: on a 402 with `WWW-Authenticate: Payment ...` it signs a Tempo credential, retries, and surfaces the `Payment-Receipt` header on success.

**When to use which rail:**

| Situation | Rail |
|---|---|
| You have a subscription | API key |
| You want anonymous pay-per-call with a Base/Solana wallet you already manage | x402 (`nansen wallet`) |
| You hold USDT0 on X Layer and want to pay from there | x402 (`nansen wallet`) — fund with USDT0 on X Layer, or use Base USDC as an alternative |
| You already use tempo for other paid APIs, or want micropayments without managing your own wallet keys | MPP (`tempo request`) |

> Note: MPP is server-side opt-in (`MPP_ENABLED=true` on the API). It's available on dev today and rolling out to prod — if `tempo request` returns a non-MPP 402, fall back to x402 or an API key.

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
