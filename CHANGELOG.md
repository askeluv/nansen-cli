# Changelog

## 1.26.0

### Minor Changes

- [#380](https://github.com/nansen-ai/nansen-cli/pull/380) [`12e4e25`](https://github.com/nansen-ai/nansen-cli/commit/12e4e25d50f50ff1ebbae160ba1016abd1cdbb4d) Thanks [@TimNooren](https://github.com/TimNooren)! - Add `--amount-unit percent` to trade commands, allowing trades as a percentage of wallet balance (e.g. `--amount 100 --amount-unit percent` to sell all)

### Patch Changes

- [#382](https://github.com/nansen-ai/nansen-cli/pull/382) [`d9c87ef`](https://github.com/nansen-ai/nansen-cli/commit/d9c87ef9df51a3e9c53ea59674ad9efe9aa33fb7) Thanks [@kome12](https://github.com/kome12)! - fix: default `profiler balance` chain to `'all'` instead of `'ethereum'`

  Previously, `nansen profiler balance --address <addr>` without `--chain` defaulted to `ethereum`, returning empty results for wallets with no ETH mainnet holdings (e.g. Base-only or Solana-only wallets). Now defaults to `'all'`, letting the API auto-route based on address format.

## 1.25.1

### Patch Changes

- [#367](https://github.com/nansen-ai/nansen-cli/pull/367) [`9fea10a`](https://github.com/nansen-ai/nansen-cli/commit/9fea10a844acbaccf37a348dfd4efd5c32f76a4a) Thanks [@kome12](https://github.com/kome12)! - add --premium-labels flag to tgm/holders, tgm/pnl-leaderboard, tgm/perp-pnl-leaderboard, and perp-leaderboard endpoints

## 1.25.0

### Minor Changes

- [#363](https://github.com/nansen-ai/nansen-cli/pull/363) [`6ae402e`](https://github.com/nansen-ai/nansen-cli/commit/6ae402ef1e5bdeacf83fe04bcf6e8e0c9f9c91b7) Thanks [@TimNooren](https://github.com/TimNooren)! - Add `--amount-unit usd` to trade commands — specify swap amounts in USD

### Patch Changes

- [#374](https://github.com/nansen-ai/nansen-cli/pull/374) [`0f14803`](https://github.com/nansen-ai/nansen-cli/commit/0f148031ef7590f3405c1dba9f31ad83768a7141) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix cross-chain quote display: show adaptive precision for sub-cent bridge fees, "< 1 min" for fast bridges, and echo --to-wallet address in output

- [#366](https://github.com/nansen-ai/nansen-cli/pull/366) [`f358fff`](https://github.com/nansen-ai/nansen-cli/commit/f358fffcc80136c4e609f2e056f2c5ffb052d626) Thanks [@kome12](https://github.com/kome12)! - fix(token): replace dead `--days` param with working `--timeframe` for `token flow-intelligence`

  The `--days` option was accepted but never sent to the API, resulting in always fetching `1d` data. This replaces it with `--timeframe` (enum: `1h | 6h | 12h | 1d | 7d`, default `1d`) which maps correctly to the API parameter.

## 1.24.0

### Minor Changes

- [#333](https://github.com/nansen-ai/nansen-cli/pull/333) [`c8fe79c`](https://github.com/nansen-ai/nansen-cli/commit/c8fe79c4ec5e1ba6acf2498d9bfbe14c726a913c) Thanks [@imhta](https://github.com/imhta)! - Add cross-chain swap support between Solana and Base via Li.Fi bridge.

  `nansen trade quote --chain base --to-chain solana --from ETH --to SOL --amount 0.01 --amount-unit token`
  `nansen trade execute --quote <id>`

  Bridge status can be checked with `nansen trade bridge-status`.

### Patch Changes

- [#365](https://github.com/nansen-ai/nansen-cli/pull/365) [`56335af`](https://github.com/nansen-ai/nansen-cli/commit/56335af600e51436b30ad2fc1530aa754bac2a2f) Thanks [@TimNooren](https://github.com/TimNooren)! - Add balance pre-check before quote API calls. Validates sell token balance, auto-adjusts near-full-balance trades (≤2% over), and reserves gas fees for native token swaps (SOL/ETH).

## 1.23.1

### Patch Changes

- [#361](https://github.com/nansen-ai/nansen-cli/pull/361) [`ff22da3`](https://github.com/nansen-ai/nansen-cli/commit/ff22da376c1072ef06e84054f6ee31c058e6e08c) Thanks [@TimNooren](https://github.com/TimNooren)! - fix(alerts): error when --webhook-secret is passed without --webhook

  Previously, passing --webhook-secret with a non-webhook channel (e.g. --telegram)
  silently discarded the secret with no warning. The alert was created successfully
  but without any signing, giving the false impression that the secret was active.

  Now throws an actionable error: "--webhook-secret requires --webhook".

- [#358](https://github.com/nansen-ai/nansen-cli/pull/358) [`70ee712`](https://github.com/nansen-ai/nansen-cli/commit/70ee71205343fb2d003eb5f50144e266bdc6109e) Thanks [@TimNooren](https://github.com/TimNooren)! - Add pre-quote trade input validation: rejects same-token swaps, invalid address formats, and non-positive amounts before any network call.

## 1.23.0

### Minor Changes

- [#341](https://github.com/nansen-ai/nansen-cli/pull/341) [`4b60056`](https://github.com/nansen-ai/nansen-cli/commit/4b6005697d52b5d432b9b32bcd1d36422f9166cc) Thanks [@gulshngill](https://github.com/gulshngill)! - Add `--webhook <url>` and `--webhook-secret <secret>` flags to `alerts create` and `alerts update`.

  Allows alerts to be delivered to any HTTP/HTTPS endpoint via POST, alongside
  the existing `--telegram`, `--slack`, and `--discord` channels. The optional
  `--webhook-secret` enables HMAC payload signing for verification.

### Patch Changes

- [#344](https://github.com/nansen-ai/nansen-cli/pull/344) [`3dc09cc`](https://github.com/nansen-ai/nansen-cli/commit/3dc09cc8aa38cd4da4ae305f83e9599efb3b9ff9) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add nansen-agent-guide skill — routing guide for when to use `nansen agent` vs direct CLI data commands

- [#347](https://github.com/nansen-ai/nansen-cli/pull/347) [`a243c7a`](https://github.com/nansen-ai/nansen-cli/commit/a243c7a33f28057949d2060c732083642422eb18) Thanks [@kome12](https://github.com/kome12)! - Add --buy-or-sell option to `token who-bought-sold` command — allows filtering by buy or sell side (BUY | SELL, defaults to BUY)

## 1.22.0

### Minor Changes

- [#336](https://github.com/nansen-ai/nansen-cli/pull/336) [`c3b1fbd`](https://github.com/nansen-ai/nansen-cli/commit/c3b1fbdee46c15326a1656bf27a314f6c55dddf8) Thanks [@kome12](https://github.com/kome12)! - Add --label option to `token flows` command to filter by holder segment (top_100_holders, smart_money, public_figure, whale, exchange).

- [#334](https://github.com/nansen-ai/nansen-cli/pull/334) [`83244c6`](https://github.com/nansen-ai/nansen-cli/commit/83244c658d4ece2072dea0c6ed405a088c98aa4f) Thanks [@kome12](https://github.com/kome12)! - Add `--include-stablecoins` flag to `token screener` command. Pass `--include-stablecoins false` to exclude stablecoins from screener results (API default is `true`). Supports combined usage with `--smart-money`.

- [#339](https://github.com/nansen-ai/nansen-cli/pull/339) [`27ebcfc`](https://github.com/nansen-ai/nansen-cli/commit/27ebcfc2a3afd836db595df6d5a2a5f9242b624c) Thanks [@TimNooren](https://github.com/TimNooren)! - Add --amount-unit token flag to trade quote for human-readable amounts

## 1.21.0

### Minor Changes

- [#315](https://github.com/nansen-ai/nansen-cli/pull/315) [`908fa0c`](https://github.com/nansen-ai/nansen-cli/commit/908fa0ccdf18cb79b7efb58b9b31f66e0afedff6) Thanks [@TimNooren](https://github.com/TimNooren)! - Add `nansen agent` command for the Nansen AI research agent with fast/expert modes, SSE streaming, conversation continuation, and JSON output.

### Patch Changes

- [#326](https://github.com/nansen-ai/nansen-cli/pull/326) [`1532ba4`](https://github.com/nansen-ai/nansen-cli/commit/1532ba420174ed7635a42641f0c1a2802077fdc0) Thanks [@TimNooren](https://github.com/TimNooren)! - Show API credit cost in research subcommand help text (fetched from OpenAPI spec, cached 24h).

- [#330](https://github.com/nansen-ai/nansen-cli/pull/330) [`a6b9b8f`](https://github.com/nansen-ai/nansen-cli/commit/a6b9b8fc7d291ee7375941bb275c224939338161) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Suppress misleading PASSWORD_REQUIRED error when `--provider privy` is specified. Privy wallets don't need a password — only the Privy-specific credentials error is now shown when PRIVY_APP_ID/PRIVY_APP_SECRET are missing.

- [#329](https://github.com/nansen-ai/nansen-cli/pull/329) [`f047833`](https://github.com/nansen-ai/nansen-cli/commit/f047833c7e6fb55cb713e0b69f82282fe87d4566) Thanks [@TimNooren](https://github.com/TimNooren)! - Limit deprecation warnings and update notices to help output only, keeping stdout/stderr clean for programmatic usage.

- [#332](https://github.com/nansen-ai/nansen-cli/pull/332) [`e9b6de1`](https://github.com/nansen-ai/nansen-cli/commit/e9b6de17fdba3f46733dff026c2495c095bfbf35) Thanks [@0xlaveen](https://github.com/0xlaveen)! - docs: add trading examples and Privy wallet setup to README

## 1.20.0

### Minor Changes

- [#302](https://github.com/nansen-ai/nansen-cli/pull/302) [`3f0a5ab`](https://github.com/nansen-ai/nansen-cli/commit/3f0a5abad463c0386122efbe746809913aa823ba) Thanks [@arein](https://github.com/arein)! - Add post-install onboarding that interactively offers to install the Nansen AI coding skill and run a test query after `npm install -g nansen-cli`. Non-interactive environments (CI, piped stdin) receive a one-liner tip and are never blocked.

### Patch Changes

- [#313](https://github.com/nansen-ai/nansen-cli/pull/313) [`bb4d9e4`](https://github.com/nansen-ai/nansen-cli/commit/bb4d9e475158147645cae9b8bdd2555568a1e515) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Update API key setup URL from app.nansen.ai/api to app.nansen.ai/auth/agent-setup across CLI help text, error messages, README, and postinstall script.

## 1.19.0

### Minor Changes

- [#306](https://github.com/nansen-ai/nansen-cli/pull/306) [`f685eb8`](https://github.com/nansen-ai/nansen-cli/commit/f685eb8b87d2915a7a94e8c1a3d92f84e4802e4a) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Rename 30 skills for clarity and clawhub slug uniqueness. Abbreviations expanded (`pm` → `polymarket`, `sm` prefix added where relevant), ambiguous names made specific (`nansen-wallet` → `nansen-wallet-manager`, `nansen-profiler` → `nansen-wallet-profiler`, `nansen-search` → `nansen-general-search`, `nansen-trade` → `nansen-trading`, etc.).

### Patch Changes

- [#308](https://github.com/nansen-ai/nansen-cli/pull/308) [`569d7d4`](https://github.com/nansen-ai/nansen-cli/commit/569d7d43e428732d3c10b4e57368cb12ef0086c3) Thanks [@kome12](https://github.com/kome12)! - fix: include src subdirectories in npm package

  The `files` field in package.json used `src/*.js` which only matched files directly in `src/`, causing `src/commands/` to be missing from the 1.18.0 publish. Changed to `src/**/*.js` to include all subdirectories recursively, and added `!src/__tests__/**` to exclude test files from the package.

## 1.18.0

### Minor Changes

- [#265](https://github.com/nansen-ai/nansen-cli/pull/265) [`c3de691`](https://github.com/nansen-ai/nansen-cli/commit/c3de6914dcdd29f54d027f0cc415c23dd646c003) Thanks [@TimNooren](https://github.com/TimNooren)! - Add `nansen alerts` command for managing smart alerts (list, create, update, toggle, delete).

  Supports three alert types: `sm-token-flows`, `common-token-transfer`, and `smart-contract-call`.
  Named flags (`--inflow-1h-min`, `--chains`, `--telegram`, etc.) let you build alerts without raw JSON;
  a `--data` escape hatch is available for full config overrides.

  Also adds a `nansen-alerts` skill for agent integration.

- [#295](https://github.com/nansen-ai/nansen-cli/pull/295) [`3ddcbde`](https://github.com/nansen-ai/nansen-cli/commit/3ddcbdec50d55e4477cd3f53c5064126dbd8580a) Thanks [@kome12](https://github.com/kome12)! - feat: add `nansen web search` and `nansen web fetch` commands (ECINT-6393)

  - `nansen web search <query> [query...]` — search the web for one or more queries in parallel via `/api/v1/search/web-search`
  - `nansen web fetch <url> [url...] --question <q>` — fetch and analyze URL content with AI via `/api/v1/search/web-fetch`

### Patch Changes

- [#293](https://github.com/nansen-ai/nansen-cli/pull/293) [`bcd95a8`](https://github.com/nansen-ai/nansen-cli/commit/bcd95a88942e96018337ae6b7de9f2abdbdc3464) Thanks [@TimNooren](https://github.com/TimNooren)! - Add default values for all required alert data fields to match backend schema

- [#265](https://github.com/nansen-ai/nansen-cli/pull/265) [`c3de691`](https://github.com/nansen-ai/nansen-cli/commit/c3de6914dcdd29f54d027f0cc415c23dd646c003) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix `alerts list` filtering (`--type`, `--enabled`, `--disabled`, `--chain`, `--token-address`, `--limit`, `--offset`).

  Filters were sent as query params but silently ignored by the API. Now applied client-side after fetching all alerts.

- [#301](https://github.com/nansen-ai/nansen-cli/pull/301) [`cda6796`](https://github.com/nansen-ai/nansen-cli/commit/cda6796642c588965111c53c583af2b21444d30b) Thanks [@kome12](https://github.com/kome12)! - fix: add missing openclaw metadata to 19 skills

- [#294](https://github.com/nansen-ai/nansen-cli/pull/294) [`8a1cc7b`](https://github.com/nansen-ai/nansen-cli/commit/8a1cc7bdfbd9597860384dfd40fd28705e5c947c) Thanks [@yodablocks](https://github.com/yodablocks)! - fix: include skills/ directory in published npm package

## 1.17.0

### Minor Changes

- [#279](https://github.com/nansen-ai/nansen-cli/pull/279) [`174a3d6`](https://github.com/nansen-ai/nansen-cli/commit/174a3d612b3f198c5e5b979c269d896f9d906704) Thanks [@kome12](https://github.com/kome12)! - Add `nansen account` command to verify API key and check credit balance

  Users can now run `nansen account` to confirm their API key is valid and see
  their current plan and remaining credits — without consuming any credits.

  This calls the new `GET /api/v1/account` endpoint (ECINT-6365).

- [#234](https://github.com/nansen-ai/nansen-cli/pull/234) [`10a5ced`](https://github.com/nansen-ai/nansen-cli/commit/10a5ced9f1f751666d034cecfc431e335183741c) Thanks [@kome12](https://github.com/kome12)! - Reduced schema.json to a minimal format (~66% smaller).

### Patch Changes

- [#272](https://github.com/nansen-ai/nansen-cli/pull/272) [`50213c1`](https://github.com/nansen-ai/nansen-cli/commit/50213c1d82375a153aa1bad3a53bbd7059cd9f5b) Thanks [@TimNooren](https://github.com/TimNooren)! - fix: show human-readable error when trade fails due to insufficient ETH

  When a wallet has no ETH and a trade is attempted, the raw Ethereum RPC
  error ("insufficient funds for gas \* price + value: ... have 0 want
  400000000000000 (supplied gas 600000000)") is now translated into a
  user-friendly message showing amounts in ETH with a funding hint, e.g.
  "Insufficient ETH: wallet has 0.000000 ETH but this trade needs ~0.000400
  ETH (amount + gas). Send ETH to 0x... before trading."

## 1.16.1

### Patch Changes

- [#249](https://github.com/nansen-ai/nansen-cli/pull/249) [`0c17437`](https://github.com/nansen-ai/nansen-cli/commit/0c17437cf65d8b4f0516ede386adefec57d8ab3d) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add `pm` to top-level COMMAND_ALIASES so `nansen pm <subcommand>` works (previously only `nansen research pm <subcommand>` resolved the alias)

- [#244](https://github.com/nansen-ai/nansen-cli/pull/244) [`6427a9f`](https://github.com/nansen-ai/nansen-cli/commit/6427a9fdb7295dee94d7aed10cdb0164c46c7d73) Thanks [@Nicolai1205](https://github.com/Nicolai1205)! - Add 7 new agent skills: nansen-token-search, nansen-sm-trend, nansen-wallet-cluster, nansen-wallet-compare, nansen-token-indicators, nansen-cross-chain-flow, nansen-batch-wallet. All validated against live API.

## 1.16.0

### Minor Changes

- [#196](https://github.com/nansen-ai/nansen-cli/pull/196) [`0c286c2`](https://github.com/nansen-ai/nansen-cli/commit/0c286c2d75f977894da8ff18a105aaf21f55f9f2) Thanks [@arein](https://github.com/arein)! - Add Solana WalletConnect support for trading (quote and execute). Solana wallets like Phantom and Solflare can now sign DEX swap transactions via WalletConnect v2.

## 1.15.0

### Minor Changes

- [#216](https://github.com/nansen-ai/nansen-cli/pull/216) [`5b88241`](https://github.com/nansen-ai/nansen-cli/commit/5b882411134efc5ece44d640adc105c8dd8c5771) Thanks [@TimNooren](https://github.com/TimNooren)! - Unified wallet abstraction: Privy server wallets are first-class citizens.

  - `wallet create --provider privy` creates EVM + Solana wallets via Privy and stores a local reference
  - All wallet commands (list, show, delete, default, send) work by name regardless of provider
  - Trading (quote + execute) supports Privy wallets with sign-only + Trading API broadcast
  - x402 auto-payment routes through Privy when credentials are configured

### Patch Changes

- [#232](https://github.com/nansen-ai/nansen-cli/pull/232) [`443aaad`](https://github.com/nansen-ai/nansen-cli/commit/443aaad15da051ac65e0999b4c4b09436050d0fe) Thanks [@kome12](https://github.com/kome12)! - Remove unsupported chains (zksync, unichain) from CLI

## 1.14.0

### Minor Changes

- [#231](https://github.com/nansen-ai/nansen-cli/pull/231) [`c3968da`](https://github.com/nansen-ai/nansen-cli/commit/c3968dacb52521235ad6502321650148ac825d01) Thanks [@araa47](https://github.com/araa47)! - Agent-first secure wallet flow — OS keychain persistence, no interactive prompts

  - **New `src/keychain.js`**: Password persistence via OS keychain (macOS Keychain / Linux secret-tool), with base64-encoded `.credentials` file fallback for containers/CI. Zero npm dependencies.
  - **Non-interactive by default**: All readline prompts removed. Agents get structured JSON errors (`PASSWORD_REQUIRED`, `API_KEY_REQUIRED`) with actionable instructions. `--human` flag re-enables interactive mode.
  - **Two-step wallet creation**: Agent asks user for password, runs `NANSEN_WALLET_PASSWORD=<pw> nansen wallet create`. Password auto-persists to keychain — all future operations are passwordless.
  - **New commands**: `wallet secure` (migrate to keychain), `wallet forget-password` (clear from all stores).
  - **Bug fixes**: Clear `passwordHash` on last wallet delete, verify password before keychain writes, exit non-zero when keychain migration fails, source-aware error messages.
  - **New skill**: `nansen-wallet-migration` for migrating from old `~/.nansen/.env` storage to keychain.

## 1.13.1

### Patch Changes

- [#225](https://github.com/nansen-ai/nansen-cli/pull/225) [`051e4a3`](https://github.com/nansen-ai/nansen-cli/commit/051e4a353641d000facd2133810c059981b9ac7f) Thanks [@TimNooren](https://github.com/TimNooren)! - Remove "recommended, lower fees" label from Base network in wallet create output

## 1.13.0

### Minor Changes

- [#107](https://github.com/nansen-ai/nansen-cli/pull/107) [`5877c06`](https://github.com/nansen-ai/nansen-cli/commit/5877c06061c1d32998fa3ce011c16f4352fc22dc) Thanks [@marius-reed](https://github.com/marius-reed)! - Add 11 prediction market (Polymarket) endpoints under `nansen research pm`. Includes OHLCV, orderbook, top holders, trades, screeners, PnL, position detail, and categories. Supports `--market-id`, `--address`, `--sort-by`, `--query`, `--status` flags with pagination, sorting, and table output.

## 1.12.0

### Minor Changes

- [#207](https://github.com/nansen-ai/nansen-cli/pull/207) [`73ca500`](https://github.com/nansen-ai/nansen-cli/commit/73ca5009c03ad541673165ca6b50f33ff4cc1673) Thanks [@TimNooren](https://github.com/TimNooren)! - Add --unsafe-no-password flag to wallet create for agent-friendly passwordless wallets.

### Patch Changes

- [#212](https://github.com/nansen-ai/nansen-cli/pull/212) [`726c29d`](https://github.com/nansen-ai/nansen-cli/commit/726c29d2676c8a37772299c6237b44890493dfa5) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Clarify empty input handling in parseAddressList with explicit early return

- [#218](https://github.com/nansen-ai/nansen-cli/pull/218) [`8c4dd71`](https://github.com/nansen-ai/nansen-cli/commit/8c4dd71ce215026e149a6b097540c46622f13d3a) Thanks [@TimNooren](https://github.com/TimNooren)! - fix: `nansen changelog --since <version>` now correctly filters changeset-format entries (## x.y.z) in addition to Keep a Changelog entries (## [x.y.z])

- [#209](https://github.com/nansen-ai/nansen-cli/pull/209) [`a6dc1ed`](https://github.com/nansen-ai/nansen-cli/commit/a6dc1ed9dc40ad3506e7debe09746d463a70c14d) Thanks [@0xlaveen](https://github.com/0xlaveen)! - fix: prevent --help from executing destructive commands (logout, schema, cache)

## 1.11.2

### Patch Changes

- [#205](https://github.com/nansen-ai/nansen-cli/pull/205) [`dba24aa`](https://github.com/nansen-ai/nansen-cli/commit/dba24aaa64b2083fdbaa85a002758bfe21d9f4a0) Thanks [@TimNooren](https://github.com/TimNooren)! - Add hot wallet and password handling warnings to wallet create output

## 1.11.1

### Patch Changes

- [#194](https://github.com/nansen-ai/nansen-cli/pull/194) [`89225f5`](https://github.com/nansen-ai/nansen-cli/commit/89225f5d5b566f7eda77b1876c77545c2feb6a1c) Thanks [@TimNooren](https://github.com/TimNooren)! - fix: --help on trade subcommands and wallet subcommands now shows full help identical to the no-args case

- [#199](https://github.com/nansen-ai/nansen-cli/pull/199) [`9ae981e`](https://github.com/nansen-ai/nansen-cli/commit/9ae981e6dcf7fa663e47a3608afab7f12e0a9463) Thanks [@TimNooren](https://github.com/TimNooren)! - fix: replace misleading `walletconnect connect` command reference in x402 payment error with actionable guidance mentioning both local wallet (`nansen wallet create`) and external WalletConnect CLI options

## 1.11.0

### Minor Changes

- [#186](https://github.com/nansen-ai/nansen-cli/pull/186) [`feecc50`](https://github.com/nansen-ai/nansen-cli/commit/feecc5080254b55aaef0addb646279d52a468063) Thanks [@TimNooren](https://github.com/TimNooren)! - Trade commands output to stdout instead of stderr; wallet send prints human-readable text instead of JSON

### Patch Changes

- [#166](https://github.com/nansen-ai/nansen-cli/pull/166) [`c1034db`](https://github.com/nansen-ai/nansen-cli/commit/c1034dbb4bf2fc173f377cbc0adbbbe3e67873aa) Thanks [@0xlaveen](https://github.com/0xlaveen)! - fix: pass --page parameter correctly in smart-money, profiler, token, perp, and points commands

- [#137](https://github.com/nansen-ai/nansen-cli/pull/137) [`1214767`](https://github.com/nansen-ai/nansen-cli/commit/12147675aadfd0bd97627cb2f41f1dcc5205b0d7) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add missing sort/filters options to profiler schema and fix pnl sort/filters forwarding

## 1.10.1

### Patch Changes

- [#133](https://github.com/nansen-ai/nansen-cli/pull/133) [`4cbeb65`](https://github.com/nansen-ai/nansen-cli/commit/4cbeb6510c286660f611117d2d8b0508f2340e31) Thanks [@0xlaveen](https://github.com/0xlaveen)! - fix: correct profiler pagination parameter from `recordsPerPage` to `per_page`; remove unsupported pagination from pnl-summary; add --limit to labels, historical-balances, counterparties schema

- [#164](https://github.com/nansen-ai/nansen-cli/pull/164) [`ec6ab78`](https://github.com/nansen-ai/nansen-cli/commit/ec6ab78d604a177c3459833091531de3fc07add1) Thanks [@DMagowan](https://github.com/DMagowan)! - fix: correct `--date` option marked as `required: true` when it is optional

  The schema incorrectly marked `--date` as `required: true` for three commands:

  - `research token flows`
  - `research token who-bought-sold`
  - `research profiler transactions`

  All three use `parseDateOption` with a `days` fallback, so `--date` is optional — omitting it defaults to a rolling window based on `--days`. An agent following the schema strictly would unnecessarily refuse to run these commands without a date.

- [#162](https://github.com/nansen-ai/nansen-cli/pull/162) [`4dbe181`](https://github.com/nansen-ai/nansen-cli/commit/4dbe181d3b4973881bcb7fb445cf6559819006b6) Thanks [@DMagowan](https://github.com/DMagowan)! - fix: surface wallet prerequisite in `trade quote` help text and schema

  `nansen trade quote` requires a configured wallet (the trading API builds a transaction specific to the sender address), but this was not communicated until the command failed. Adds a PREREQUISITE section to the usage text and a `prerequisites` field to the schema so agents can discover this requirement before running the command.

- [#165](https://github.com/nansen-ai/nansen-cli/pull/165) [`92f37ea`](https://github.com/nansen-ai/nansen-cli/commit/92f37eaa8655ae1a39b9200aafaf4771a0859229) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Fix trading docs and config to reflect actual supported chains (Base and Solana only)

## 1.10.0

### Minor Changes

- [#125](https://github.com/nansen-ai/nansen-cli/pull/125) [`5a5a80a`](https://github.com/nansen-ai/nansen-cli/commit/5a5a80af9c2c5b93efcc707925b004f077e13c36) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add modular skills/ directory with 7 agent-optimised SKILL.md files (nansen-token, nansen-smart-money, nansen-profiler, nansen-trade, nansen-wallet, nansen-perp, nansen-search) following the linear-cli pattern. Each skill has scoped frontmatter, agent routing descriptions, bash examples, and exit codes. Add skills nudge to `nansen --help` output.

### Patch Changes

- [#122](https://github.com/nansen-ai/nansen-cli/pull/122) [`9a1ada8`](https://github.com/nansen-ai/nansen-cli/commit/9a1ada8543cd6fdbcc10d2d5004fe2e2e1a88928) Thanks [@TimNooren](https://github.com/TimNooren)! - `nansen research <unknown>` and `nansen trade <unknown>` now exit with code 1 and return `{"success":false,...}` instead of silently exiting 0.

- [#138](https://github.com/nansen-ai/nansen-cli/pull/138) [`c61881f`](https://github.com/nansen-ai/nansen-cli/commit/c61881f5455b9fff7fb97841652a72af58ab8e0b) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix `nansen login --help` to show usage instead of erroring. Previously, `--help` was silently ignored on TTY (showing the interactive prompt) and caused an error on non-TTY. Also fixes the post-login suggested command to use the non-deprecated `nansen research token screener` path.

- [#129](https://github.com/nansen-ai/nansen-cli/pull/129) [`eeabf89`](https://github.com/nansen-ai/nansen-cli/commit/eeabf8988dafc7fb1964fd2eef629f03c6a4420a) Thanks [@araa47](https://github.com/araa47)! - Fix `token ohlcv` sending unsupported pagination/limit params that caused 422 errors

- [#139](https://github.com/nansen-ai/nansen-cli/pull/139) [`e86dc68`](https://github.com/nansen-ai/nansen-cli/commit/e86dc6869f524d3dc59da4c7c04cb1ace1b7246b) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix API key prompt masking: each keystroke was showing the real character followed by `*` (e.g. `f*o*o*`) because the readline interface was active alongside raw mode, causing double output. Moving readline creation into the non-hidden branch eliminates the double-echo and also fixes backspace incorrectly clearing the prompt label.

- [#129](https://github.com/nansen-ai/nansen-cli/pull/129) [`eeabf89`](https://github.com/nansen-ai/nansen-cli/commit/eeabf8988dafc7fb1964fd2eef629f03c6a4420a) Thanks [@araa47](https://github.com/araa47)! - Fix `trade quote` crash when no wallet exists — now shows actionable error instead of uncaught exception

- [#126](https://github.com/nansen-ai/nansen-cli/pull/126) [`f3b87e7`](https://github.com/nansen-ai/nansen-cli/commit/f3b87e7491d03d052d5d72fcc991de0c33caf51f) Thanks [@araa47](https://github.com/araa47)! - Remove root SKILL.md so `npx skills add nansen-ai/nansen-cli` correctly discovers all 7 skills in `skills/` instead of treating the repo as a single skill.

## 1.9.3

### Patch Changes

- [#118](https://github.com/nansen-ai/nansen-cli/pull/118) [`0bd4c3c`](https://github.com/nansen-ai/nansen-cli/commit/0bd4c3c1946e575e2c2db5e02d17f266e79752a4) Thanks [@TimNooren](https://github.com/TimNooren)! - Show warning when trade quote price impact exceeds 5%, and show pin command to avoid fallback to worse quotes

## 1.9.2

### Patch Changes

- [#116](https://github.com/nansen-ai/nansen-cli/pull/116) [`7a2b729`](https://github.com/nansen-ai/nansen-cli/commit/7a2b7293c2e731ae1d5375b15df9c05c5611a9cb) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix usage examples for `nansen trade quote` to show correct command name instead of deprecated `nansen quote`

- [#114](https://github.com/nansen-ai/nansen-cli/pull/114) [`37d8c0b`](https://github.com/nansen-ai/nansen-cli/commit/37d8c0b87797145a15b087caa5eb474673217580) Thanks [@TimNooren](https://github.com/TimNooren)! - Show API key URL in non-interactive login error message

- [#117](https://github.com/nansen-ai/nansen-cli/pull/117) [`55ad922`](https://github.com/nansen-ai/nansen-cli/commit/55ad922826a7a2411889edeede42fbfc7b70d7a5) Thanks [@TimNooren](https://github.com/TimNooren)! - Add --wallet and WalletConnect documentation to `nansen trade help` output

## 1.9.1

### Patch Changes

- [#110](https://github.com/nansen-ai/nansen-cli/pull/110) [`82aa780`](https://github.com/nansen-ai/nansen-cli/commit/82aa78022bdcd62987b0949e090f19f563699d9a) Thanks [@TimNooren](https://github.com/TimNooren)! - Fix `nansen changelog` always showing "CHANGELOG.md not found". Added a `files` field to `package.json` to explicitly bundle `CHANGELOG.md` with the published package. Also excludes `src/__tests__/` from the package, reducing package size from ~537 kB to ~269 kB.

## 1.9.0

### Minor Changes

- [#98](https://github.com/nansen-ai/nansen-cli/pull/98) [`2f3f556`](https://github.com/nansen-ai/nansen-cli/commit/2f3f556d008a1f8ec40d57a8a2822bedbc6b60cb) Thanks [@Codier](https://github.com/Codier)! - Add symbol shortcuts for common tokens (SOL, ETH, USDC, USDT, etc.) that resolve to canonical addresses per chain. Users can now use `--from SOL --to USDC` instead of raw contract addresses.

- [#32](https://github.com/nansen-ai/nansen-cli/pull/32) [`08a8d21`](https://github.com/nansen-ai/nansen-cli/commit/08a8d21be6e9196661be737545e790af180aebc3) Thanks [@arein](https://github.com/arein)! - Add WalletConnect support for trading, transfers, and x402 auto-payment (EVM only)

### Patch Changes

- [#99](https://github.com/nansen-ai/nansen-cli/pull/99) [`9144cba`](https://github.com/nansen-ai/nansen-cli/commit/9144cba38b06c90d462df97ea6cbcdeaed26fa36) Thanks [@Codier](https://github.com/Codier)! - Show clear error when `--amount` contains a decimal (e.g. `0.005`) instead of base units (lamports, wei). Detected client-side before hitting the API.

- [#100](https://github.com/nansen-ai/nansen-cli/pull/100) [`19559bf`](https://github.com/nansen-ai/nansen-cli/commit/19559bfea6c22f6bd6b8c278ed5e6ae6d64866d5) Thanks [@Codier](https://github.com/Codier)! - Fix `nansen trade help` returning blank output. Now prints subcommands, usage, and examples. Also fixes `errorOutput` ReferenceError in `buildCommands` scope (affected `trade` and `changelog` commands).

- [#93](https://github.com/nansen-ai/nansen-cli/pull/93) [`342c91f`](https://github.com/nansen-ai/nansen-cli/commit/342c91fdeb6d98d6b5c10a58cb9702eb5afe096f) Thanks [@Codier](https://github.com/Codier)! - Warn when `--from` is a wrapped native token (WETH/WBNB) or native sentinel, so AI agents can correct the token before execution fails

## 1.8.0

### Minor Changes

- [#56](https://github.com/nansen-ai/nansen-cli/pull/56) [`d10998a`](https://github.com/nansen-ai/nansen-cli/commit/d10998aa2be19f80e8476d19bfd46029757a7335) Thanks [@askeluv](https://github.com/askeluv)! - Add CHANGELOG.md, `nansen changelog` command, and post-update "what's new" notice

  - Added CHANGELOG.md following Keep a Changelog format with history back to v1.5.0
  - Added `nansen changelog` command with `--since <version>` filtering
  - Added one-time upgrade notice on first run after version update (prints to stderr)

- [#77](https://github.com/nansen-ai/nansen-cli/pull/77) [`46e4660`](https://github.com/nansen-ai/nansen-cli/commit/46e4660034d9681405d09a5184f78525c300b8a5) Thanks [@0xlaveen](https://github.com/0xlaveen)! - Add token-ohlcv endpoint for OHLCV candle data

- [#75](https://github.com/nansen-ai/nansen-cli/pull/75) [`287937e`](https://github.com/nansen-ai/nansen-cli/commit/287937e1d307e0b3f25648863d0c5b4a54d215ff) Thanks [@TimNooren](https://github.com/TimNooren)! - Restructure CLI into research/trade/wallet namespaces

  - Commands reorganized: `smart-money`, `profiler`, `token`, `portfolio` now live under `nansen research`
  - New `nansen trade` namespace for `quote` and `execute`
  - New `nansen wallet` namespace for wallet management
  - Old top-level commands still work with deprecation warnings

- [#61](https://github.com/nansen-ai/nansen-cli/pull/61) [`9af0192`](https://github.com/nansen-ai/nansen-cli/commit/9af01921871be1d0537047cb4ad9733e01876646) Thanks [@askeluv](https://github.com/askeluv)! - Add ENS name resolution for profiler commands. Use `.eth` names directly in `--address` flags — resolved automatically via ensideas API with onchain RPC fallback. Works across all profiler subcommands, batch, and trace operations.

All notable changes to the Nansen CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.7.0] - 2026-02-24

### Added

- **Trading commands** — `quote` and `execute` for DEX swaps (EVM + Solana)
- **Wallet management** — `wallet create`, `list`, `show`, `export`, `default`, `delete`
- **Wallet send** — transfer tokens on EVM and Solana (`wallet send`)
- **x402 auto-payment** — automatic payment via Base USDC or Solana SPL USDC
- Explorer links in transaction output
- `--dry-run` flag for `wallet send`
- x402 low balance warning
- AI Agent Access setup docs and improved onboarding flow

### Fixed

- Solana execute crash with OKX quotes
- x402 auto-pay retry path (3 reference errors)
- Gas estimation — use API `quote.gas` as floor
- Pre-flight simulation moved after approval (industry standard)
- EVM signing edge cases with pure JS ECDSA
- Wallet send crashes on amount parsing and silent success
- Solana confirmation and SPL token transfer account ordering
- Suppress duplicate JSON output from quote/execute
- Suppress approval warning for native ETH swaps

### Changed

- Pricing clarity — from $0.01/call, min $0.05 balance
- Consolidated crypto primitives into shared module

## [1.6.0] - 2026-02-14

### Added

- `token indicators` endpoint
- `profiler search` — general entity search command
- `--x402-payment-signature` flag for pre-signed payment headers
- `X-Client-Type` and `X-Client-Version` tracking headers on all API requests

### Fixed

- Error JSON now outputs to stdout (not stderr) for consistent agent parsing
- Config loading — environment variables correctly override file config

## [1.5.1] - 2026-02-07

### Added

- Allow API requests without API key when using x402 payment flow

## [1.5.0] - 2026-01-31

_Baseline version. Changes above are relative to this release._
