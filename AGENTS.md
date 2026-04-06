# AGENTS.md

CLI for the [Nansen API](https://docs.nansen.ai) — designed for AI agents.

## Quick Start

```bash
npm install && npm test          # mocked unit tests (no API key needed)
node src/index.js <cmd> [opts]   # run locally
nansen schema                    # full JSON schema of every command + return field
```

Entry point is `src/index.js`.

## Style

- **ESM only** — `import`/`export`, no TypeScript, no transpilation
- **BigInt for token amounts** — never floating point
- **Research commands** — return data objects, CLI layer formats via `formatOutput()` to stdout
- **Operational commands** (trade, wallet, login) — print human-readable text via `log()` to stdout, return `undefined`
- **No interactive prompts in core** — use env vars (`NANSEN_WALLET_PASSWORD`, `NANSEN_API_KEY`)
- **Actionable errors** — `"Not logged in. Run: nansen login"` not `"Authentication failed"`

## Testing

Vitest. Unit tests mock all RPC/API calls — never hit real networks. Follow mock patterns in existing tests.

Always run `npm test` before committing.

### E2E tests

E2E tests hit real networks and require funded wallets. They are **not** part of `npm test`.

```bash
npm run test:trade    # swap round-trips (Base ETH, Solana SOL). Requires funded wallet.
npm run test:send     # native transfer round-trips. Requires 2+ funded wallets.
npm run test:privy    # Privy wallet CRUD. Requires PRIVY_APP_ID + PRIVY_APP_SECRET.
```

All use `vitest.e2e.config.js` with a 12-minute timeout (cross-chain bridges are slow).

## Before You Commit

1. `npm test` passes
2. `npm run lint` passes (auto-fix: `npm run lint:fix`)
3. Update `src/schema.json` if you added/changed commands or options (manually maintained, no codegen)
4. Add a changeset if the change is user-facing (see below)

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full PR checklist.

### Changesets

Add a changeset for any change that affects users of the published npm package (new feature, bug fix, changed output). Skip for test-only, docs-only, or internal refactors.

Create `.changeset/<descriptive-name>.md`:

```markdown
---
"nansen-cli": patch
---

Short description (appears in CHANGELOG)
```

`patch` = bug fix, `minor` = new feature, `major` = breaking change.

## API Endpoint Quirks

Behaviors that are not bugs — don't "fix" them:

- `token holders --smart-money` → API returns `UNSUPPORTED_FILTER` for tokens without SM tracking
- `token flow-intelligence` → may return all-zero flows for illiquid tokens
- `token screener --search` → client-side filtering (fetches 500, filters locally)
- `token ohlcv` → no pagination/limit support; returns all candles for the timeframe
- `profiler perp-positions` → no pagination support; API ignores the parameter
- `smart-money netflow --timeframe` → silently accepted but has no effect; response always includes all timeframes
- `nansen research search` → matches by name, symbol, or address; use `profiler labels` for richer address metadata
- `--chain bnb` → accepted as input but response `chain` field returns `bsc`
