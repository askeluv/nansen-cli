# CLAUDE.md

AI assistant guide for contributing to nansen-cli.

## What This Is

A CLI for the [Nansen API](https://docs.nansen.ai), designed specifically for AI agents. All output is structured JSON. 30 endpoints across Smart Money, Profiler, Token God Mode, and Portfolio.

## Quick Start

```bash
npm install
npm test           # Run mocked tests (no API key needed)
npm run test:live  # Run against live API (needs NANSEN_API_KEY)
```

## Project Structure

```
src/
├── index.js              # CLI entry point, command routing, arg parsing
├── api.js                # NansenAPI class, all HTTP calls, validation
└── __tests__/
    ├── unit.test.js      # Core logic tests (validation, parsing, formatting)
    ├── api.test.js       # API method tests with mocked fetch
    ├── cli.test.js       # CLI integration tests
    └── coverage.test.js  # Endpoint coverage verification
```

**Two files, clear separation:**
- `index.js` = CLI layer (parsing, routing, output formatting)
- `api.js` = API layer (HTTP, validation, config)

## Code Conventions

- **ES modules** (`import`/`export`, not `require`)
- **Async/await** for all API calls
- **All output is JSON** (for AI agent consumption)
- **No external dependencies** (just Node.js built-ins + vitest for tests)

## Adding a New Endpoint

1. **Add API method in `src/api.js`:**
```javascript
async newEndpoint(params = {}) {
  const { chain = 'solana', filters = {}, orderBy, pagination } = params;
  return this.request('/api/v1/endpoint-path', {
    chain,
    filters,
    order_by: orderBy,
    pagination
  });
}
```

2. **Add CLI handler in `src/index.js`:**
```javascript
// In the appropriate command handler (smart-money, profiler, token, portfolio)
'new-subcommand': () => api.newEndpoint({ chains, filters, orderBy, pagination }),
```

3. **Add tests:**
   - `api.test.js` — Mock the fetch, verify request body
   - `cli.test.js` — Test CLI invocation
   - `coverage.test.js` — Add to `DOCUMENTED_ENDPOINTS`

4. **Update `README.md`** with docs

## Testing

```bash
npm test                    # All tests, mocked
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
NANSEN_API_KEY=xxx npm run test:live  # Live API tests
```

**Test philosophy:**
- Unit tests don't need API key (use mocked fetch)
- Live tests are opt-in via `NANSEN_LIVE_TEST=1`
- Coverage test ensures all documented endpoints have implementations

## Common Patterns

### Address Validation
```javascript
// Validates EVM (0x...) or Solana (Base58) addresses
const validation = validateAddress(address, chain);
if (!validation.valid) throw new Error(validation.error);
```

### Date Ranges
```javascript
// Most endpoints accept days param, converted to date range
const to = new Date().toISOString().split('T')[0];
const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
```

### Response Format
```javascript
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": "message", "status": 401, "details": { ... } }
```

## API Reference

### Chains
`ethereum`, `solana`, `base`, `bnb`, `arbitrum`, `polygon`, `optimism`, `avalanche`, `linea`, `scroll`, `zksync`, `mantle`, `ronin`, `sei`, `plasma`, `sonic`, `unichain`, `monad`, `hyperevm`, `iotaevm`

### Smart Money Labels
`Fund`, `Smart Trader`, `30D Smart Trader`, `90D Smart Trader`, `180D Smart Trader`, `Smart HL Perps Trader`

### Endpoints by Category

**Smart Money (6):** netflow, dex-trades, perp-trades, holdings, dcas, historical-holdings

**Profiler (11):** balance, labels, transactions, pnl, search, historical-balances, related-wallets, counterparties, pnl-summary, perp-positions, perp-trades

**Token God Mode (12):** screener, holders, flows, dex-trades, pnl, who-bought-sold, flow-intelligence, transfers, jup-dca, perp-trades, perp-positions, perp-pnl-leaderboard

**Portfolio (1):** defi-holdings

## Gotchas

- **Perp endpoints** work with Hyperliquid (use `--symbol BTC` not `--token`)
- **JUP DCA** is Solana-only
- **Beta endpoints** (`/api/beta/...`) may have different pagination
- **EVM vs Solana addresses** — validation auto-detects based on chain param

## PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] New endpoints have tests in all 3 test files
- [ ] README.md updated if adding user-facing features
- [ ] CHANGELOG.md updated for releases
- [ ] No new dependencies (keep it lightweight)
