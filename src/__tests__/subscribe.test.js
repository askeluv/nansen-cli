/**
 * Subscribe command tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSubscribeCommands, formatPlansTable, formatPromoCode, formatSubscriptionsTable } from '../commands/subscribe.js';
import { NansenAPI, ErrorCode } from '../api.js';

// ── Helpers ──

function mockApi(overrides = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.nansen.ai',
    appBaseUrl: 'https://app.nansen.ai',
    defaultHeaders: {},
    getApiPlans: vi.fn(),
    validatePromoCode: vi.fn(),
    createStripeSubscription: vi.fn(),
    createMoonpaySubscription: vi.fn(),
    getActiveSubscriptions: vi.fn(),
    cancelSubscription: vi.fn(),
    ...overrides,
  };
}

// ── Tests ──

describe('subscribe command', () => {
  let log, cmd;

  afterEach(() => { vi.restoreAllMocks(); });

  beforeEach(() => {
    log = vi.fn();
    cmd = buildSubscribeCommands({ log })['subscribe'];
  });

  // ── Help output ──

  describe('help output', () => {
    it('shows top-level help when no subcommand', async () => {
      await cmd([], mockApi(), {}, {});
      expect(log).toHaveBeenCalledWith(expect.stringContaining('SUBCOMMANDS'));
    });

    it('shows help for "help" subcommand', async () => {
      await cmd(['help'], mockApi(), {}, {});
      expect(log).toHaveBeenCalledWith(expect.stringContaining('SUBCOMMANDS'));
    });

    it('shows plans help with --help flag', async () => {
      await cmd(['plans'], mockApi(), { help: true }, {});
      expect(log).toHaveBeenCalledWith(expect.stringContaining('List available API plans'));
    });

    it('shows create help with --help flag', async () => {
      await cmd(['create'], mockApi(), { help: true }, {});
      expect(log).toHaveBeenCalledWith(expect.stringContaining('--price-id'));
    });
  });

  // ── Plans ──

  describe('plans', () => {
    it('calls getApiPlans and returns result', async () => {
      const plans = [{ name: 'Pro', price: 9900, currency: 'usd', interval: 'month', priceId: 'price_123' }];
      const api = mockApi({ getApiPlans: vi.fn().mockResolvedValue(plans) });
      const result = await cmd(['plans'], api, {}, {});
      expect(api.getApiPlans).toHaveBeenCalled();
      expect(result).toEqual(plans);
    });
  });

  // ── Promo code ──

  describe('promo-code', () => {
    it('validates a promo code', async () => {
      const promo = { code: 'SAVE20', percentOff: 20 };
      const api = mockApi({ validatePromoCode: vi.fn().mockResolvedValue(promo) });
      const result = await cmd(['promo-code', 'SAVE20'], api, {}, {});
      expect(api.validatePromoCode).toHaveBeenCalledWith('SAVE20');
      expect(result).toEqual(promo);
    });

    it('trims promo code input', async () => {
      const api = mockApi({ validatePromoCode: vi.fn().mockResolvedValue({ code: 'SAVE20' }) });
      await cmd(['promo-code', '  SAVE20  '], api, {}, {});
      expect(api.validatePromoCode).toHaveBeenCalledWith('SAVE20');
    });

    it('throws when code is missing', async () => {
      await expect(cmd(['promo-code'], mockApi(), {}, {}))
        .rejects.toThrow('Required: <code>');
    });
  });

  // ── Create ──

  describe('create', () => {
    it('creates a stripe subscription by default', async () => {
      const resp = { id: 'sub_1', url: 'https://checkout.stripe.com/...' };
      const api = mockApi({ createStripeSubscription: vi.fn().mockResolvedValue(resp) });
      const result = await cmd(['create'], api, {}, { 'price-id': 'price_123', 'promo-code': 'SAVE20', 'payment-method': 'pm_abc' });
      expect(api.createStripeSubscription).toHaveBeenCalledWith({
        priceId: 'price_123',
        promotionCode: 'SAVE20',
        paymentMethodId: 'pm_abc',
      });
      expect(result).toEqual(resp);
    });

    it('normalizes provider and trims create inputs', async () => {
      const api = mockApi({ createMoonpaySubscription: vi.fn().mockResolvedValue({}) });
      await cmd(['create'], api, {}, { 'price-id': ' price_123 ', provider: ' Moonpay ', 'promo-code': ' SAVE20 ' });
      expect(api.createMoonpaySubscription).toHaveBeenCalledWith({
        priceId: 'price_123',
        promotionCode: 'SAVE20',
      });
    });

    it('creates a moonpay subscription', async () => {
      const resp = { id: 'sub_3' };
      const api = mockApi({ createMoonpaySubscription: vi.fn().mockResolvedValue(resp) });
      const result = await cmd(['create'], api, {}, { 'price-id': 'price_123', provider: 'moonpay' });
      expect(api.createMoonpaySubscription).toHaveBeenCalledWith({
        priceId: 'price_123',
        promotionCode: undefined,
      });
      expect(result).toEqual(resp);
    });

    it('throws when --price-id is missing', async () => {
      await expect(cmd(['create'], mockApi(), {}, {}))
        .rejects.toThrow('Required: --price-id');
    });

    it('throws when stripe is missing --payment-method', async () => {
      const api = mockApi({ createStripeSubscription: vi.fn() });
      const err = await cmd(['create'], api, {}, { 'price-id': 'price_123' }).catch(e => e);
      expect(err.message).toContain('Required: --payment-method');
      expect(err.code).toBe(ErrorCode.MISSING_PARAM);
      expect(api.createStripeSubscription).not.toHaveBeenCalled();
    });

    it('throws for unknown provider', async () => {
      const err = await cmd(['create'], mockApi(), {}, { 'price-id': 'price_123', provider: 'paypal' }).catch(e => e);
      expect(err.message).toContain('Unknown provider');
      expect(err.code).toBe(ErrorCode.INVALID_PARAMS);
    });

    it('passes --payment-method for stripe', async () => {
      const api = mockApi({ createStripeSubscription: vi.fn().mockResolvedValue({}) });
      await cmd(['create'], api, {}, { 'price-id': 'price_123', 'payment-method': 'pm_abc' });
      expect(api.createStripeSubscription).toHaveBeenCalledWith({
        priceId: 'price_123',
        promotionCode: undefined,
        paymentMethodId: 'pm_abc',
      });
    });

    it('throws when --provider is provided without a value', async () => {
      const api = mockApi({ createStripeSubscription: vi.fn() });
      const err = await cmd(['create'], api, { provider: true }, { 'price-id': 'price_123' }).catch(e => e);
      expect(err.message).toContain('Required: --provider <value>');
      expect(err.code).toBe(ErrorCode.MISSING_PARAM);
      expect(api.createStripeSubscription).not.toHaveBeenCalled();
    });

    it('throws when --promo-code is provided without a value', async () => {
      const api = mockApi({ createStripeSubscription: vi.fn() });
      const err = await cmd(['create'], api, { 'promo-code': true }, { 'price-id': 'price_123' }).catch(e => e);
      expect(err.message).toContain('Required: --promo-code <value>');
      expect(err.code).toBe(ErrorCode.MISSING_PARAM);
      expect(api.createStripeSubscription).not.toHaveBeenCalled();
    });

    it('throws when --payment-method is used with non-stripe providers', async () => {
      await expect(cmd(['create'], mockApi(), {}, { 'price-id': 'price_123', provider: 'moonpay', 'payment-method': 'pm_abc' }))
        .rejects.toThrow('--payment-method is only supported');
    });

    it('throws when repeatable text options are provided more than once', async () => {
      await expect(cmd(['create'], mockApi(), {}, { 'price-id': 'price_123', 'promo-code': ['SAVE20', 'SAVE30'] }))
        .rejects.toThrow('Use --promo-code only once');
    });
  });

  // ── Cancel ──

  describe('cancel', () => {
    it('calls cancelSubscription', async () => {
      const api = mockApi({ cancelSubscription: vi.fn().mockResolvedValue({ success: true }) });
      const result = await cmd(['cancel'], api, {}, {});
      expect(api.cancelSubscription).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  // ── Status ──

  describe('status', () => {
    it('calls getActiveSubscriptions', async () => {
      const subs = [{ id: 'sub_1', status: 'active', provider: 'stripe' }];
      const api = mockApi({ getActiveSubscriptions: vi.fn().mockResolvedValue(subs) });
      const result = await cmd(['status'], api, {}, {});
      expect(api.getActiveSubscriptions).toHaveBeenCalled();
      expect(result).toEqual(subs);
    });
  });

  // ── Unknown subcommand ──

  it('throws for unknown subcommand', async () => {
    await expect(cmd(['bogus'], mockApi(), {}, {}))
      .rejects.toThrow('Unknown subscribe subcommand');
  });
});

// ── Formatting ──

describe('formatPlansTable', () => {
  it('formats plans as a table', () => {
    const plans = [
      { name: 'Pro', price: 9900, currency: 'usd', interval: 'month', priceId: 'price_123' },
      { name: 'Enterprise', price: 49900, currency: 'usd', interval: 'year', priceId: 'price_456' },
    ];
    const table = formatPlansTable(plans);
    expect(table).toContain('NAME');
    expect(table).toContain('PRICE');
    expect(table).toContain('Pro');
    expect(table).toContain('99.00 USD');
    expect(table).toContain('Enterprise');
  });

  it('returns "No plans available" for empty array', () => {
    expect(formatPlansTable([])).toBe('No plans available');
  });

  it('formats backend /plans/api response shape', () => {
    const table = formatPlansTable({
      result: {
        id: 'prod_api',
        name: 'api',
        prices: [
          {
            id: 'price_api_month',
            currency: 'usd',
            price_usd: 49,
            interval: 'month',
            interval_count: 1,
          },
          {
            id: 'price_api_year',
            currency: 'usd',
            price_usd: 499,
            interval: 'year',
            interval_count: 1,
          },
        ],
      },
    });
    expect(table).toContain('api');
    expect(table).toContain('49.00 USD');
    expect(table).toContain('499.00 USD');
    expect(table).toContain('price_api_month');
    expect(table).toContain('price_api_year');
  });
});

describe('formatPromoCode', () => {
  it('formats percent off', () => {
    const result = formatPromoCode({ code: 'SAVE20', percentOff: 20 });
    expect(result).toContain('SAVE20');
    expect(result).toContain('20%');
  });

  it('formats amount off', () => {
    const result = formatPromoCode({ code: 'FLAT10', amountOff: 1000, currency: 'usd' });
    expect(result).toContain('10.00 USD');
  });

  it('formats firstTimeTransaction', () => {
    const result = formatPromoCode({ code: 'NEW', percentOff: 10, firstTimeTransaction: true });
    expect(result).toContain('First-time only: yes');
  });

  it('returns fallback for null', () => {
    expect(formatPromoCode(null)).toBe('Invalid promo code');
  });
});

describe('formatSubscriptionsTable', () => {
  it('formats subscriptions as a table', () => {
    const subs = [{ id: 'sub_1', status: 'active', provider: 'stripe' }];
    const table = formatSubscriptionsTable(subs);
    expect(table).toContain('ID');
    expect(table).toContain('STATUS');
    expect(table).toContain('sub_1');
    expect(table).toContain('active');
  });

  it('omits provider column when subscriptions do not include providers', () => {
    const table = formatSubscriptionsTable([{ id: 'sub_1', status: 'active' }]);
    expect(table).toContain('ID');
    expect(table).toContain('STATUS');
    expect(table).not.toContain('PROVIDER');
  });

  it('returns "No active subscriptions" for empty array', () => {
    expect(formatSubscriptionsTable([])).toBe('No active subscriptions');
  });
});

describe('NansenAPI subscription endpoints', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('routes app requests to appBaseUrl without mutating baseUrl', async () => {
    const api = new NansenAPI('test-key', 'https://api.nansen.ai', { appBaseUrl: 'https://app.example' });

    await api.getApiPlans();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://app.example/plans/api',
      expect.objectContaining({ method: 'GET' })
    );
    expect(api.baseUrl).toBe('https://api.nansen.ai');
  });

  it('does not cache subscription creation requests', async () => {
    const api = new NansenAPI('test-key', 'https://api.nansen.ai', {
      appBaseUrl: 'https://app.example',
      cache: { enabled: true, ttl: 300 },
    });
    const priceId = `price_${Date.now()}`;

    await api.createStripeSubscription({ priceId, paymentMethodId: 'pm_abc' });
    await api.createStripeSubscription({ priceId, paymentMethodId: 'pm_abc' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('handles no-content subscription cancellation responses', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn(),
    });
    const api = new NansenAPI('test-key', 'https://api.nansen.ai', {
      appBaseUrl: 'https://app.example',
    });

    await expect(api.cancelSubscription()).resolves.toEqual({});
    expect(global.fetch).toHaveBeenCalledWith(
      'https://app.example/subscription/recurring',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('requires paymentMethodId for stripe subscription requests', async () => {
    const api = new NansenAPI('test-key', 'https://api.nansen.ai', {
      appBaseUrl: 'https://app.example',
    });

    await expect(api.createStripeSubscription({ priceId: 'price_123' }))
      .rejects.toMatchObject({ code: ErrorCode.MISSING_PARAM });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
