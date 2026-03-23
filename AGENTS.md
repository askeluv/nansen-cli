# AGENTS.md

CLI for the [Nansen API](https://docs.nansen.ai) — designed for AI agents.
30+ endpoints across Smart Money, Profiler, Token God Mode, Portfolio, Perps.

## Commands

```bash
npm install && npm test          # mocked tests (no API key)
node src/index.js <cmd> [opts]   # run locally
nansen schema                    # full JSON schema of every command + return field
```

## Layout

```
src/
├── index.js        # Entry point → runCLI()
├── cli.js          # Command router, arg parsing, schema, formatOutput()
├── api.js          # NansenAPI client (REST, retry, cache, x402 auto-pay)
├── wallet.js       # Wallet CRUD (create/list/show/export/delete/send)
├── trading.js      # Quote + execute swaps, including cross-chain (Li.Fi via API)
├── transfer.js     # Token/native transfers (EVM + Solana)
├── x402.js         # x402 payment orchestration (picks network, signs)
├── x402-evm.js     # EVM payment signing (EIP-3009)
├── x402-svm.js     # Solana payment signing (SPL transfer)
├── crypto.js       # Key encryption/decryption (AES-256-GCM)
├── rpc-urls.js     # Single source of truth for chain RPC endpoints (CHAIN_RPCS)
└── update-check.js # Version upgrade notice
```

Command routing: `buildCommands()` (cli.js) + `buildWalletCommands()` (wallet.js) + `buildTradingCommands()` (trading.js), merged in `runCLI()`.

## Data Flows

```
Trade:       CLI args → GET /quote → wallet decrypt → sign tx → POST /execute
Cross-chain: CLI args → GET /quote (toChainIndex) → sign source tx → POST /execute → poll /bridge/status
x402:        any API call → 402 → x402.js ranks requirements → sign USDC (EVM first, Solana fallback)
```

## Style

- **ESM only** — `import`/`export`, no TypeScript, no transpilation
- **BigInt for token amounts** — never floating point
- **Research commands** — return data objects, CLI layer formats via `formatOutput()` to stdout
- **Operational commands** (trade, wallet, login) — print human-readable text via `log()` to stdout, return `undefined`
- **No interactive prompts in core** — use env vars (`NANSEN_WALLET_PASSWORD`, `NANSEN_API_KEY`)
- **Actionable errors** — `"Not logged in. Run: nansen login"` not `"Authentication failed"`


## Testing

Vitest. Mock all RPC/API calls — never hit real networks.

### Required RPC mocks by code path

- **EVM transfers:** `eth_getBalance`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getTransactionCount`, `eth_estimateGas`, `eth_getCode`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`
- **Solana transfers:** `getBalance`, `getLatestBlockhash`, `sendTransaction`, `getSignatureStatuses`
- **SPL tokens** (add): `getTokenAccountsByOwner`, `getAccountInfo`
- **Wallet ops:** No RPC mocks (file I/O). Mock `fs` for paths.
- **API calls:** `{ ok: true, json: () => ({...}) }` or `{ ok: false, status: 402, headers: new Headers({...}) }` for x402

If you are contributing changes, read [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist.

## Endpoint Quirks

- `token holders --smart-money` → `UNSUPPORTED_FILTER` for tokens without SM tracking
- `token flow-intelligence` → may return all-zero flows for illiquid tokens (not an error)
- `token screener --search` → client-side filtering (fetches 500, filters locally)
- `token ohlcv` → no pagination/limit support; returns all candles for the timeframe
- `--fields` → applies to the entire response tree including `success`/`data` wrapper
- Profiler beta endpoints use `recordsPerPage` not `per_page` (CLI handles automatically)
- `profiler perp-positions` → no pagination support; API ignores the parameter
- `smart-money netflow --timeframe` → silently accepted but has no effect; response always includes all timeframes (1h, 24h, 7d, 30d)
- `nansen research search` → does NOT match by raw address (returns 0 results); use `profiler labels` for address-based lookup
- `--chain bnb` → accepted as input but response `chain` field returns `bsc`

## Known Gotchas

1. **EIP-7702 delegated accounts** on Base have contract code — always `eth_estimateGas`, never hardcode 21000
2. **Solana SPL account ordering:** writable (destATA) before readonly (mint) in tx message
3. **`getSignatureStatuses`** not `confirmTransaction` — latter is deprecated on public RPCs
4. **`--max` native SOL:** reserve 5000 lamports. EVM L2s: reserve 3x gas for L1 data fees
5. **Token-2022:** use `TOKEN_2022_PROGRAM_ID` + `TransferCheckedInstruction`
6. **CreateATA path** (transfer.js) has limited test coverage — add tests if modifying
7. **`CHAIN_RPCS`** in `src/rpc-urls.js` is the single source of truth for chain RPC endpoints — both `transfer.js` and `trading.js` import from it. Adding a new chain only requires one edit here. Override via `NANSEN_BASE_RPC`, `NANSEN_EVM_RPC`, `NANSEN_SOLANA_RPC`.
8. **`src/schema.json` is manually maintained** — no codegen. When adding a new CLI command or option, update schema.json by hand. Key fields: `description`, `required`, `default`, `chains`. Omit `type`, `enum`, `returns` (those live in skills). AI editors: do not skip this step.
9. **Cross-chain bridge polling:** `pollBridgeStatus` has a 10-minute timeout. Bridges can take longer — users can check manually with `nansen trade bridge-status`.

## Networks

- **EVM transfers:** Ethereum (1), Base (8453) only. `CHAIN_IDS` in transfer.js.
- **Solana:** mainnet-beta. Native SOL, SPL, Token-2022.
- **x402:** $0.05 USDC per call. Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
