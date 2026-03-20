/**
 * Nansen CLI - Alerts command
 * Smart alert CRUD with type-specific named flags.
 */

import { NansenError, ErrorCode } from '../api.js';

// ============= Formatting =============

// Format alerts list as human-readable table
export function formatAlertsTable(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return 'No alerts';
  }

  const formatChannels = (channels) => {
    if (!channels || !Array.isArray(channels) || channels.length === 0) return '';
    return channels.map(ch => ch.type).join(', ');
  };

  const formatEnabled = (isEnabled) => isEnabled ? '✓' : '✗';

  const truncate = (str, maxLen) => {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
  };

  const idWidth = Math.max(2, Math.max(...alerts.map(a => (a.id || '').length)));
  const nameWidth = Math.max(4, Math.min(30, Math.max(...alerts.map(a => (a.name || '').length))));
  const typeWidth = Math.max(4, Math.min(25, Math.max(...alerts.map(a => (a.type || '').length))));
  const channelsWidth = Math.max(8, Math.min(20, Math.max(...alerts.map(a => formatChannels(a.channels).length))));

  const lines = [];
  const header = `${'ID'.padEnd(idWidth)} │ ${'NAME'.padEnd(nameWidth)} │ ${'TYPE'.padEnd(typeWidth)} │ ${'ENABLED'.padEnd(7)} │ ${'CHANNELS'.padEnd(channelsWidth)}`;
  lines.push(header);
  lines.push('─'.repeat(idWidth) + '─┼─' + '─'.repeat(nameWidth) + '─┼─' + '─'.repeat(typeWidth) + '─┼─' + '─'.repeat(7) + '─┼─' + '─'.repeat(channelsWidth));

  for (const alert of alerts) {
    const id = (alert.id || '').padEnd(idWidth);
    const name = truncate(alert.name, nameWidth).padEnd(nameWidth);
    const type = truncate(alert.type, typeWidth).padEnd(typeWidth);
    const enabled = formatEnabled(alert.isEnabled).padEnd(7);
    const channels = truncate(formatChannels(alert.channels), channelsWidth).padEnd(channelsWidth);
    lines.push(`${id} │ ${name} │ ${type} │ ${enabled} │ ${channels}`);
  }

  return lines.join('\n');
}

// ============= Data Builders =============

/**
 * Parse a token string "address:chain" into { address, chain }.
 * Handles single string or array of strings (from repeated --token flags).
 */
function parseTokens(tokenArg) {
  if (!tokenArg) return undefined;
  const tokens = Array.isArray(tokenArg) ? tokenArg : [tokenArg];
  return tokens.map(t => {
    const colonIdx = t.lastIndexOf(':');
    if (colonIdx === -1) throw new NansenError(`Invalid token format: "${t}". Expected address:chain`, ErrorCode.INVALID_PARAMS);
    return { address: t.slice(0, colonIdx), chain: t.slice(colonIdx + 1) };
  });
}

/**
 * Parse a subject string "type:value" into { type, value }.
 * Handles single string or array (from repeated --subject flags).
 */
function parseSubjects(subjectArg) {
  if (!subjectArg) return undefined;
  const subjects = Array.isArray(subjectArg) ? subjectArg : [subjectArg];
  return subjects.map(s => {
    const colonIdx = s.indexOf(':');
    if (colonIdx === -1) throw new NansenError(`Invalid subject format: "${s}". Expected type:value`, ErrorCode.INVALID_PARAMS);
    return { type: s.slice(0, colonIdx), value: s.slice(colonIdx + 1) };
  });
}

/**
 * Recursively deep-merge two plain objects.  Arrays and non-object values in
 * `source` replace the corresponding key in `target`; plain objects are merged
 * recursively so that partial updates (e.g. only `min` on a range) don't
 * overwrite sibling keys (e.g. existing `max`).
 */
function deepMergePlain(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const oldVal = target[key];
    const newVal = source[key];
    if (oldVal && newVal && typeof oldVal === 'object' && typeof newVal === 'object'
        && !Array.isArray(oldVal) && !Array.isArray(newVal)) {
      result[key] = deepMergePlain(oldVal, newVal);
    } else {
      result[key] = newVal;
    }
  }
  return result;
}

/**
 * Normalise chains option to array.
 */
function parseChains(chainsOpt) {
  if (!chainsOpt) return undefined;
  if (Array.isArray(chainsOpt)) return chainsOpt;
  return chainsOpt.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Build a { min, max } range object from two option values.
 * Returns undefined if neither is provided.
 */
function buildRange(minVal, maxVal) {
  if (minVal === undefined && maxVal === undefined) return undefined;
  const r = {};
  if (minVal !== undefined) r.min = Number(minVal);
  if (maxVal !== undefined) r.max = Number(maxVal);
  return r;
}

/**
 * Normalise a repeatable string option to array, or undefined if absent.
 */
function normArray(val) {
  if (!val) return undefined;
  return Array.isArray(val) ? val : [val];
}

/**
 * Build the data payload for sm-token-flows alerts from named flags.
 */
export function buildSmTokenFlowsData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const flowFields = ['inflow-1h', 'inflow-1d', 'inflow-7d', 'outflow-1h', 'outflow-1d', 'outflow-7d', 'netflow-1h', 'netflow-1d', 'netflow-7d'];
  for (const field of flowFields) {
    const range = buildRange(options[`${field}-min`], options[`${field}-max`]);
    if (range) {
      // Convert CLI key "inflow-1h" → data key "inflow_1h"
      data[field.replace(/-/g, '_')] = range;
    }
  }

  const tokens = parseTokens(options.token);
  const excludeTokens = parseTokens(options['exclude-token']);
  if (tokens) data.inclusion = { ...data.inclusion, tokens };
  if (excludeTokens) data.exclusion = { ...data.exclusion, tokens: excludeTokens };

  const sectors = normArray(options['token-sector']);
  if (sectors) data.inclusion = { ...data.inclusion, tokenSectors: sectors };
  const excludeSectors = normArray(options['exclude-token-sector']);
  if (excludeSectors) data.exclusion = { ...data.exclusion, tokenSectors: excludeSectors };

  if (options['token-age-max'] !== undefined) {
    data.inclusion = { ...data.inclusion, tokenAge: { max: Number(options['token-age-max']) } };
  }

  const marketCapRange = buildRange(options['market-cap-min'], options['market-cap-max']);
  if (marketCapRange) data.inclusion = { ...data.inclusion, marketCap: marketCapRange };

  const fdvRange = buildRange(options['fdv-min'], options['fdv-max']);
  if (fdvRange) data.inclusion = { ...data.inclusion, fdvUsd: fdvRange };

  return data;
}

/**
 * Build the data payload for common-token-transfer alerts from named flags.
 */
export function buildCommonTokenTransferData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  if (options.events) {
    data.events = typeof options.events === 'string' ? options.events.split(',') : options.events;
  }

  const usdRange = buildRange(options['usd-min'], options['usd-max']);
  if (usdRange) data.usdValue = usdRange;

  const amountRange = buildRange(options['token-amount-min'], options['token-amount-max']);
  if (amountRange) data.tokenAmount = amountRange;

  const subjects = parseSubjects(options.subject);
  if (subjects) data.subjects = subjects;

  const counterparties = parseSubjects(options.counterparty);
  if (counterparties) data.counterparties = counterparties;

  const tokens = parseTokens(options.token);
  const excludeTokens = parseTokens(options['exclude-token']);
  if (tokens) data.inclusion = { ...data.inclusion, tokens };
  if (excludeTokens) data.exclusion = { ...data.exclusion, tokens: excludeTokens };

  const sectors = normArray(options['token-sector']);
  if (sectors) data.inclusion = { ...data.inclusion, tokenSectors: sectors };
  const excludeSectors = normArray(options['exclude-token-sector']);
  if (excludeSectors) data.exclusion = { ...data.exclusion, tokenSectors: excludeSectors };

  const tokenAgeMin = options['token-age-min'];
  const tokenAgeMax = options['token-age-max'];
  if (tokenAgeMin !== undefined || tokenAgeMax !== undefined) {
    const tokenAge = {};
    if (tokenAgeMin !== undefined) tokenAge.min = Number(tokenAgeMin);
    if (tokenAgeMax !== undefined) tokenAge.max = Number(tokenAgeMax);
    data.inclusion = { ...data.inclusion, tokenAge };
  }

  const marketCapRange = buildRange(options['market-cap-min'], options['market-cap-max']);
  if (marketCapRange) data.inclusion = { ...data.inclusion, marketCap: marketCapRange };

  const excludeFrom = parseSubjects(options['exclude-from']);
  if (excludeFrom) data.exclusion = { ...data.exclusion, fromTargets: excludeFrom };
  const excludeTo = parseSubjects(options['exclude-to']);
  if (excludeTo) data.exclusion = { ...data.exclusion, toTargets: excludeTo };

  return data;
}

/**
 * Build the data payload for smart-contract-call alerts from named flags.
 */
export function buildSmartContractCallData(options) {
  const data = {};

  const chains = parseChains(options.chains);
  if (chains) data.chains = chains;

  const usdRange = buildRange(options['usd-min'], options['usd-max']);
  if (usdRange) data.usdValue = usdRange;

  if (options['signature-hash']) {
    data.signatureHash = Array.isArray(options['signature-hash'])
      ? options['signature-hash']
      : [options['signature-hash']];
  }

  const callers = parseSubjects(options.caller);
  const contracts = parseSubjects(options.contract);
  const excludeCallers = parseSubjects(options['exclude-caller']);
  const excludeContracts = parseSubjects(options['exclude-contract']);

  if (callers) data.inclusion = { ...data.inclusion, caller: callers };
  if (contracts) data.inclusion = { ...data.inclusion, smartContract: contracts };
  if (excludeCallers) data.exclusion = { ...data.exclusion, caller: excludeCallers };
  if (excludeContracts) data.exclusion = { ...data.exclusion, smartContract: excludeContracts };

  return data;
}

/**
 * Type-specific defaults for required fields.
 * Applied in buildAlertData so payloads always satisfy the backend schema.
 */
const TYPE_DEFAULTS = {
  'sm-token-flows': {
    chains: [],
    events: ['sm-token-flows'],
    inflow_1h: {},
    inflow_1d: {},
    inflow_7d: {},
    outflow_1h: {},
    outflow_1d: {},
    outflow_7d: {},
    netflow_1h: {},
    netflow_1d: {},
    netflow_7d: {},
    inclusion: {},
    exclusion: {},
  },
  'common-token-transfer': {
    chains: [],
    events: [],
    subjects: [],
    counterparties: [],
    usdValue: {},
    tokenAmount: {},
    inclusion: {},
    exclusion: {},
  },
  'smart-contract-call': {
    chains: [],
    events: ['smart-contract-call'],
    usdValue: {},
    signatureHash: [],
    inclusion: { caller: [], smartContract: [] },
    exclusion: { caller: [], smartContract: [] },
  },
};

/**
 * Build the alert data payload from named flags, dispatching on type.
 * --data '<json>' is merged on top as an escape-hatch override.
 * When applyDefaults is true (default), type-specific defaults are applied
 * underneath so the payload always satisfies the backend schema.
 * Set applyDefaults to false for sparse updates.
 */
export function buildAlertData(options, { applyDefaults = true } = {}) {
  let data;

  if (options.type === 'sm-token-flows') {
    data = buildSmTokenFlowsData(options);
  } else if (options.type === 'common-token-transfer') {
    data = buildCommonTokenTransferData(options);
  } else if (options.type === 'smart-contract-call') {
    data = buildSmartContractCallData(options);
  } else {
    // No type — only --chains and --data are valid; warn if type-specific flags are present
    const typeSpecificFlags = [
      'inflow-1h-min', 'inflow-1h-max', 'inflow-1d-min', 'inflow-1d-max', 'inflow-7d-min', 'inflow-7d-max',
      'outflow-1h-min', 'outflow-1h-max', 'outflow-1d-min', 'outflow-1d-max', 'outflow-7d-min', 'outflow-7d-max',
      'netflow-1h-min', 'netflow-1h-max', 'netflow-1d-min', 'netflow-1d-max', 'netflow-7d-min', 'netflow-7d-max',
      'events', 'usd-min', 'usd-max', 'token-amount-min', 'token-amount-max',
      'token', 'exclude-token',
      'subject', 'counterparty', 'signature-hash', 'caller', 'contract',
      'exclude-caller', 'exclude-contract', 'exclude-from', 'exclude-to',
      'token-sector', 'exclude-token-sector', 'token-age-min', 'token-age-max',
      'market-cap-min', 'market-cap-max', 'fdv-min', 'fdv-max',
    ];
    const present = typeSpecificFlags.filter(f => options[f] !== undefined);
    if (present.length > 0) {
      throw new NansenError(
        `--type is required when using type-specific flags (${present.map(f => '--' + f).join(', ')})`,
        ErrorCode.MISSING_PARAM,
      );
    }
    data = {};
    const chains = parseChains(options.chains);
    if (chains) data.chains = chains;
  }

  // Apply type defaults underneath so all required fields are present.
  // Use structuredClone to avoid shared mutable references, and deep-merge
  // inclusion/exclusion so partial flags (e.g. --caller without --contract)
  // don't drop sibling required sub-fields.
  if (applyDefaults && TYPE_DEFAULTS[options.type]) {
    const defaults = structuredClone(TYPE_DEFAULTS[options.type]);
    data = { ...defaults, ...data };
    if (defaults.inclusion) {
      data.inclusion = { ...defaults.inclusion, ...data.inclusion };
    }
    if (defaults.exclusion) {
      data.exclusion = { ...defaults.exclusion, ...data.exclusion };
    }
  }

  return data;
}

/**
 * Parse the --data JSON escape-hatch option.
 * Returns the parsed object, or undefined if not provided.
 */
function parseDataOverride(options) {
  if (!options.data) return undefined;
  if (typeof options.data === 'string') {
    try {
      return JSON.parse(options.data);
    } catch {
      throw new NansenError('--data must be valid JSON', ErrorCode.INVALID_PARAMS);
    }
  }
  return options.data;
}

// ============= Validation =============

/**
 * Check whether a range object has at least one non-null bound.
 * Uses != null (loose equality) to catch both null and undefined.
 */
function isRangeSet(range) {
  if (!range || typeof range !== 'object') return false;
  return range.min != null || range.max != null;
}

/**
 * Validate alert data payload against type-specific required fields.
 * Throws NansenError with INVALID_PARAMS when the payload is missing
 * mandatory information for the given alert type.
 *
 * Gracefully no-ops when type or data is null/undefined.
 */
export function validateAlertData(type, data) {
  if (!type || !data) return;

  if (type === 'sm-token-flows') {
    const flowKeys = [
      'inflow_1h', 'inflow_1d', 'inflow_7d',
      'outflow_1h', 'outflow_1d', 'outflow_7d',
      'netflow_1h', 'netflow_1d', 'netflow_7d',
    ];
    const hasAnyFlow = flowKeys.some(k => isRangeSet(data[k]));
    if (!hasAnyFlow) {
      throw new NansenError(
        'sm-token-flows requires at least one flow threshold (--inflow-*, --outflow-*, or --netflow-*)',
        ErrorCode.INVALID_PARAMS,
      );
    }
  }

  if (type === 'common-token-transfer') {
    const hasSubjects = Array.isArray(data.subjects) && data.subjects.length > 0;
    const hasTokens = Array.isArray(data.inclusion?.tokens) && data.inclusion.tokens.length > 0;
    if (!hasSubjects && !hasTokens) {
      throw new NansenError(
        'common-token-transfer requires at least one --subject or --token',
        ErrorCode.INVALID_PARAMS,
      );
    }
  }

  if (type === 'smart-contract-call') {
    const hasCallers = Array.isArray(data.inclusion?.caller) && data.inclusion.caller.length > 0;
    const hasContracts = Array.isArray(data.inclusion?.smartContract) && data.inclusion.smartContract.length > 0;
    const hasSignatureHash = Array.isArray(data.signatureHash) && data.signatureHash.length > 0;
    if (!hasCallers && !hasContracts && !hasSignatureHash) {
      throw new NansenError(
        'smart-contract-call requires at least one --caller, --contract, or --signature-hash',
        ErrorCode.INVALID_PARAMS,
      );
    }
  }
}

// ============= Command Builder =============

const TIME_WINDOW_BY_TYPE = {
  'common-token-transfer': 'realtime',
  'smart-contract-call': 'realtime',
  'sm-token-flows': '1h',
};

export function buildAlertsCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'alerts': async (args, apiInstance, flags, options) => {
      const sub = args[0];

      const HELP = {
        _top: `nansen alerts — Smart alert management

SUBCOMMANDS:
  list        List all alerts
  create      Create a new alert
  update      Update an existing alert
  toggle      Enable or disable an alert
  delete      Delete an alert

Run: nansen alerts <subcommand> --help`,

        list: `nansen alerts list — List all alerts

USAGE:
  nansen alerts list [--table] [--pretty] [--type <type>] [--enabled|--disabled] [--token-address <addr>] [--chain <chain>] [--limit <n>] [--offset <n>]

OPTIONS:
  --table                      Human-readable table output (columns: ID, NAME, TYPE, ENABLED, CHANNELS)
  --pretty                     Indented JSON output
  --type <type>                Filter by alert type (sm-token-flows, common-token-transfer, smart-contract-call)
  --enabled / --disabled       Filter by enabled state
  --token-address <addr>       Filter by token address
  --chain <chain>              Filter by chain
  --limit <n>                  Max results
  --offset <n>                 Skip first N results

EXAMPLES:
  nansen alerts list --table
  nansen alerts list --pretty
  nansen alerts list --type sm-token-flows --enabled`,

        create: `nansen alerts create — Create a new alert

USAGE:
  nansen alerts create --name <name> --type <type> --chains <chains> --telegram <chatId> [options]

REQUIRED:
  --name <name>                Alert name
  --type <type>                sm-token-flows | common-token-transfer | smart-contract-call
  At least one channel:        --telegram <chatId> | --slack <url> | --discord <url> | --webhook <url>

OPTIONS (all types):
  --chains <chains>            Comma-separated chains (e.g. ethereum,solana)
  --token <address:chain>      Include token (repeatable)
  --exclude-token <addr:chain> Exclude token (repeatable)
  --description '<text>'       Alert description
  --disabled                   Create in disabled state
  --data '<json>'              Raw JSON merged on top of named flags (escape hatch)

OPTIONS (sm-token-flows):
  At least one flow threshold required (inflow, outflow, or netflow):
  --inflow-1h-min/max <usd>   --outflow-1h-min/max <usd>   --netflow-1h-min/max <usd>
  --inflow-1d-min/max <usd>   --outflow-1d-min/max <usd>   --netflow-1d-min/max <usd>
  --inflow-7d-min/max <usd>   --outflow-7d-min/max <usd>   --netflow-7d-min/max <usd>
  --token-sector <name>        --exclude-token-sector <name> (repeatable)
  --token-age-max <days>       --market-cap-min/max <usd>    --fdv-min/max <usd>

OPTIONS (common-token-transfer):
  --events <buy,sell,swap,send,receive>   Comma-separated event types
  --usd-min/max <usd>         --token-amount-min/max <n>
  --subject <type:value>       Filter by subject (repeatable, e.g. label:"Centralized Exchange")
  --counterparty <type:value>  Filter by counterparty (repeatable, requires --subject)
  --token-sector <name>        --exclude-token-sector <name> (repeatable)
  --token-age-min/max <days>   --market-cap-min/max <usd>
  --exclude-from <type:value>  --exclude-to <type:value> (repeatable)

OPTIONS (smart-contract-call):
  --usd-min/max <usd>         --signature-hash <hash> (repeatable)
  --caller <type:value>        --exclude-caller <type:value> (repeatable)
  --contract <type:value>      --exclude-contract <type:value> (repeatable)

SUBJECT TYPES: address, entity, label, custom-label
CHAIN ALIASES: Hyperliquid = hyperevm, BSC = bnb

NOTE: Use single quotes for names with $ or special chars: --name 'SM >$1M'

EXAMPLES:
  nansen alerts create --name 'ETH SM Inflow' --type sm-token-flows --chains ethereum --telegram 5238612255 --inflow-1h-min 1000000
  nansen alerts create --name 'USDC Transfers' --type common-token-transfer --chains ethereum --telegram 5238612255 --events send,receive --usd-min 1000000 --subject label:"Centralized Exchange"
  nansen alerts create --name 'Contract Calls' --type smart-contract-call --chains ethereum --telegram 5238612255 --signature-hash 0xa9059cbb --caller address:0xabc`,

        update: `nansen alerts update — Update an existing alert

USAGE:
  nansen alerts update <id> [--name <name>] [--chains <chains>] [--enabled|--disabled] [type-specific flags...]

All create options are accepted. Only provided fields are updated.
See: nansen alerts create --help for type-specific flags.

NOTE: --type cannot change an existing alert's type (use delete + create instead).
      Use single quotes for names with $ or special chars: --name 'SM >$1M'

EXAMPLES:
  nansen alerts update abc123 --name 'New Name'
  nansen alerts update abc123 --inflow-1h-min 2000000
  nansen alerts update abc123 --chains ethereum,base --inflow-1h-min 2000000`,

        toggle: `nansen alerts toggle — Enable or disable an alert

USAGE:
  nansen alerts toggle <id> --enabled
  nansen alerts toggle <id> --disabled`,

        delete: `nansen alerts delete — Delete an alert

USAGE:
  nansen alerts delete <id>`,
      };

      if (!sub || sub === 'help') {
        log(HELP._top);
        return;
      }

      // Build channels array from --telegram/--slack/--discord flags
      function buildChannels() {
        const channels = [];
        if (options.telegram) channels.push({ type: 'telegram', data: { chatId: String(options.telegram) } });
        if (options.slack) channels.push({ type: 'slack', data: { webhookUrl: options.slack } });
        if (options.discord) channels.push({ type: 'discord', data: { webhookUrl: options.discord } });
        if (options.webhook) channels.push({ type: 'webhook', data: { url: options.webhook } });
        return channels.length > 0 ? channels : null;
      }

      const handlers = {
        'list': async () => {
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAMS);

          const results = await apiInstance.alertsList();
          let alerts = Array.isArray(results) ? results : results?.alerts ?? results?.data ?? [];

          // Client-side filtering (server returns all alerts unfiltered)
          if (options.type) alerts = alerts.filter(a => a.type === options.type);
          if (flags.enabled) alerts = alerts.filter(a => a.isEnabled === true);
          if (flags.disabled) alerts = alerts.filter(a => a.isEnabled === false);
          if (options['token-address']) {
            const addr = options['token-address'].toLowerCase();
            alerts = alerts.filter(a => {
              const allTokens = [...(a.data?.inclusion?.tokens ?? []), ...(a.data?.exclusion?.tokens ?? [])];
              return allTokens.some(t => t.address?.toLowerCase() === addr);
            });
          }
          if (options.chain) {
            const ch = options.chain.toLowerCase();
            alerts = alerts.filter(a => {
              const chains = a.data?.chains;
              return Array.isArray(chains) && chains.some(c => c.toLowerCase() === ch || c === 'all');
            });
          }

          // Pagination (applied after filtering)
          if (options.offset) alerts = alerts.slice(Number(options.offset));
          if (options.limit) alerts = alerts.slice(0, Number(options.limit));

          return alerts;
        },
        'create': () => {
          const name = options.name;
          const type = options.type;
          const channels = buildChannels();
          const missing = [];
          if (!name) missing.push('--name');
          if (!type) missing.push('--type');
          if (!options.chains) missing.push('--chains');
          if (!channels) missing.push('a channel (--telegram, --slack, --discord, or --webhook)');
          if (missing.length > 0) {
            throw new NansenError(`Required: ${missing.join(', ')}`, ErrorCode.MISSING_PARAM);
          }
          const timeWindow = TIME_WINDOW_BY_TYPE[type] ?? 'realtime';
          let data = buildAlertData(options);
          const dataOverride = parseDataOverride(options);
          if (dataOverride) data = deepMergePlain(data, dataOverride);
          validateAlertData(type, data);
          return apiInstance.alertsCreate({
            name,
            type,
            timeWindow,
            channels,
            data,
            ...(options.description ? { description: options.description } : {}),
            isEnabled: !flags.disabled,
          });
        },
        'update': async () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);

          const existing = await apiInstance.alertsGet(id);
          if (!existing) throw new NansenError(`Alert not found: ${id}`, ErrorCode.NOT_FOUND);
          const existingType = existing.type ?? existing.data?.type;
          if (options.type && options.type !== existingType) {
            throw new NansenError(
              `Cannot change alert type (${existingType} → ${options.type}). Delete and recreate the alert instead.`,
              ErrorCode.INVALID_PARAMS,
            );
          }
          const type = existingType;

          const params = { id };
          if (options.name) params.name = options.name;
          if (type) {
            params.type = type;
            params.timeWindow = TIME_WINDOW_BY_TYPE[type] ?? 'realtime';
          }
          const channels = buildChannels();
          if (channels) params.channels = channels;
          const effectiveOptions = type ? { ...options, type } : options;
          const builtData = buildAlertData(effectiveOptions, { applyDefaults: false });
          const dataOverride = parseDataOverride(options);
          if (Object.keys(builtData).length > 0 || dataOverride) {
            let merged = existing.data ? deepMergePlain(existing.data, builtData) : builtData;
            if (dataOverride) merged = deepMergePlain(merged, dataOverride);
            params.data = merged;
          }
          if (options.description) params.description = options.description;
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAMS);
          if (flags.enabled) params.isEnabled = true;
          if (flags.disabled) params.isEnabled = false;
          // Validate merged data if present, otherwise validate existing data
          validateAlertData(type, params.data ?? existing.data);
          return apiInstance.alertsUpdate(params);
        },
        'toggle': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          if (flags.enabled && flags.disabled) throw new NansenError('Cannot specify both --enabled and --disabled', ErrorCode.INVALID_PARAMS);
          const isEnabled = flags.enabled ? true : flags.disabled ? false : undefined;
          if (isEnabled === undefined) throw new NansenError('Required: --enabled or --disabled', ErrorCode.MISSING_PARAM);
          return apiInstance.alertsToggle({ id, isEnabled });
        },
        'delete': () => {
          const id = args[1];
          if (!id) throw new NansenError('Required: <id>', ErrorCode.MISSING_PARAM);
          return apiInstance.alertsDelete(id);
        },
      };

      if (!handlers[sub]) {
        throw new NansenError(`Unknown alerts subcommand: ${sub}. Available: list, create, update, toggle, delete`, ErrorCode.UNKNOWN);
      }

      // Subcommand-level help: --help flag or "help" as second positional arg
      if (flags.help || flags.h || args[1] === 'help') {
        log(HELP[sub] || HELP._top);
        return;
      }

      try {
        return await handlers[sub]();
      } catch (err) {
        // Rewrite cryptic channel validation errors from the API into actionable messages.
        // e.g. "Failed to send a welcome message to the channel index 0" → tells the user
        // which channel type failed and what to check.
        const match = typeof err.message === 'string' && err.message.match(/welcome message to the channel index (\d+)/i);
        if (match) {
          const channels = buildChannels() ?? [];
          const ch = channels[Number(match[1])];
          const hint = ch?.type === 'telegram'
            ? `Invalid Telegram chat ID (${ch.data.chatId}). Ensure the bot has been added to the chat.`
            : ch?.type === 'slack'
              ? `Invalid Slack webhook URL. Check the URL and try again.`
              : ch?.type === 'discord'
                ? `Invalid Discord webhook URL. Check the URL and try again.`
                : ch?.type === 'webhook'
                  ? `Invalid webhook URL (${ch.data.url}). Ensure the endpoint is reachable and returns 2xx.`
                  : err.message;
          throw new NansenError(hint, err.code ?? ErrorCode.INVALID_PARAMS, err.status);
        }
        throw err;
      }
    },
  };
}
