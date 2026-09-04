/**
 * Tests for compareSemver (src/semver.js) — the shared version-comparison
 * implementation used by `nansen changelog --since` (src/cli.js) and the
 * update-notifier's `isNewer` (src/update-check.js).
 */

import { describe, it, expect } from 'vitest';
import { compareSemver } from '../semver.js';

describe('compareSemver', () => {
  it('compares full x.y.z versions numerically, not lexically', () => {
    expect(compareSemver('1.43.1', '1.43.0')).toBe(1);
    expect(compareSemver('1.43.0', '1.43.1')).toBe(-1);
    expect(compareSemver('1.43.0', '1.43.0')).toBe(0);
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1); // numeric, not string, comparison
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  it('treats a missing patch component as .0, not as always-less-than', () => {
    // Regression: comparing a real patch number against `undefined` (from a
    // "1.43"-shaped input with no third component) made every `>` check
    // false in both directions, so a version that matched on major.minor
    // always came out "less than" — even 1.43.1 vs "1.43".
    expect(compareSemver('1.43.1', '1.43')).toBe(1);
    expect(compareSemver('1.43.0', '1.43')).toBe(0);
    expect(compareSemver('1.42.9', '1.43')).toBe(-1);
  });

  it('treats a missing minor and patch component as .0.0', () => {
    expect(compareSemver('2.0.0', '2')).toBe(0);
    expect(compareSemver('2.1.0', '2')).toBe(1);
    expect(compareSemver('1.9.0', '2')).toBe(-1);
  });

  it('ignores a leading "v"', () => {
    expect(compareSemver('v1.43.1', 'v1.43.0')).toBe(1);
  });

  it('is symmetric: swapping arguments negates the result', () => {
    expect(compareSemver('1.43.1', '1.43.0')).toBe(-compareSemver('1.43.0', '1.43.1'));
    // Equal-after-normalization case: both directions must be exactly 0
    // (not +0 vs -0 — `toBe` uses Object.is, so assert each side directly
    // rather than negating one into the other).
    expect(compareSemver('1.43', '1.43.0')).toBe(0);
    expect(compareSemver('1.43.0', '1.43')).toBe(0);
  });

  it('treats both sides missing components consistently (e.g. "2" vs "2.0")', () => {
    expect(compareSemver('2', '2.0')).toBe(0);
    expect(compareSemver('2', '2.0.0')).toBe(0);
  });
});
