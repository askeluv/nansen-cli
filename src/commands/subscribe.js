/**
 * Nansen CLI - Subscribe command
 * Subscription management: plans, promo codes, create/cancel/status.
 */

import { NansenError, ErrorCode } from '../api.js';

// ============= Formatting =============

export function formatPlansTable(plans) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return 'No plans available';
  }

  const nameWidth = Math.max(4, Math.min(30, Math.max(...plans.map(p => (p.name || '').length))));
  const priceWidth = Math.max(5, Math.min(15, Math.max(...plans.map(p => formatPrice(p).length))));
  const intervalWidth = Math.max(8, Math.min(15, Math.max(...plans.map(p => (p.interval || '').length))));
  const idWidth = Math.max(8, Math.min(40, Math.max(...plans.map(p => (p.priceId || p.id || '').length))));

  const lines = [];
  const header = `${'NAME'.padEnd(nameWidth)} │ ${'PRICE'.padEnd(priceWidth)} │ ${'INTERVAL'.padEnd(intervalWidth)} │ ${'PRICE ID'.padEnd(idWidth)}`;
  lines.push(header);
  lines.push('─'.repeat(nameWidth) + '─┼─' + '─'.repeat(priceWidth) + '─┼─' + '─'.repeat(intervalWidth) + '─┼─' + '─'.repeat(idWidth));

  for (const plan of plans) {
    const name = (plan.name || '').slice(0, nameWidth).padEnd(nameWidth);
    const price = formatPrice(plan).slice(0, priceWidth).padEnd(priceWidth);
    const interval = (plan.interval || '').slice(0, intervalWidth).padEnd(intervalWidth);
    const id = (plan.priceId || plan.id || '').slice(0, idWidth).padEnd(idWidth);
    lines.push(`${name} │ ${price} │ ${interval} │ ${id}`);
  }

  return lines.join('\n');
}

function formatPrice(plan) {
  if (plan.price == null) return '';
  const amount = typeof plan.price === 'number' ? (plan.price / 100).toFixed(2) : String(plan.price);
  const currency = (plan.currency || 'usd').toUpperCase();
  return `${amount} ${currency}`;
}

export function formatPromoCode(promo) {
  if (!promo) return 'Invalid promo code';
  const lines = [];
  if (promo.code) lines.push(`Code: ${promo.code}`);
  if (promo.percentOff != null) lines.push(`Discount: ${promo.percentOff}% off`);
  if (promo.amountOff != null) {
    const currency = (promo.currency || 'usd').toUpperCase();
    lines.push(`Discount: ${(promo.amountOff / 100).toFixed(2)} ${currency} off`);
  }
  if (promo.minimumAmount != null) {
    const currency = (promo.currency || 'usd').toUpperCase();
    lines.push(`Minimum: ${(promo.minimumAmount / 100).toFixed(2)} ${currency}`);
  }
  if (promo.firstTimeTransaction != null) lines.push(`First-time only: ${promo.firstTimeTransaction ? 'yes' : 'no'}`);
  if (Array.isArray(promo.appliesToPlanIds) && promo.appliesToPlanIds.length > 0) {
    lines.push(`Applies to plans: ${promo.appliesToPlanIds.join(', ')}`);
  }
  return lines.join('\n');
}

export function formatSubscriptionsTable(subs) {
  if (!Array.isArray(subs) || subs.length === 0) {
    return 'No active subscriptions';
  }

  const idWidth = Math.max(2, Math.min(40, Math.max(...subs.map(s => (s.id || '').length))));
  const statusWidth = Math.max(6, Math.min(15, Math.max(...subs.map(s => (s.status || '').length))));
  const providerWidth = Math.max(8, Math.min(15, Math.max(...subs.map(s => (s.provider || '').length))));

  const lines = [];
  const header = `${'ID'.padEnd(idWidth)} │ ${'STATUS'.padEnd(statusWidth)} │ ${'PROVIDER'.padEnd(providerWidth)}`;
  lines.push(header);
  lines.push('─'.repeat(idWidth) + '─┼─' + '─'.repeat(statusWidth) + '─┼─' + '─'.repeat(providerWidth));

  for (const sub of subs) {
    const id = (sub.id || '').slice(0, idWidth).padEnd(idWidth);
    const status = (sub.status || '').slice(0, statusWidth).padEnd(statusWidth);
    const provider = (sub.provider || '').slice(0, providerWidth).padEnd(providerWidth);
    lines.push(`${id} │ ${status} │ ${provider}`);
  }

  return lines.join('\n');
}

// ============= Command Builder =============

export function buildSubscribeCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'subscribe': async (args, apiInstance, flags, options) => {
      const sub = args[0];

      const HELP = {
        _top: `nansen subscribe — Subscription management

SUBCOMMANDS:
  plans       List available API plans
  promo-code  Validate a promo/coupon code
  create      Create a new subscription
  cancel      Cancel active recurring subscription
  status      Show active subscription(s)

Run: nansen subscribe <subcommand> --help`,

        plans: `nansen subscribe plans — List available API plans

USAGE:
  nansen subscribe plans [--table] [--pretty]`,

        'promo-code': `nansen subscribe promo-code — Validate a promo/coupon code

USAGE:
  nansen subscribe promo-code <code> [--pretty]

EXAMPLES:
  nansen subscribe promo-code SAVE20`,

        create: `nansen subscribe create — Create a new subscription

USAGE:
  nansen subscribe create --price-id <id> [--promo-code <code>] [--provider stripe|coinbase|moonpay] [--payment-method <id>]

OPTIONS:
  --price-id <id>              Plan price ID (required, from "nansen subscribe plans")
  --promo-code <code>          Promotion/coupon code (optional)
  --provider <name>            Payment provider: stripe (default), coinbase, moonpay
  --payment-method <id>        Stripe payment method ID (stripe only, optional)

EXAMPLES:
  nansen subscribe create --price-id price_abc123
  nansen subscribe create --price-id price_abc123 --promo-code SAVE20
  nansen subscribe create --price-id price_abc123 --provider coinbase`,

        cancel: `nansen subscribe cancel — Cancel active recurring subscription

USAGE:
  nansen subscribe cancel`,

        status: `nansen subscribe status — Show active subscription(s)

USAGE:
  nansen subscribe status [--table] [--pretty]`,
      };

      if (!sub || sub === 'help') {
        log(HELP._top);
        return;
      }

      const handlers = {
        'plans': async () => {
          return apiInstance.getApiPlans();
        },
        'promo-code': async () => {
          const code = args[1];
          if (!code) throw new NansenError('Required: <code>', ErrorCode.MISSING_PARAM);
          return apiInstance.validatePromoCode(code);
        },
        'create': async () => {
          const priceId = options['price-id'];
          if (!priceId) throw new NansenError('Required: --price-id', ErrorCode.MISSING_PARAM);
          const provider = options.provider || 'stripe';
          const promoCode = options['promo-code'];

          if (provider === 'stripe') {
            return apiInstance.createStripeSubscription({
              priceId,
              promotionCode: promoCode,
              paymentMethodId: options['payment-method'],
            });
          } else if (provider === 'coinbase') {
            return apiInstance.createCoinbaseSubscription({
              priceId,
              promotionCode: promoCode,
            });
          } else if (provider === 'moonpay') {
            return apiInstance.createMoonpaySubscription({
              priceId,
              promotionCode: promoCode,
            });
          } else {
            throw new NansenError(`Unknown provider: ${provider}. Use stripe, coinbase, or moonpay`, ErrorCode.INVALID_PARAMS);
          }
        },
        'cancel': async () => {
          return apiInstance.cancelSubscription();
        },
        'status': async () => {
          return apiInstance.getActiveSubscriptions();
        },
      };

      if (!handlers[sub]) {
        throw new NansenError(`Unknown subscribe subcommand: ${sub}. Available: plans, promo-code, create, cancel, status`, ErrorCode.UNKNOWN);
      }

      if (flags.help || flags.h || args[1] === 'help') {
        // promo-code help: args[1] is 'help', not a code
        log(HELP[sub] || HELP._top);
        return;
      }

      return await handlers[sub]();
    },
  };
}
