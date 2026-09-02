/**
 * Package Integrity Test
 *
 * Packs the tarball, installs it in a temp directory, and runs the CLI.
 * Catches issues like missing files in the `files` field (e.g., 1.18.0 breakage).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Package Integrity', () => {
  const tmpDirs = [];

  afterAll(() => {
    // Cleanup temp directories
    for (const dir of tmpDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('should run after npm pack (catches missing files)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'nansen-pack-test-'));
    tmpDirs.push(tmpDir);

    // Pack from repo root
    const packOutput = execSync('npm pack --json', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const [packInfo] = JSON.parse(packOutput);
    const tgzPath = join(process.cwd(), packInfo.filename);

    // Install in isolated temp directory
    execSync('npm init -y', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`npm install "${tgzPath}"`, { cwd: tmpDir, stdio: 'ignore' });

    // Smoke test - if any import fails (e.g., missing src/commands/), this crashes.
    // Resolve the .cmd extension on Windows, where node_modules/.bin shims aren't extensionless.
    const binary = join(tmpDir, 'node_modules', '.bin', process.platform === 'win32' ? 'nansen.cmd' : 'nansen');
    const result = execSync(`"${binary}" --help`, {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result).toContain('nansen');
    expect(result).toContain('COMMANDS');

    // Cleanup tarball
    rmSync(tgzPath, { force: true });
  });

  it('should not include test files in package', () => {
    const packOutput = execSync('npm pack --dry-run --json', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const [packInfo] = JSON.parse(packOutput);
    const files = packInfo.files.map(f => f.path);

    const testFiles = files.filter(f => f.includes('__tests__'));
    expect(testFiles).toHaveLength(0);
  });
});
