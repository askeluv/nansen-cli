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

  it('documents the supported alerts-based limit order workflow', () => {
    const skillPath = path.join(repoRoot, 'skills', 'nansen-limit-orders', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');

    expect(content).toContain('nansen-cli` does **not** currently place resting/native limit orders');
    expect(content).toContain('trading-api.nansen.ai');
    expect(content).toContain('nansen alerts create');
    expect(content).toContain('common-token-transfer');
    expect(content).toContain('Do **not** tell');
    expect(content).toContain('that command does not exist');
    expect(content).toContain('not precise fill detection');
    expect(content).toContain('wallet-wide transfer alert');
  });
});
