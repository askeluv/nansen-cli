# Nansen CLI

Command-line interface for the [Nansen API](https://docs.nansen.ai). Designed for AI agents with structured JSON output.

## Installation

```bash
# Clone and install
cd nansen-cli
npm install

# Make it globally available (optional)
npm link
```

## Configuration

Create a `config.json` file (gitignored):

```json
{
  "apiKey": "your-api-key-here",
  "baseUrl": "https://api.nansen.ai"
}
```

Or set environment variables:
```bash
export NANSEN_API_KEY=your-api-key
```

## Usage

All output is JSON by default. Use `--pretty` for human-readable formatting.

```bash
# Show help
nansen help

# Get Smart Money netflow on Solana
nansen smart-money netflow --chain solana --pretty

# Get Smart Money DEX trades from Funds only
nansen smart-money dex-trades --chain ethereum --labels Fund

# Get wallet balance
nansen profiler balance --address 0x28c6c06298d514db089934071355e5743bf21d60 --chain ethereum

# Get wallet labels
nansen profiler labels --address 0x28c6c06298d514db089934071355e5743bf21d60 --chain ethereum

# Search for an entity
nansen profiler search --query "Vitalik Buterin"

# Get token screener (trending tokens)
nansen token screener --chain solana --timeframe 24h --smart-money

# Get token holders
nansen token holders --token So11111111111111111111111111111111111111112 --chain solana

# Get DeFi portfolio holdings
nansen portfolio defi --wallet 0x4062b997279de7213731dbe00485722a26718892
```

## Commands

### `smart-money` - Smart Money Analytics

Track trading and holding activity of sophisticated market participants.

| Subcommand | Description |
|------------|-------------|
| `netflow` | Net capital flows (inflows vs outflows) |
| `dex-trades` | Real-time DEX trading activity |
| `perp-trades` | Perpetual trading on Hyperliquid |
| `holdings` | Aggregated token balances |
| `dcas` | DCA strategies on Jupiter |

**Smart Money Labels:**
- `Fund` - Institutional investment funds
- `Smart Trader` - Historically profitable traders
- `30D Smart Trader` - Top performers (30-day window)
- `90D Smart Trader` - Top performers (90-day window)
- `180D Smart Trader` - Top performers (180-day window)
- `Smart HL Perps Trader` - Profitable Hyperliquid traders

### `profiler` - Wallet Profiling

Detailed information about any blockchain address.

| Subcommand | Description |
|------------|-------------|
| `balance` | Current token holdings |
| `labels` | Behavioral and entity labels |
| `transactions` | Transaction history |
| `pnl` | PnL and trade performance |
| `search` | Search for entities by name |

### `token` - Token God Mode

Deep analytics for any token.

| Subcommand | Description |
|------------|-------------|
| `screener` | Discover and filter tokens |
| `holders` | Token holder analysis |
| `flows` | Token flow intelligence |
| `dex-trades` | DEX trading activity |
| `pnl` | PnL leaderboard |
| `who-bought-sold` | Recent buyers and sellers |

### `portfolio` - Portfolio Analytics

Track DeFi positions and holdings.

| Subcommand | Description |
|------------|-------------|
| `defi` | DeFi holdings across protocols |

## Options

| Option | Description |
|--------|-------------|
| `--pretty` | Format JSON output for readability |
| `--chain <chain>` | Blockchain to query |
| `--chains <json>` | Multiple chains as JSON array |
| `--limit <n>` | Number of results |
| `--filters <json>` | Filter criteria as JSON |
| `--order-by <json>` | Sort order as JSON array |
| `--labels <label>` | Smart Money label filter |
| `--smart-money` | Filter for Smart Money only |
| `--timeframe <tf>` | Time window (5m, 10m, 1h, 6h, 24h, 7d, 30d) |

## Supported Chains

`ethereum`, `solana`, `base`, `bnb`, `arbitrum`, `polygon`, `optimism`, `avalanche`, `linea`, `scroll`, `zksync`, `mantle`, `ronin`, `sei`, `plasma`, `sonic`, `unichain`, `monad`, `hyperevm`, `iotaevm`

## AI Agent Usage

The CLI is designed for AI agents:

1. **Structured Output**: All responses are JSON with consistent schema
2. **Error Handling**: Errors include status codes and details
3. **Composable**: Commands can be chained with shell pipes
4. **Discoverable**: `help` commands at every level

Example response structure:
```json
{
  "success": true,
  "data": {
    "results": [...],
    "pagination": {...}
  }
}
```

Error response:
```json
{
  "success": false,
  "error": "API error message",
  "status": 401,
  "details": {...}
}
```

## Testing

```bash
# Run all tests (mocked)
npm test

# Run with coverage
npm run test:coverage

# Run against live API (requires NANSEN_API_KEY)
npm run test:live

# Watch mode
npm run test:watch
```

### Test Coverage

| Category | Implemented | Total | Coverage |
|----------|-------------|-------|----------|
| Smart Money | 5 | 6 | 83% |
| Profiler | 5 | 12 | 42% |
| Token God Mode | 6 | 13 | 46% |
| Portfolio | 1 | 1 | 100% |
| **Total** | **17** | **32** | **53%** |

### Test Structure

- `api.test.js` - API client unit tests with mocks
- `cli.test.js` - CLI command parsing and execution tests
- `coverage.test.js` - Endpoint coverage verification

## License

MIT
