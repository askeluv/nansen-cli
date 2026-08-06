import { describe, it, expect, beforeEach } from 'vitest';
import { runCLI, isUsageError } from '../cli.js';

// Usage banners are multi-line text meant to be read. Routing them through the
// error envelope serialises the newlines to literal \n, which turned every
// "you forgot an argument" response into an unreadable one-line JSON blob.
// Interactive terminals now get the banner as written; pipes and explicit
// output formats keep the envelope so agents still get one shape to parse.

let outputs;
let exitCode;

function deps(overrides = {}) {
  return {
    output: (msg) => outputs.push(msg),
    errorOutput: () => {},
    exit: (code) => { exitCode = code; },
    ...overrides,
  };
}

beforeEach(() => {
  outputs = [];
  exitCode = undefined;
});

describe('isUsageError', () => {
  const usage = { code: 'MISSING_PARAM' };

  it('is true for usage codes on a bare TTY', () => {
    expect(isUsageError(usage, { isTTY: true })).toBe(true);
    expect(isUsageError({ code: 'MISSING_ARGS' }, { isTTY: true })).toBe(true);
  });

  it('is false when not a TTY, so piped output stays machine-readable', () => {
    expect(isUsageError(usage, { isTTY: false })).toBe(false);
    expect(isUsageError(usage, {})).toBe(false);
  });

  // An explicitly requested format is a request for machine-readable output,
  // even interactively.
  for (const flag of ['pretty', 'table', 'csv', 'stream']) {
    it(`is false when --${flag} was requested`, () => {
      expect(isUsageError(usage, { isTTY: true, [flag]: true })).toBe(false);
    });
  }

  it('is false for non-usage errors, which keep the envelope', () => {
    expect(isUsageError({ code: 'UNKNOWN' }, { isTTY: true })).toBe(false);
    expect(isUsageError({ code: 'SANCTIONED' }, { isTTY: true })).toBe(false);
    // PASSWORD_REQUIRED carries structured resolution steps under details that
    // agents branch on, so it must not degrade to plain text.
    expect(isUsageError({ code: 'PASSWORD_REQUIRED' }, { isTTY: true })).toBe(false);
  });
});

describe('usage banner rendering through runCLI', () => {
  it('prints the bridge quote banner as readable text on a TTY', async () => {
    await runCLI(['bridge', 'quote'], deps({ isTTY: true }));
    const text = outputs.join('\n');
    expect(text).not.toMatch(/^\{/);
    expect(text).not.toContain('\\n');
    // Real newlines, so the sections actually render.
    expect(text).toContain('\nSUPPORTED ROUTES:\n');
    expect(text).toContain('base -> hyperliquid');
    expect(text).toContain('Usage: nansen bridge quote');
    expect(exitCode).toBe(1);
  });

  it('keeps the JSON envelope for the same command when piped', async () => {
    await runCLI(['bridge', 'quote'], deps({ isTTY: false }));
    const parsed = JSON.parse(outputs.join(''));
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('MISSING_PARAM');
    expect(parsed.error).toContain('Usage: nansen bridge quote');
  });

  it('keeps the JSON envelope on a TTY when --pretty is requested', async () => {
    await runCLI(['bridge', 'quote', '--pretty'], deps({ isTTY: true }));
    const parsed = JSON.parse(outputs.join(''));
    expect(parsed.code).toBe('MISSING_PARAM');
  });

  // The regression reached well beyond the new commands — this is the case from
  // the review, on a command that predates them.
  it('prints the trade quote banner as readable text on a TTY', async () => {
    await runCLI(['trade', 'quote'], deps({ isTTY: true }));
    const text = outputs.join('\n');
    expect(text).not.toMatch(/^\{/);
    expect(text).not.toContain('\\n');
    expect(text).toContain('Usage: nansen trade quote');
  });

  it('leaves non-usage failures as an envelope on a TTY', async () => {
    // An unsupported route is a validation failure, not a usage banner.
    await runCLI(
      ['bridge', 'quote', '--from-chain', 'polygon', '--to-chain', 'hyperliquid',
        '--from-token', 'USDC', '--amount', '5'],
      deps({ isTTY: true }),
    );
    const parsed = JSON.parse(outputs.join(''));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Unsupported bridge route');
  });
});
