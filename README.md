# Nansen CLI

[![npm version](https://img.shields.io/npm/v/nansen-cli.svg)](https://www.npmjs.com/package/nansen-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Built by agents, for agents.** Command-line interface for the [Nansen API](https://docs.nansen.ai), designed for AI agents to research on-chain data, manage wallets, and trade through `nansen trade`.

Use it for both analytics and execution: `nansen research ...` returns structured on-chain data, while `nansen trade quote` / `nansen trade execute` handle DEX swaps on Solana and Base, including cross-chain bridges.

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

3. **MPP via tempo** (no key needed): install the [tempo CLI](https://docs.tempo.xyz) separately, run `tempo wallet login` to set up, then call the Nansen API through `tempo request`. The Nansen API selects the MPP rail when it sees `Authorization: Payment ...`. See [MPP / Tempo](#mpp--tempo) below.

## Commands

```
nansen research <category> <subcommand> [options]
nansen agent "<question>"             # AI research agent (200 credits, Pro)
nansen agent "<question>" --expert    # deeper analysis (750 credits, Pro)
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
nansen wallet <subcommand> [options]
nansen schema [command] [--pretty]    # full command reference (no API key needed)
```

**Research categories:** `smart-money` (`sm`), `token` (`tgm`), `profiler` (`prof`), `portfolio` (`port`), `prediction-market` (`pm`), `search`, `perp`, `points`

**Trade:** `quote`, `execute`, `bridge-status`, `limit-order` — DEX swaps on Solana and Base, cross-chain bridges, and Solana limit orders.

**Wallet:** `create`, `list`, `show`, `export`, `default`, `delete`, `send` — local or Privy server-side wallets (EVM + Solana).

Run `nansen schema --pretty` for the full subcommand and field reference.

## Trading

DEX swaps on `solana` and `base`. Two-step: quote then execute.

```bash
nansen trade quote --chain solana --from SOL --to USDC --amount 1000000000
nansen trade execute --quote <quoteId>
```

Cross-chain swaps work the same way — add `--to-chain`. Bridge providers (Li.Fi or Relay) are selected automatically based on best price.

```bash
nansen trade quote --chain base --to-chain solana --from ETH --to SOL --amount 0.0003 --amount-unit token
nansen trade execute --quote <quoteId>                # signed broadcast
nansen trade execute --quote <quoteId> --gasless      # Relay-only: solver pays gas
nansen trade bridge-status --tx-hash <hash> --from-chain base --to-chain solana
```

Amounts are in base units (lamports, wei) by default — use `--amount-unit token|usd|percent` for friendlier inputs. Common symbols (`SOL`, `ETH`, `USDC`, `USDT`) resolve automatically. A wallet is required — set one with `nansen wallet default <name>`.

## Limit Orders

Native price-triggered orders on **Solana**. Four subcommands:

```bash
nansen trade limit-order create \
  --from SOL --to USDC \
  --amount 1.5 \
  --trigger-mint SOL --trigger-condition below --trigger-price 80 \
  --slippage-bps 300 --expires 7d

nansen trade limit-order list                    # all orders
nansen trade limit-order list --state active     # only open
nansen trade limit-order list --state past       # filled or cancelled
nansen trade limit-order cancel --order <orderId>
nansen trade limit-order update --order <orderId> --trigger-price 85
```

`--amount` is in token units (`1.5` = 1.5 SOL). `--slippage-bps` is basis points (`300` = 3%, `100` = 1%); omit for auto. Minimum order value ~$10 (server-enforced). Local, Privy, and WalletConnect wallets all work.

For EVM chains, there's no native limit-order surface — pair an external venue's resting order with a `common-token-transfer` smart alert on the settlement wallet as a best-effort fill signal. See the `nansen-limit-orders` skill for details.

## Perpetuals

Hyperliquid perpetual trading via `nansen perp`. Uses the same wallet and `NANSEN_WALLET_PASSWORD` as DEX trading (requires an EVM wallet). Select the asset with `--coin` (`--symbol` is accepted as an alias).

```bash
nansen perp meta --filter ETH                                  # list assets + max leverage
nansen perp order --coin ETH --side buy --size 0.1 --price 1600 --type limit
nansen perp order --coin BTC --side sell --size 0.001 --price 95000 --type market \
  --take-profit 90000 --stop-loss 98000
nansen perp close --coin ETH --size 0.1 --price 1600 --side sell   # sell closes a long
nansen perp cancel --coin ETH --oid <orderId>
nansen perp leverage --coin ETH --leverage 5 --margin-type cross   # or isolated
nansen perp transfer --direction spot-to-perp --amount 25          # Spot<->Perps (or perp-to-spot)
nansen perp positions
nansen perp account                                            # value, unrealized PnL, margin, spot USDC
```

`--side` is `buy`/`long` or `sell`/`short` to open (`buy`/`sell` to close); `--tif` is `Gtc`/`Ioc`/`Alo`; `--slippage` is a decimal in `[0,1]`; `--leverage` is a whole integer capped at the asset max. Perp orders are irreversible once signed. USDC sent to a wallet via Hyperliquid's **Send** lands in the **Spot** balance (shown as `Spot USDC`); move it to Perps with `perp transfer` before trading. See the `nansen-trading` skill for details.

## Bridge

Move USDC between EVM chains and Hyperliquid via `nansen bridge`. Uses the same wallet and `NANSEN_WALLET_PASSWORD` as perps and DEX trading. Quotes are written to a local file and executed by id; execution signs and broadcasts.

```bash
nansen bridge quote --from-chain base --to-chain hyperliquid --from-token USDC --amount 1000000
nansen bridge execute --quote <quoteId>
nansen bridge execute --quote <quoteId> --nonce 20 --priority-fee 5   # replace a stuck EVM deposit
nansen bridge status --request-id <id>
```

Supported routes: `base → hyperliquid` (deposit), and `hyperliquid → base`/`ethereum`/`arbitrum` (withdraw). Deposits broadcast an EVM transaction locally, so only Base is offered on the deposit side; run `nansen bridge help` for the current list. `--amount` is a base-unit integer by default; pass `--amount-unit token` for a human amount. `--recipient` defaults to the wallet's own EVM address. `--priority-fee`/`--max-fee` (gwei) and `--nonce` apply only to EVM deposit legs and let a stuck transaction be replaced. Bridge transfers are irreversible once signed.

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
| You hold USDT0 on X Layer and want to pay from there | x402 (`nansen wallet`) |
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
{ "success": false, "error": "message", "code": "ERROR_CODE", "status": 401, "requestId": "...", "details": { ... } }
```

**Critical error codes:**

| Code | Action |
|------|--------|
| `CREDITS_EXHAUSTED` | Stop all API calls immediately. `details.credits.remaining` is your actual balance. Top up at [app.nansen.ai/api](https://app.nansen.ai/api). |
| `UNAUTHORIZED` | Wrong or missing key. Re-auth. |
| `RATE_LIMITED` | Auto-retried by CLI. `details.rateLimit.resetSeconds` is how long the window needs to drain. |
| `UNSUPPORTED_FILTER` | Remove the filter and retry. |
| `SERVER_ERROR` | Not your fault. Quote `details.requestId` when reporting it. |

**Error metadata.** When the API reports them, `details` carries:

| Field | Meaning |
|-------|---------|
| `requestId` | Identifies this call end to end. Quote it in any support report. Opaque — do not parse it. Also hoisted to the top level of the error envelope. |
| `credits` | `used`, `remaining`, `cost` (the authoritative charge for this call) |
| `rateLimit` | `limit`, `remaining`, `resetSeconds` |

Any field may be absent or `null`, meaning unknown — never assume zero. A low-balance warning goes to **stderr**, so stdout stays pure JSON.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found` | `npm install -g nansen-cli` |
| Global install reports an older version | `npm i -g nansen-cli@latest --registry=https://registry.npmjs.org/ --prefer-online`, then check `which -a nansen` for stale binaries |
| `UNAUTHORIZED` after login | `cat ~/.nansen/config.json` or set `NANSEN_API_KEY` |
| Empty perp _research_ results | Use `--symbol BTC`, not `--token`. Perps are Hyperliquid-only. |
| `perp` _trading_ prints the usage banner | Trading needs `--coin BTC` (`--symbol` also works); see the Perpetuals section. |
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
