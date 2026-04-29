import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(process.cwd());
const skillPath = path.join(repoRoot, 'skills', 'nansen-limit-orders', 'SKILL.md');

function readSkill() {
  return fs.readFileSync(skillPath, 'utf8');
}

describe('skills', () => {
  it('includes the nansen-limit-orders skill with valid frontmatter', () => {
    const content = readSkill();

    expect(content).toContain('name: nansen-limit-orders');
    expect(content).toContain('description:');
    expect(content).toContain('allowed-tools: Bash(nansen:*)');
  });

  it('documents the native Solana limit-order command surface', () => {
    const content = readSkill();

    expect(content).toContain('nansen trade limit-order create');
    expect(content).toContain('nansen trade limit-order list');
    expect(content).toContain('nansen trade limit-order cancel');
    expect(content).toContain('nansen trade limit-order update');
    expect(content).toContain('--trigger-mint');
    expect(content).toContain('--trigger-condition');
    expect(content).toContain('--trigger-price');
    expect(content).toContain('--slippage-bps');
    expect(content).toContain('--expires');
    expect(content).toContain('Minimum order value');
  });

  it('does not reference renamed/removed flag forms', () => {
    const content = readSkill();

    // The hyphenless `trade limit ` (with trailing space) name was never shipped.
    expect(content).not.toMatch(/nansen trade limit (?:create|list|cancel|update)/);
    // Slippage was renamed --slippage → --slippage-bps. The skill must not regress.
    expect(content).not.toMatch(/--slippage(?!-bps)/);
    // --amount-unit was never shipped — amount is always in token units.
    expect(content).not.toContain('--amount-unit');
  });

  it('documents the alert-based fallback for non-Solana chains', () => {
    const content = readSkill();

    expect(content).toContain('does not currently place native limit orders on EVM chains');
    expect(content).toContain('nansen alerts create');
    expect(content).toContain('common-token-transfer');
    expect(content).toContain('best-effort settlement signal, not authoritative order tracking');
    expect(content).toContain('Do **not** describe alert delivery as "order filled"');
    expect(content).toContain('wallet-wide transfer alert');
  });

  it('matches the schema-declared limit-order command surface', () => {
    const content = readSkill();
    const schema = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'src', 'schema.json'), 'utf8')
    );

    const limitOrder = schema.commands?.trade?.subcommands?.['limit-order'];
    expect(limitOrder, 'schema must declare trade.limit-order').toBeTruthy();

    for (const sub of ['create', 'list', 'cancel', 'update']) {
      expect(limitOrder.subcommands[sub], `schema missing trade limit-order ${sub}`).toBeTruthy();
      expect(content).toContain(`nansen trade limit-order ${sub}`);
    }

    // Every flag the skill mentions for `create` must exist in the schema.
    const createOpts = Object.keys(limitOrder.subcommands.create.options);
    for (const flag of ['from', 'to', 'amount', 'trigger-mint', 'trigger-condition', 'trigger-price', 'slippage-bps', 'expires', 'wallet']) {
      expect(createOpts).toContain(flag);
      expect(content).toContain(`--${flag}`);
    }
  });
});
