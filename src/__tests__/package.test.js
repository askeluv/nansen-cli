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
    // Safely clean up temporary directories using cross-platform native Node.js filesystem methods[cite: 11]
    for (const dir of tmpDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('should run after npm pack (catches missing files)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'nansen-pack-test-'));
    tmpDirs.push(tmpDir);

    // Pack the tarball from the repository root[cite: 11]
    const packOutput = execSync('npm pack --json', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const [packInfo] = JSON.parse(packOutput);
    const tgzPath = join(process.cwd(), packInfo.filename);

    // Install the packed tarball in an isolated temporary directory[cite: 11]
    execSync('npm init -y', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`npm install "${tgzPath}"`, { cwd: tmpDir, stdio: 'ignore' });

    // Smoke test: if any import fails, for example because src/commands is missing, this crashes.
    // Ensure the executable path is resolved correctly depending on the operating system (e.g., resolving the .cmd extension for Windows)[cite: 11]
    const binary = join(tmpDir, 'node_modules', '.bin', process.platform === 'win32' ? 'nansen.cmd' : 'nansen');
    const result = execSync(`"${binary}" --help`, {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    expect(result).toContain('nansen');
    expect(result).toContain('COMMANDS');

    // Clean up the generated tarball artifact[cite: 11]
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

    // Verify that internal test files are not leaked into the final deployment package[cite: 11]
    const testFiles = files.filter(f => f.includes('__tests__'));
    expect(testFiles).toHaveLength(0);
  });
});
