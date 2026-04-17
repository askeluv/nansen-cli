/**
 * Nansen CLI - Limit Orders command
 *
 * A limit order pairs a user-defined price target with a companion smart alert
 * that fires when the wallet executes the matching buy/sell on-chain. The order
 * itself is stored locally as an intent record; execution is done manually
 * (e.g. via `trade quote/execute` or an external venue) when the price is hit.
 * The companion alert provides the notification when the buy/sell happens.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CommandError, NansenError, ErrorCode } from '../api.js';
import { resolveTokenAddress } from '../trading.js';
import { showWallet, getWalletConfig } from '../wallet.js';

// ============= Storage =============

function getLimitOrdersDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'limit-orders');
}

function ensureLimitOrdersDir() {
  const dir = getLimitOrdersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function saveLimitOrder(order) {
  const dir = ensureLimitOrdersDir();
  const file = path.join(dir, `${order.orderId}.json`);
  fs.writeFileSync(file, JSON.stringify(order, null, 2), { mode: 0o600 });
  return order.orderId;
}

export function loadLimitOrder(orderId) {
  const file = path.join(getLimitOrdersDir(), `${orderId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listLimitOrders() {
  const dir = getLimitOrdersDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function deleteLimitOrderFile(orderId) {
  const file = path.join(getLimitOrdersDir(), `${orderId}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// ============= Channel & Alert Builders =============

/**
 * Build the notification channels array from CLI flags.
 * Mirrors the shape used by `nansen alerts create`.
 */
export function buildLimitOrderChannels(options) {
  if (options['webhook-secret'] && !options.webhook) {
    throw new NansenError('--webhook-secret requires --webhook', ErrorCode.INVALID_PARAMS);
  }
  const channels = [];
  if (options.telegram) channels.push({ type: 'telegram', data: { chatId: String(options.telegram) } });
  if (options.slack) channels.push({ type: 'slack', data: { webhookUrl: options.slack } });
  if (options.discord) channels.push({ type: 'discord', data: { webhookUrl: options.discord } });
  if (options.webhook) {
    const data = { webhookUrl: options.webhook };
    if (options['webhook-secret']) {
      if (options['webhook-secret'].length < 16) {
        throw new NansenError('--webhook-secret must be at least 16 characters', ErrorCode.INVALID_PARAMS);
      }
      data.secret = options['webhook-secret'];
    }
    channels.push({ type: 'webhook', data });
  }
  return channels;
}

/**
 * Build the smart-alert payload that fires when the wallet executes the
 * matching buy/sell on-chain.
 *
 * Uses the `common-token-transfer` alert type with the wallet as the subject
 * and the target token as the inclusion filter, scoped to the side direction.
 */
export function buildLimitOrderAlertPayload({ name, description, walletAddress, tokenAddress, chain, side, channels }) {
  if (side !== 'buy' && side !== 'sell') {
    throw new NansenError(`Invalid --side "${side}". Must be "buy" or "sell".`, ErrorCode.INVALID_PARAMS);
  }
  return {
    name,
    type: 'common-token-transfer',
    timeWindow: 'realtime',
    channels,
    isEnabled: true,
    ...(description ? { description } : {}),
    data: {
      chains: [chain],
      events: [side],
      subjects: [{ type: 'address', value: walletAddress }],
      counterparties: [],
      usdValue: {},
      tokenAmount: {},
      inclusion: { tokens: [{ address: tokenAddress, chain }] },
      exclusion: {},
    },
  };
}

// ============= Formatting =============

export function formatLimitOrdersTable(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return 'No limit orders';

  const truncate = (s, n) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);
  const cols = [
    { k: 'orderId',      h: 'ID',     w: 22 },
    { k: 'walletName',   h: 'WALLET', w: 12 },
    { k: 'side',         h: 'SIDE',   w: 4 },
    { k: 'tokenSymbol',  h: 'TOKEN',  w: 10 },
    { k: 'chain',        h: 'CHAIN',  w: 8 },
    { k: 'targetPriceUsd', h: 'PRICE', w: 10 },
    { k: 'alertId',      h: 'ALERT',  w: 22 },
  ];
  const rowToStr = (o) => cols.map(c => {
    const v = c.k === 'tokenSymbol' ? (o.tokenSymbol || o.tokenAddress) : o[c.k];
    const s = v == null ? '' : String(v);
    return truncate(c.k === 'side' ? s.toUpperCase() : s, c.w).padEnd(c.w);
  }).join(' │ ');

  const lines = [];
  lines.push(cols.map(c => c.h.padEnd(c.w)).join(' │ '));
  lines.push(cols.map(c => '─'.repeat(c.w)).join('─┼─'));
  for (const o of orders) lines.push(rowToStr(o));
  return lines.join('\n');
}

// ============= Wallet Resolution =============

/**
 * Resolve the wallet address used for the order/alert. Mirrors the
 * default-wallet fallback behavior in trading.js.
 */
function resolveWalletAddress(walletName, chain) {
  let effectiveName = walletName;
  if (!effectiveName) {
    const cfg = getWalletConfig();
    effectiveName = cfg.defaultWallet;
  }
  if (!effectiveName) {
    throw new CommandError('No wallet found. Create one with: nansen wallet create', 'NO_WALLET');
  }
  const wallet = showWallet(effectiveName);
  const address = chain === 'solana' ? wallet.solana : wallet.evm;
  if (!address) {
    throw new CommandError(`Wallet "${effectiveName}" has no address for chain "${chain}"`, 'NO_WALLET_ADDRESS');
  }
  return { walletName: effectiveName, walletAddress: address };
}

// ============= Command Builder =============

export function buildLimitOrdersCommands(deps = {}) {
  const { log = console.log } = deps;

  const HELP = {
    _top: `nansen trade limit-order — Limit orders with companion smart alerts

SUBCOMMANDS:
  create   Create a limit order and a companion smart alert on the wallet
  list     List local limit orders
  delete   Delete a limit order and its companion alert

USAGE:
  nansen trade limit-order <subcommand> [options]
  Run: nansen trade limit-order <subcommand> --help`,

    create: `nansen trade limit-order create — Create a limit order with companion alert

USAGE:
  nansen trade limit-order create --chain <chain> --side <buy|sell> \\
    --token <symbol|address> --target-price <usd> --amount <units> \\
    --telegram <chatId> [--wallet <name>] [options]

REQUIRED:
  --chain <chain>           solana or base (or any chain supported by alerts)
  --side <buy|sell>         Direction the wallet should buy or sell
  --token <symbol|address>  Target token (symbol resolves via the trade module)
  --target-price <usd>      Trigger price in USD (informational; recorded on the order)
  --amount <units>          Order size (base units by default; pair with --amount-unit)
  At least one channel:     --telegram <chatId> | --slack <url> | --discord <url> | --webhook <url>

OPTIONS:
  --wallet <name>           Wallet to monitor (default: default wallet)
  --amount-unit <unit>      "token", "usd", or "base" (default: base)
  --name <name>             Alert/order name (default: auto-derived)
  --description <text>      Optional alert description
  --webhook-secret <secret> HMAC signing secret (webhook only, ≥16 chars)

NOTES:
  The companion alert is a 'common-token-transfer' smart alert that fires when
  the wallet executes the matching buy or sell of the target token. The order
  intent is stored locally in ~/.nansen/limit-orders/. Execution is manual —
  use 'nansen trade quote/execute' (or an external venue) when the price hits.

EXAMPLE:
  nansen trade limit-order create --chain base --side buy --token USDC \\
    --target-price 0.99 --amount 100 --amount-unit usd --telegram 5238612255`,

    list: `nansen trade limit-order list — List local limit orders

USAGE:
  nansen trade limit-order list [--table] [--pretty]`,

    delete: `nansen trade limit-order delete — Delete a limit order

USAGE:
  nansen trade limit-order delete <orderId>

Removes the local order record AND the companion smart alert.`,
  };

  return {
    'limit-order': async (args, apiInstance, flags, options) => {
      const sub = args[0];
      if (!sub || sub === 'help' || flags.help) {
        log(HELP._top);
        return;
      }
      if (args[1] === 'help' || flags.help) {
        log(HELP[sub] || HELP._top);
        return;
      }

      if (sub === 'create') {
        const chain = options.chain;
        const side = options.side;
        const tokenInput = options.token;
        const targetPriceUsd = options['target-price'];
        const amount = options.amount;
        const amountUnit = options['amount-unit'] || 'base';

        const missing = [];
        if (!chain) missing.push('--chain');
        if (!side) missing.push('--side');
        if (!tokenInput) missing.push('--token');
        if (targetPriceUsd === undefined) missing.push('--target-price');
        if (amount === undefined) missing.push('--amount');
        if (missing.length) {
          throw new CommandError(`Required: ${missing.join(', ')}\n\n${HELP.create}`, 'MISSING_ARGS');
        }
        if (side !== 'buy' && side !== 'sell') {
          throw new CommandError(`Invalid --side "${side}". Must be "buy" or "sell".`, 'INVALID_INPUT');
        }
        if (!['base', 'token', 'usd'].includes(amountUnit)) {
          throw new CommandError(`Invalid --amount-unit "${amountUnit}". Must be "base", "token", or "usd".`, 'INVALID_INPUT');
        }
        const priceNum = Number(targetPriceUsd);
        if (!Number.isFinite(priceNum) || priceNum <= 0) {
          throw new CommandError('--target-price must be a positive number', 'INVALID_INPUT');
        }

        const channels = buildLimitOrderChannels(options);
        if (channels.length === 0) {
          throw new CommandError('Required: a channel (--telegram, --slack, --discord, or --webhook)', 'MISSING_ARGS');
        }

        const { walletName, walletAddress } = resolveWalletAddress(options.wallet, chain);
        const tokenAddress = resolveTokenAddress(tokenInput, chain);
        const tokenSymbol = tokenInput !== tokenAddress ? tokenInput.toUpperCase() : null;

        const orderId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const name = options.name
          || `Limit order ${side} ${tokenSymbol || tokenAddress.slice(0, 8)} @ $${targetPriceUsd}`;

        const alertPayload = buildLimitOrderAlertPayload({
          name,
          description: options.description,
          walletAddress,
          tokenAddress,
          chain,
          side,
          channels,
        });

        const alert = await apiInstance.alertsCreate(alertPayload);
        const alertId = alert?.id || alert?.data?.id || alert?.alertId;
        if (!alertId) {
          throw new CommandError(
            `Companion alert was created but no alert id was returned by the API: ${JSON.stringify(alert)}`,
            'ALERT_CREATE_FAILED',
          );
        }

        const order = {
          orderId,
          createdAt: Date.now(),
          walletName,
          walletAddress,
          chain,
          side,
          tokenAddress,
          tokenSymbol,
          targetPriceUsd: String(targetPriceUsd),
          amount: String(amount),
          amountUnit,
          name,
          alertId,
          channels: channels.map(c => c.type),
        };
        saveLimitOrder(order);
        return order;
      }

      if (sub === 'list') {
        const orders = listLimitOrders();
        if (flags.table) {
          log(formatLimitOrdersTable(orders));
          return undefined;
        }
        return orders;
      }

      if (sub === 'delete') {
        const orderId = args[1];
        if (!orderId) throw new CommandError('Required: <orderId>', 'MISSING_ARGS');
        const order = loadLimitOrder(orderId);
        if (!order) throw new CommandError(`Limit order not found: ${orderId}`, 'NOT_FOUND');

        let alertDeleteError = null;
        try {
          await apiInstance.alertsDelete(order.alertId);
        } catch (err) {
          alertDeleteError = err.message;
        }
        deleteLimitOrderFile(orderId);

        return {
          orderId,
          alertId: order.alertId,
          deleted: true,
          alertDeleted: !alertDeleteError,
          ...(alertDeleteError ? { alertDeleteError } : {}),
        };
      }

      throw new CommandError(
        `Unknown limit-order subcommand: ${sub}. Available: create, list, delete`,
        'UNKNOWN',
      );
    },
  };
}
