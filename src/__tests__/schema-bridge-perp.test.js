import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const schema = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.json'),
    'utf8',
  ),
);

// `bridge` is a top-level command group, so leaving it out of the schema made it
// undiscoverable to anything driving the CLI off `nansen schema`.
describe('bridge is described in the schema', () => {
  it('exists with all three subcommands', () => {
    expect(Object.keys(schema.commands)).toContain('bridge');
    expect(Object.keys(schema.commands.bridge.subcommands).sort()).toEqual([
      'execute',
      'quote',
      'status',
    ]);
  });

  it('documents the same routes the code enforces', () => {
    // Kept in step with BRIDGE_ROUTES in bridge.js by hand; this pins the pair
    // list so the two cannot drift silently.
    expect(schema.commands.bridge.routes).toEqual([
      { origin: 'base', destination: 'hyperliquid', direction: 'deposit' },
      { origin: 'hyperliquid', destination: 'base', direction: 'withdrawal' },
      { origin: 'hyperliquid', destination: 'ethereum', direction: 'withdrawal' },
      { origin: 'hyperliquid', destination: 'arbitrum', direction: 'withdrawal' },
    ]);
  });

  it('constrains the chain enums to the supported routes', () => {
    const { quote } = schema.commands.bridge.subcommands;
    expect(quote.options['from-chain'].enum).toEqual(['base', 'hyperliquid']);
    expect(quote.options['to-chain'].enum).toEqual([
      'hyperliquid', 'base', 'ethereum', 'arbitrum',
    ]);
  });

  it('points each subcommand at the route it actually calls', () => {
    const subs = schema.commands.bridge.subcommands;
    expect(subs.quote.endpoint).toBe('/api/v1/perp/bridge/quote');
    expect(subs.execute.endpoint).toBe('/api/v1/perp/bridge/execute');
    expect(subs.status.endpoint).toBe('/api/v1/perp/bridge/status');
  });
});

// After the direct-submit refactor these commands sign locally and post to
// Hyperliquid. `endpoint` is also what the help renderer resolves a credit cost
// against, so naming a route the command never calls is wrong twice over.
describe('perp mutating subcommands describe direct Hyperliquid submission', () => {
  const MUTATING = ['order', 'cancel', 'close', 'leverage', 'transfer', 'approve-builder-fee'];

  for (const name of MUTATING) {
    it(`${name} declares submitsTo and no stale endpoint`, () => {
      const sub = schema.commands.perp.subcommands[name];
      expect(sub.submitsTo).toBe('https://api.hyperliquid.xyz/exchange');
      expect(sub.endpoint).toBeUndefined();
      // Screening is fail-closed on every mutating command, so it is always
      // among the API routes these commands consume.
      expect(sub.apiEndpoints).toContain('/api/v1/sanctions/screen');
    });
  }

  it('leaves the read-only subcommands pointing at the API', () => {
    for (const name of ['positions', 'orders', 'account', 'meta']) {
      const sub = schema.commands.perp.subcommands[name];
      expect(sub.endpoint).toBe(`/api/v1/perp/${name}`);
      expect(sub.submitsTo).toBeUndefined();
    }
  });

  it('never claims a mutating perp action posts to a Nansen route', () => {
    for (const name of MUTATING) {
      const sub = schema.commands.perp.subcommands[name];
      // The write path is Hyperliquid's; anything under apiEndpoints must be a
      // read the command performs, not the submission target.
      expect(sub.apiEndpoints ?? []).not.toContain(`/api/v1/perp/${name}`);
    }
  });
});
