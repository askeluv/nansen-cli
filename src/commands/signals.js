/**
 * Nansen CLI - Research Signals command
 * List and filter trading signals from the Nansen API.
 */

// ============= Formatting =============

function getAge(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

const USAGE = `
Usage: nansen research signals <subcommand> [options]

Subcommands:
  list    List trading signals (default)
  active  List active entry signals only

Options:
  --strategy <name>   Filter by strategy name
  --chain <chain>     Filter by chain (e.g. ethereum, solana)
  --type <type>       Filter by signal type
  --coin <symbol>     Filter by coin symbol (e.g. BTC, ETH)
  --since <period>    Time window (default: 24h)
  --limit <n>         Max results (default: 20)
  --json              Output raw JSON
  --pretty            Output pretty-printed JSON

Aliases: research sig
`.trim();

// ============= Command Builder =============

export function buildSignalsCommands(deps = {}) {
  const {
    log = console.log,
    errorLog = console.error,
  } = deps;

  const signals = async (args, apiInstance, flags, options) => {
    if (flags.help || args.length === 0) {
      log(USAGE);
      return;
    }

    const subcommand = args[0]; // 'list', 'active'

    // Build request body
    const body = {};
    if (options.strategy) body.strategy = options.strategy;
    if (options.chain) body.chain = options.chain;
    if (options.type) body.type = options.type;
    if (options.coin) body.coin = options.coin.toUpperCase();
    if (options.since) body.since = options.since;
    body.limit = parseInt(options.limit || '20', 10);

    // For 'active': filter to entry signals only
    if (subcommand === 'active') body.type = 'entry';

    // Call API
    const result = await apiInstance.request('/api/internal/trading-signals', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (flags.json || flags.pretty) {
      log(JSON.stringify(result, null, 2));
      return result;
    }

    // Format as table
    const rows = result.data || [];
    if (rows.length === 0) {
      log('No signals found.');
      return;
    }

    log(
      [
        'Signal ID'.padEnd(38),
        'Coin'.padEnd(10),
        'Type'.padEnd(14),
        'Side'.padEnd(8),
        'Bias'.padEnd(8),
        'Detail'.padEnd(20),
        'Age',
      ].join(' ')
    );
    log('-'.repeat(110));

    for (const s of rows) {
      const age = getAge(s.inserted_at);
      const side = s.signal_type?.toLowerCase().includes('long') ? 'LONG' : 'SHORT';
      const bias = s.confidence != null ? s.confidence.toFixed(2) : '-';
      log(
        [
          (s.signal_id || '').slice(0, 36).padEnd(38),
          (s.coin || '-').padEnd(10),
          (s.signal_type || '-').padEnd(14),
          side.padEnd(8),
          bias.padEnd(8),
          (s.detail || '-').slice(0, 18).padEnd(20),
          age,
        ].join(' ')
      );
    }

    log(`\n${rows.length} signal(s) | strategy: ${body.strategy || 'all'} | since: ${body.since || '24h'}`);
  };

  return {
    'research signals': signals,
    'research sig': signals,
  };
}
