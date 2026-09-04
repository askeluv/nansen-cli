/**
 * `--neg-risk true|false` reaches the API with the matching boolean.
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

  it('leaves negRisk undefined when the flag is absent', async () => {
    const api = await run(['market-screener']);
    expect(api.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: undefined }));
  });

  it('applies to the event screener too', async () => {
    const api = await run(['event-screener', '--neg-risk', 'true']);
    expect(api.pmEventScreener).toHaveBeenCalledWith(expect.objectContaining({ negRisk: true }));
  });
});
