/**
 * `--neg-risk` reaches the API with the matching boolean, in every form
 * resolveBooleanOption accepts: `--neg-risk`, `--neg-risk true|false`,
 * `--neg-risk 1|0`.
 *
 * parseArgs JSON-parses bare `true`/`false` into booleans, so the handler must
 * not compare the raw option against the string 'true' — that inverted the
 * filter (`--neg-risk true` sent `neg_risk: false`).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCommands, parseArgs } from '../cli.js';

function run(argv) {
  const api = {
    pmMarketScreener: vi.fn(async () => ({ data: [] })),
    pmEventScreener: vi.fn(async () => ({ data: [] })),
  };
  const { _: args, flags, options } = parseArgs(argv);
  // The handler reaches the API through its `apiInstance` argument (the second
  // parameter), not through buildCommands' deps, so the mock is passed there.
  // Empty deps are fine: the prediction-market handler reads none of them.
  return buildCommands({})['prediction-market'](args, api, flags, options).then(() => api);
}

describe('prediction-market --neg-risk', () => {
  it('sends negRisk: true for --neg-risk true', async () => {
    const api = await run(['market-screener', '--neg-risk', 'true']);
    expect(api.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: true }));
  });

  it('sends negRisk: false for --neg-risk false', async () => {
    const api = await run(['market-screener', '--neg-risk', 'false']);
    expect(api.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: false }));
  });

  it('treats a bare --neg-risk as true', async () => {
    const api = await run(['market-screener', '--neg-risk']);
    expect(api.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: true }));
  });

  it('accepts 1 and 0', async () => {
    const on = await run(['market-screener', '--neg-risk', '1']);
    expect(on.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: true }));
    const off = await run(['market-screener', '--neg-risk', '0']);
    expect(off.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: false }));
  });

  it('leaves negRisk undefined when the flag is absent', async () => {
    const api = await run(['market-screener']);
    expect(api.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: undefined }));
  });

  it('applies to the event screener too', async () => {
    const api = await run(['event-screener', '--neg-risk', 'true']);
    expect(api.pmEventScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: true }));
  });
});
