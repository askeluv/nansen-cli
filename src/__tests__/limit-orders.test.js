/**
 * Tests for limit-orders module.
 * Covers storage, channel/payload builders, and the create/list/delete handlers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  saveLimitOrder,
  loadLimitOrder,
  listLimitOrders,
  deleteLimitOrderFile,
  buildLimitOrderChannels,
  buildLimitOrderAlertPayload,
  formatLimitOrdersTable,
  buildLimitOrdersCommands,
} from '../commands/limit-orders.js';
import { createWallet, setDefaultWallet } from '../wallet.js';

let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-limit-orders-test-'));
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============= Storage =============

describe('limit-order storage', () => {
  const sample = {
    orderId: '1700000000000-abcd1234',
    createdAt: 1700000000000,
    walletName: 'main',
    walletAddress: '0xabc',
    chain: 'base',
    side: 'buy',
    tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    tokenSymbol: 'USDC',
    targetPriceUsd: '0.99',
    amount: '100',
    amountUnit: 'usd',
    name: 'test',
    alertId: 'alert-xyz',
    channels: ['telegram'],
  };

  it('saves and loads a limit order', () => {
    saveLimitOrder(sample);
    const loaded = loadLimitOrder(sample.orderId);
    expect(loaded).toEqual(sample);
  });

  it('returns null for missing order', () => {
    expect(loadLimitOrder('nope')).toBeNull();
  });

  it('lists orders sorted by createdAt desc', () => {
    saveLimitOrder({ ...sample, orderId: 'a', createdAt: 100 });
    saveLimitOrder({ ...sample, orderId: 'b', createdAt: 200 });
    saveLimitOrder({ ...sample, orderId: 'c', createdAt: 150 });
    const ids = listLimitOrders().map(o => o.orderId);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('deletes an existing order', () => {
    saveLimitOrder(sample);
    expect(deleteLimitOrderFile(sample.orderId)).toBe(true);
    expect(loadLimitOrder(sample.orderId)).toBeNull();
  });

  it('delete returns false when order is missing', () => {
    expect(deleteLimitOrderFile('does-not-exist')).toBe(false);
  });

  it('returns empty list when dir does not exist', () => {
    expect(listLimitOrders()).toEqual([]);
  });
});

// ============= Channel Builder =============

describe('buildLimitOrderChannels', () => {
  it('builds telegram channel', () => {
    expect(buildLimitOrderChannels({ telegram: '12345' })).toEqual([
      { type: 'telegram', data: { chatId: '12345' } },
    ]);
  });

  it('coerces telegram chat ID to string', () => {
    expect(buildLimitOrderChannels({ telegram: 12345 })).toEqual([
      { type: 'telegram', data: { chatId: '12345' } },
    ]);
  });

  it('builds slack/discord/webhook channels', () => {
    const result = buildLimitOrderChannels({
      slack: 'https://hooks.slack.com/abc',
      discord: 'https://discord.com/api/webhooks/xyz',
      webhook: 'https://example.com/h',
    });
    expect(result).toEqual([
      { type: 'slack', data: { webhookUrl: 'https://hooks.slack.com/abc' } },
      { type: 'discord', data: { webhookUrl: 'https://discord.com/api/webhooks/xyz' } },
      { type: 'webhook', data: { webhookUrl: 'https://example.com/h' } },
    ]);
  });

  it('attaches webhook secret when ≥16 chars', () => {
    const out = buildLimitOrderChannels({
      webhook: 'https://example.com/h',
      'webhook-secret': 'sixteenCharsExact',
    });
    expect(out[0].data.secret).toBe('sixteenCharsExact');
  });

  it('rejects short webhook secret', () => {
    expect(() => buildLimitOrderChannels({
      webhook: 'https://example.com',
      'webhook-secret': 'short',
    })).toThrow('at least 16 characters');
  });

  it('rejects webhook-secret without webhook', () => {
    expect(() => buildLimitOrderChannels({ 'webhook-secret': 'sixteenCharsExact' }))
      .toThrow('--webhook-secret requires --webhook');
  });

  it('returns empty array when no channels are provided', () => {
    expect(buildLimitOrderChannels({})).toEqual([]);
  });
});

// ============= Alert Payload Builder =============

describe('buildLimitOrderAlertPayload', () => {
  const channels = [{ type: 'telegram', data: { chatId: '1' } }];

  it('builds a buy-side alert with subject + token inclusion', () => {
    const payload = buildLimitOrderAlertPayload({
      name: 'Limit buy USDC',
      walletAddress: '0xWALLET',
      tokenAddress: '0xTOKEN',
      chain: 'base',
      side: 'buy',
      channels,
    });
    expect(payload.type).toBe('common-token-transfer');
    expect(payload.timeWindow).toBe('realtime');
    expect(payload.isEnabled).toBe(true);
    expect(payload.channels).toEqual(channels);
    expect(payload.data.events).toEqual(['buy']);
    expect(payload.data.chains).toEqual(['base']);
    expect(payload.data.subjects).toEqual([{ type: 'address', value: '0xWALLET' }]);
    expect(payload.data.inclusion).toEqual({ tokens: [{ address: '0xTOKEN', chain: 'base' }] });
  });

  it('builds a sell-side alert', () => {
    const payload = buildLimitOrderAlertPayload({
      name: 'n', walletAddress: 'w', tokenAddress: 't', chain: 'solana', side: 'sell', channels,
    });
    expect(payload.data.events).toEqual(['sell']);
  });

  it('attaches description when provided', () => {
    const payload = buildLimitOrderAlertPayload({
      name: 'n', description: 'why', walletAddress: 'w', tokenAddress: 't', chain: 'base', side: 'buy', channels,
    });
    expect(payload.description).toBe('why');
  });

  it('rejects unknown side', () => {
    expect(() => buildLimitOrderAlertPayload({
      name: 'n', walletAddress: 'w', tokenAddress: 't', chain: 'base', side: 'hold', channels,
    })).toThrow('Invalid --side');
  });
});

// ============= Table Formatter =============

describe('formatLimitOrdersTable', () => {
  it('returns placeholder when no orders', () => {
    expect(formatLimitOrdersTable([])).toBe('No limit orders');
    expect(formatLimitOrdersTable(null)).toBe('No limit orders');
  });

  it('renders header + row for an order', () => {
    const out = formatLimitOrdersTable([{
      orderId: 'o1', walletName: 'main', side: 'buy', tokenSymbol: 'USDC',
      chain: 'base', targetPriceUsd: '0.99', alertId: 'a1',
    }]);
    expect(out).toMatch(/ID/);
    expect(out).toMatch(/o1/);
    expect(out).toMatch(/BUY/);
    expect(out).toMatch(/USDC/);
  });
});

// ============= Command Handler =============

describe('buildLimitOrdersCommands - create', () => {
  function makeWallet() {
    createWallet('main', null);
    setDefaultWallet('main');
  }

  function setup({ alertCreate } = {}) {
    const log = vi.fn();
    const cmd = buildLimitOrdersCommands({ log })['limit-order'];
    const apiInstance = {
      alertsCreate: alertCreate || vi.fn().mockResolvedValue({ id: 'alert-123' }),
      alertsDelete: vi.fn().mockResolvedValue({ deleted: true }),
    };
    return { cmd, apiInstance, log };
  }

  it('rejects missing required flags', async () => {
    const { cmd, apiInstance } = setup();
    await expect(cmd(['create'], apiInstance, {}, {})).rejects.toThrow(/Required:.*--chain/);
  });

  it('rejects invalid --side', async () => {
    makeWallet();
    const { cmd, apiInstance } = setup();
    await expect(cmd(['create'], apiInstance, {}, {
      chain: 'base', side: 'hold', token: 'USDC', 'target-price': '1', amount: '100', telegram: '1',
    })).rejects.toThrow(/Invalid --side/);
  });

  it('rejects invalid --target-price', async () => {
    makeWallet();
    const { cmd, apiInstance } = setup();
    await expect(cmd(['create'], apiInstance, {}, {
      chain: 'base', side: 'buy', token: 'USDC', 'target-price': '-1', amount: '100', telegram: '1',
    })).rejects.toThrow(/positive number/);
  });

  it('rejects when no channel is provided', async () => {
    makeWallet();
    const { cmd, apiInstance } = setup();
    await expect(cmd(['create'], apiInstance, {}, {
      chain: 'base', side: 'buy', token: 'USDC', 'target-price': '1', amount: '100',
    })).rejects.toThrow(/channel/);
  });

  it('creates order, calls alertsCreate, persists order, returns record', async () => {
    makeWallet();
    const { cmd, apiInstance } = setup();
    const result = await cmd(['create'], apiInstance, {}, {
      chain: 'base', side: 'buy', token: 'USDC',
      'target-price': '0.99', amount: '100', 'amount-unit': 'usd',
      telegram: '12345',
    });

    expect(result.orderId).toMatch(/^\d+-[a-f0-9]+$/);
    expect(result.alertId).toBe('alert-123');
    expect(result.chain).toBe('base');
    expect(result.side).toBe('buy');
    expect(result.tokenAddress).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'); // resolved USDC on base
    expect(result.tokenSymbol).toBe('USDC');
    expect(result.targetPriceUsd).toBe('0.99');
    expect(result.amount).toBe('100');
    expect(result.amountUnit).toBe('usd');
    expect(result.channels).toEqual(['telegram']);

    expect(apiInstance.alertsCreate).toHaveBeenCalledTimes(1);
    const payload = apiInstance.alertsCreate.mock.calls[0][0];
    expect(payload.type).toBe('common-token-transfer');
    expect(payload.data.events).toEqual(['buy']);
    expect(payload.data.subjects[0].type).toBe('address');
    expect(payload.data.inclusion.tokens[0].address).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    // Persisted to disk
    expect(loadLimitOrder(result.orderId)).toMatchObject({ orderId: result.orderId, alertId: 'alert-123' });
  });

  it('throws when alertsCreate response has no id', async () => {
    makeWallet();
    const { cmd, apiInstance } = setup({ alertCreate: vi.fn().mockResolvedValue({}) });
    await expect(cmd(['create'], apiInstance, {}, {
      chain: 'base', side: 'buy', token: 'USDC', 'target-price': '1', amount: '100', telegram: '1',
    })).rejects.toThrow(/no alert id/);
  });

  it('uses --name when provided', async () => {
    makeWallet();
    const { cmd, apiInstance } = setup();
    await cmd(['create'], apiInstance, {}, {
      chain: 'base', side: 'sell', token: 'USDC', 'target-price': '1.01', amount: '50',
      telegram: '1', name: 'My Custom Order',
    });
    expect(apiInstance.alertsCreate.mock.calls[0][0].name).toBe('My Custom Order');
  });
});

describe('buildLimitOrdersCommands - list', () => {
  it('returns empty array when no orders', async () => {
    const cmd = buildLimitOrdersCommands({ log: vi.fn() })['limit-order'];
    const result = await cmd(['list'], {}, {}, {});
    expect(result).toEqual([]);
  });

  it('returns persisted orders', async () => {
    saveLimitOrder({ orderId: 'a', createdAt: 1, walletName: 'w', walletAddress: 'w', chain: 'base', side: 'buy', tokenAddress: 't', alertId: 'x' });
    const cmd = buildLimitOrdersCommands({ log: vi.fn() })['limit-order'];
    const result = await cmd(['list'], {}, {}, {});
    expect(result).toHaveLength(1);
    expect(result[0].orderId).toBe('a');
  });

  it('logs table when --table flag is set', async () => {
    saveLimitOrder({ orderId: 'a', createdAt: 1, walletName: 'w', walletAddress: 'w', chain: 'base', side: 'buy', tokenAddress: 't', alertId: 'x' });
    const log = vi.fn();
    const cmd = buildLimitOrdersCommands({ log })['limit-order'];
    const result = await cmd(['list'], {}, { table: true }, {});
    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ID/));
  });
});

describe('buildLimitOrdersCommands - delete', () => {
  function setup() {
    const log = vi.fn();
    const cmd = buildLimitOrdersCommands({ log })['limit-order'];
    return { cmd, log };
  }

  it('rejects missing orderId', async () => {
    const { cmd } = setup();
    await expect(cmd(['delete'], {}, {}, {})).rejects.toThrow(/Required: <orderId>/);
  });

  it('throws when order does not exist', async () => {
    const { cmd } = setup();
    await expect(cmd(['delete', 'nope'], {}, {}, {})).rejects.toThrow(/not found/);
  });

  it('deletes companion alert and removes local record on success', async () => {
    saveLimitOrder({ orderId: 'o1', alertId: 'a1', chain: 'base', side: 'buy', walletAddress: 'w', tokenAddress: 't', createdAt: 1 });
    const apiInstance = { alertsDelete: vi.fn().mockResolvedValue({ deleted: true }) };
    const { cmd } = setup();
    const result = await cmd(['delete', 'o1'], apiInstance, {}, {});
    expect(apiInstance.alertsDelete).toHaveBeenCalledWith('a1');
    expect(result).toEqual({ orderId: 'o1', alertId: 'a1', deleted: true, alertDeleted: true });
    expect(loadLimitOrder('o1')).toBeNull();
  });

  it('still removes local record when alertsDelete fails', async () => {
    saveLimitOrder({ orderId: 'o2', alertId: 'a2', chain: 'base', side: 'buy', walletAddress: 'w', tokenAddress: 't', createdAt: 1 });
    const apiInstance = { alertsDelete: vi.fn().mockRejectedValue(new Error('404 not found')) };
    const { cmd } = setup();
    const result = await cmd(['delete', 'o2'], apiInstance, {}, {});
    expect(result.deleted).toBe(true);
    expect(result.alertDeleted).toBe(false);
    expect(result.alertDeleteError).toBe('404 not found');
    expect(loadLimitOrder('o2')).toBeNull();
  });
});

describe('buildLimitOrdersCommands - help', () => {
  it('logs top-level help with no subcommand', async () => {
    const log = vi.fn();
    const cmd = buildLimitOrdersCommands({ log })['limit-order'];
    await cmd([], {}, {}, {});
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/SUBCOMMANDS/));
  });

  it('rejects unknown subcommand', async () => {
    const cmd = buildLimitOrdersCommands({ log: vi.fn() })['limit-order'];
    await expect(cmd(['nope'], {}, {}, {})).rejects.toThrow(/Unknown limit-order subcommand/);
  });
});
