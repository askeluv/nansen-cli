/**
 * Tests for src/hl-client.js — the single direct-to-HL /exchange submit.
 *
 * Uses an injected fetch (the `fetchImpl` option) so no network is touched.
 * Covers the two failure modes the backend proxy used to catch and now must be
 * caught client-side: a top-level status "err", and a status "ok" that still
 * carries a per-action error in response.data.statuses[].error.
 */

import { describe, it, expect, vi } from "vitest";
import {
  submitExchange,
  extractActionErrors,
  hlApiUrl,
  HL_MAINNET_API_URL,
} from "../hl-client.js";

// Build a fake fetch that returns one response. `ok` defaults to true.
function fakeFetch(bodyObj, { ok = true, status = 200, nonJson = false } = {}) {
  const text = nonJson
    ? "<html>gateway timeout</html>"
    : JSON.stringify(bodyObj);
  return vi.fn(async () => ({ ok, status, text: async () => text }));
}

const OK_FILL = {
  status: "ok",
  response: {
    type: "order",
    data: {
      statuses: [{ filled: { oid: 123, totalSz: "0.01", avgPx: "1850.7" } }],
    },
  },
};

const SIGNED = {
  action: { type: "order", orders: [], grouping: "na" },
  nonce: 1784805814604,
  signature: { r: "0x01", s: "0x02", v: 27 },
};

describe("submitExchange", () => {
  it("POSTs to <base>/exchange with the signed body and returns the parsed response on ok", async () => {
    const fetchImpl = fakeFetch(OK_FILL);
    const result = await submitExchange(SIGNED, {
      fetchImpl,
      baseUrl: "https://hl.test",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hl.test/exchange");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const sent = JSON.parse(opts.body);
    expect(sent).toEqual({
      action: SIGNED.action,
      nonce: SIGNED.nonce,
      signature: SIGNED.signature,
    });
    expect(result).toEqual(OK_FILL);
  });

  it("omits vaultAddress when null but includes it when set", async () => {
    const f1 = fakeFetch(OK_FILL);
    await submitExchange(SIGNED, { fetchImpl: f1, baseUrl: "https://hl.test" });
    expect("vaultAddress" in JSON.parse(f1.mock.calls[0][1].body)).toBe(false);

    const f2 = fakeFetch(OK_FILL);
    await submitExchange(
      { ...SIGNED, vaultAddress: "0xabc" },
      { fetchImpl: f2, baseUrl: "https://hl.test" }
    );
    expect(JSON.parse(f2.mock.calls[0][1].body).vaultAddress).toBe("0xabc");
  });

  it('throws on a top-level status "err" and surfaces the reason', async () => {
    const fetchImpl = fakeFetch({
      status: "err",
      response: "Insufficient margin",
    });
    await expect(
      submitExchange(SIGNED, { fetchImpl, baseUrl: "https://hl.test" })
    ).rejects.toMatchObject({
      code: "HL_ACTION_REJECTED",
      message: expect.stringContaining("Insufficient margin"),
    });
  });

  it('throws on a per-action error even when top-level status is "ok"', async () => {
    const fetchImpl = fakeFetch({
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [
            {
              error:
                "Order price cannot be more than 95% away from the reference price",
            },
          ],
        },
      },
    });
    await expect(
      submitExchange(SIGNED, { fetchImpl, baseUrl: "https://hl.test" })
    ).rejects.toMatchObject({
      code: "HL_ACTION_REJECTED",
      message: expect.stringContaining("95% away"),
    });
  });

  it("throws HL_HTTP_ERROR on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(
      { error: "rate limited" },
      { ok: false, status: 429 }
    );
    await expect(
      submitExchange(SIGNED, { fetchImpl, baseUrl: "https://hl.test" })
    ).rejects.toMatchObject({
      code: "HL_HTTP_ERROR",
      message: expect.stringContaining("429"),
    });
  });

  it("throws HL_BAD_RESPONSE on a non-JSON body", async () => {
    const fetchImpl = fakeFetch(null, { nonJson: true, status: 504 });
    await expect(
      submitExchange(SIGNED, { fetchImpl, baseUrl: "https://hl.test" })
    ).rejects.toMatchObject({
      code: "HL_BAD_RESPONSE",
    });
  });

  it("wraps a network error as HL_NETWORK_ERROR and does not retry", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      submitExchange(SIGNED, { fetchImpl, baseUrl: "https://hl.test" })
    ).rejects.toMatchObject({
      code: "HL_NETWORK_ERROR",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("extractActionErrors", () => {
  it("returns [] for shapes without statuses", () => {
    expect(extractActionErrors(null)).toEqual([]);
    expect(extractActionErrors("a string")).toEqual([]);
    expect(extractActionErrors({ data: {} })).toEqual([]);
    expect(extractActionErrors({ data: { statuses: "nope" } })).toEqual([]);
  });
  it("collects every per-action error, ignoring filled entries", () => {
    expect(
      extractActionErrors({
        data: { statuses: [{ filled: {} }, { error: "e1" }, { error: "e2" }] },
      })
    ).toEqual(["e1", "e2"]);
  });
});

describe("hlApiUrl", () => {
  it("defaults to mainnet and honours NANSEN_HL_API_URL", () => {
    const prev = process.env.NANSEN_HL_API_URL;
    delete process.env.NANSEN_HL_API_URL;
    expect(hlApiUrl()).toBe(HL_MAINNET_API_URL);
    process.env.NANSEN_HL_API_URL = "https://api.hyperliquid-testnet.xyz";
    expect(hlApiUrl()).toBe("https://api.hyperliquid-testnet.xyz");
    if (prev === undefined) delete process.env.NANSEN_HL_API_URL;
    else process.env.NANSEN_HL_API_URL = prev;
  });
});
