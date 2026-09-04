/**
 * Tests for `nansen completion <bash|zsh|fish>` (src/commands/completion.js).
 *
 * The scripts are generated, so the tests that matter are the ones a human
 * would otherwise have to do by hand: does the shell parse it, does the tree
 * still match the commands the CLI actually dispatches, and does a quoted
 * description in schema.json survive into shell source intact.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildCompletionSpec,
  buildCompletionCommands,
  generateCompletion,
  shortDesc,
  COMPLETION_SHELLS,
  COMPLETION_USAGE,
  EXCLUDED_COMMANDS,
  UNSCHEMA_COMMANDS,
} from '../commands/completion.js';
import { buildCommands, runCLI, VALUELESS_FLAGS, SCHEMA } from '../cli.js';
import { buildWalletCommands } from '../wallet.js';
import { buildTradingCommands } from '../trading.js';
import { buildAlertsCommands } from '../commands/alerts.js';
import { buildAgentCommands } from '../commands/agent.js';
import { buildMcpCommands } from '../commands/mcp.js';

const spec = buildCompletionSpec();
const rootNode = spec.nodes.find(n => n.path === '');
const scripts = Object.fromEntries(COMPLETION_SHELLS.map(sh => [sh, generateCompletion(sh)]));

function hasBinary(bin) {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeTemp(name, contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-completion-')), name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('buildCompletionSpec', () => {
  it('covers every top-level command the CLI dispatches', () => {
    const runtime = {
      ...buildCommands({}),
      ...buildWalletCommands({}),
      ...buildTradingCommands({}),
      ...buildAlertsCommands({}),
      ...buildAgentCommands({}),
      ...buildMcpCommands({}),
      ...buildCompletionCommands({}),
    };
    const completed = new Set(rootNode.subcommands.map(s => s.name));
    const missing = Object.keys(runtime).filter(c => !completed.has(c) && !EXCLUDED_COMMANDS.has(c));
    expect(missing, 'add to schema.json or to UNSCHEMA_COMMANDS/EXCLUDED_COMMANDS in completion.js').toEqual([]);
  });

  it('offers no deprecated top-level aliases', () => {
    for (const name of rootNode.subcommands.map(s => s.name)) {
      expect(EXCLUDED_COMMANDS.has(name), `${name} is deprecated and should not be completed`).toBe(false);
    }
  });

  it('declares every command schema.json omits', () => {
    for (const name of Object.keys(UNSCHEMA_COMMANDS)) {
      expect(SCHEMA.commands[name], `${name} is now in schema.json — drop it from UNSCHEMA_COMMANDS`).toBeUndefined();
    }
  });

  // The walker skips the word after any option not in this list. Missing one
  // makes it swallow a real subcommand; an extra one is harmless.
  it('treats every parser-valueless flag as valueless', () => {
    for (const flag of VALUELESS_FLAGS) {
      expect(spec.valuelessFlags, `--${flag} is valueless in parseArgs`).toContain(`--${flag}`);
    }
  });

  it('walks nested subcommands down to the leaf', () => {
    const paths = spec.nodes.map(n => n.path);
    expect(paths).toContain('research');
    expect(paths).toContain('research token');
    expect(paths).toContain('trade limit-order');
    const screener = spec.nodes.find(n => n.path === 'research token screener');
    expect(screener.options.map(o => o.name)).toContain('--chain');
  });

  it('carries enum values through to the option', () => {
    const order = spec.nodes.find(n => n.path === 'perp order');
    expect(order.options.find(o => o.name === '--tif').values).toEqual(['Gtc', 'Ioc', 'Alo']);
    expect(order.options.find(o => o.name === '--side').values).toContain('long');
  });

  it('falls back to schema.chains for research --chain', () => {
    const netflow = spec.nodes.find(n => n.path === 'research smart-money netflow');
    expect(netflow.options.find(o => o.name === '--chain').values).toEqual(SCHEMA.chains);
  });

  it('leaves --chain alone outside the research tree', () => {
    const quote = spec.nodes.find(n => n.path === 'trade quote');
    expect(quote.options.find(o => o.name === '--chain').values).toEqual([]);
  });

  it('includes global options exactly once, plus --help', () => {
    const names = spec.globalOptions.map(o => o.name);
    expect(names).toContain('--pretty');
    expect(names).toContain('--fields');
    expect(names).toContain('--help');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('shortDesc', () => {
  it('flattens whitespace and caps length', () => {
    expect(shortDesc('a\n  b\tc')).toBe('a b c');
    expect(shortDesc('x'.repeat(200)).length).toBeLessThanOrEqual(72);
    expect(shortDesc(undefined)).toBe('');
  });
});

describe('generateCompletion', () => {
  it('rejects an unknown shell with an actionable message', () => {
    expect(() => generateCompletion('powershell')).toThrow(/Unsupported shell: powershell.*nansen completion <bash\|zsh\|fish>/s);
  });

  it('is deterministic', () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(generateCompletion(shell)).toBe(scripts[shell]);
    }
  });

  it.each(COMPLETION_SHELLS)('%s script names its shell and how to install it', (shell) => {
    expect(scripts[shell]).toContain(`nansen completion ${shell}`);
    expect(scripts[shell]).toContain('Install:');
  });

  it.each(COMPLETION_SHELLS)('%s script carries nested commands, flags and enum values', (shell) => {
    expect(scripts[shell]).toContain('research token screener');
    expect(scripts[shell]).toContain('trade limit-order');
    expect(scripts[shell]).toContain('--pretty');
    expect(scripts[shell]).toContain('Gtc');
  });

  // schema.json descriptions contain ' " ` $ and : — all of which end up inside
  // quoted shell strings.
  it.each(['zsh', 'fish'])('%s script keeps a quote-bearing description escaped', (shell) => {
    expect(SCHEMA.commands.perp.subcommands.transfer.description).toContain("wallet's");
    expect(scripts[shell]).toMatch(shell === 'fish' ? /wallet\\'s/ : /wallet'\\''s/);
  });

  it('bash script drops descriptions rather than quoting them', () => {
    expect(scripts.bash).not.toContain("wallet's");
  });
});

describe('shell syntax', () => {
  it('bash parses the generated script', () => {
    const file = writeTemp('nansen.bash', scripts.bash);
    expect(() => execFileSync('bash', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it.skipIf(!hasBinary('zsh'))('zsh parses the generated script', () => {
    const file = writeTemp('_nansen', scripts.zsh);
    expect(() => execFileSync('zsh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it.skipIf(!hasBinary('fish'))('fish parses the generated script', () => {
    const file = writeTemp('nansen.fish', scripts.fish);
    expect(() => execFileSync('fish', ['--no-execute', file], { stdio: 'pipe' })).not.toThrow();
  });

  // Fallback for machines without fish: every block still has to be closed.
  it('fish script balances function/switch blocks', () => {
    const lines = scripts.fish.split('\n');
    const opens = lines.filter(l => /^\s*(function|switch|for|if)\b/.test(l)).length;
    const closes = lines.filter(l => /^\s*end\s*$/.test(l)).length;
    expect(closes).toBe(opens);
  });
});

describe('bash completion behaviour', () => {
  // Drive the real completion function the way bash does: set COMP_WORDS /
  // COMP_CWORD, call it, print COMPREPLY.
  function complete(words) {
    const file = writeTemp('nansen.bash', scripts.bash);
    const driver = `
      source ${JSON.stringify(file)}
      COMP_WORDS=(${words.map(w => JSON.stringify(w)).join(' ')})
      COMP_CWORD=${words.length - 1}
      _nansen_complete
      printf '%s\\n' "\${COMPREPLY[@]}"
    `;
    return execFileSync('bash', ['-c', driver], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  }

  it('completes top-level commands', () => {
    const out = complete(['nansen', '']);
    expect(out).toContain('research');
    expect(out).toContain('trade');
    expect(out).toContain('completion');
    expect(out).not.toContain('token'); // deprecated alias
  });

  it('completes a prefix', () => {
    expect(complete(['nansen', 'compl'])).toEqual(['completion']);
  });

  it('completes nested subcommands', () => {
    expect(complete(['nansen', 'trade', 'limit-order', ''])).toEqual(['create', 'list', 'cancel', 'update']);
    expect(complete(['nansen', 'completion', ''])).toEqual(['bash', 'zsh', 'fish']);
  });

  it('completes options for the resolved command', () => {
    const out = complete(['nansen', 'research', 'token', 'screener', '--']);
    expect(out).toContain('--chain');
    expect(out).toContain('--pretty');
  });

  it('completes enum values after an option', () => {
    expect(complete(['nansen', 'perp', 'order', '--tif', ''])).toEqual(['Gtc', 'Ioc', 'Alo']);
    expect(complete(['nansen', 'research', 'smart-money', 'netflow', '--chain', ''])).toEqual(SCHEMA.chains);
  });

  it('does not lose the command path across a global flag', () => {
    expect(complete(['nansen', '--pretty', 'trade', ''])).toContain('quote');
  });

  it('does not mistake an option value for a subcommand', () => {
    // "screener" here is the value of --fields, not a subcommand of research.
    const out = complete(['nansen', 'research', '--fields', 'screener', '']);
    expect(out).toContain('token');
  });
});

describe('nansen completion command', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prints usage with no shell argument', async () => {
    const lines = [];
    const cmds = buildCompletionCommands({ log: l => lines.push(l) });
    await cmds.completion([], null, {}, {});
    expect(lines.join('\n')).toBe(COMPLETION_USAGE);
  });

  it('prints usage for --help', async () => {
    const lines = [];
    const cmds = buildCompletionCommands({ log: l => lines.push(l) });
    await cmds.completion(['bash'], null, { help: true }, {});
    expect(lines.join('\n')).toBe(COMPLETION_USAGE);
  });

  it('writes the script to stdout and touches no network', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access in completion'); });
    vi.stubGlobal('fetch', fetchSpy);
    const out = [];
    const result = await runCLI(['completion', 'bash'], {
      output: l => out.push(l),
      errorOutput: () => {},
      exit: () => {},
    });
    expect(result).toEqual({ type: 'no-output', command: 'completion' });
    expect(out.join('\n')).toContain('complete -F _nansen_complete nansen');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero on an unknown shell', async () => {
    const out = [];
    const codes = [];
    await runCLI(['completion', 'tcsh'], {
      output: l => out.push(l),
      errorOutput: () => {},
      exit: c => codes.push(c),
    });
    expect(codes).toContain(1);
    expect(out.join('\n')).toContain('Unsupported shell: tcsh');
  });
});
