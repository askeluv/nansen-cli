import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(process.cwd());

describe('skills', () => {
  it('includes the nansen-limit-orders skill with valid frontmatter', () => {
    const skillPath = path.join(repoRoot, 'skills', 'nansen-limit-orders', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');

    expect(content).toContain('name: nansen-limit-orders');
    expect(content).toContain('description:');
    expect(content).toContain('allowed-tools: Bash(nansen:*)');
  });

  it('documents the native Solana limit-order command surface', () => {
    const skillPath = path.join(repoRoot, 'skills', 'nansen-limit-orders', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');

    expect(content).toContain('nansen trade limit create');
    expect(content).toContain('nansen trade limit list');
    expect(content).toContain('nansen trade limit cancel');
    expect(content).toContain('nansen trade limit update');
    expect(content).toContain('--trigger-mint');
    expect(content).toContain('--trigger-condition');
    expect(content).toContain('--trigger-price');
    expect(content).toContain('--amount-unit token');
    expect(content).toContain('--expires');
    expect(content).toContain('Minimum order value');
  });

  it('documents the alert-based fallback for non-Solana chains', () => {
    const skillPath = path.join(repoRoot, 'skills', 'nansen-limit-orders', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');

    expect(content).toContain('does not currently place native limit orders on EVM chains');
    expect(content).toContain('nansen alerts create');
    expect(content).toContain('common-token-transfer');
    expect(content).toContain('best-effort settlement signal, not authoritative order tracking');
    expect(content).toContain('Do **not** describe alert delivery as "order filled"');
    expect(content).toContain('wallet-wide transfer alert');
  });
});
