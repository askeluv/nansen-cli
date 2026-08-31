/**
 * Tests for Privy server wallet integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PrivyClient, createPrivyPaymentSignatures } from "../privy.js";

// ============= PrivyClient =============

describe("PrivyClient", () => {
  it("throws if credentials are missing", () => {
    expect(() => new PrivyClient(null, null)).toThrow("Privy credentials required");
    expect(() => new PrivyClient("app-id", null)).toThrow("Privy credentials required");
    expect(() => new PrivyClient(null, "secret")).toThrow("Privy credentials required");
  });

  it("constructs with valid credentials", () => {
    const client = new PrivyClient("app-id", "app-secret");
    expect(client.appId).toBe("app-id");
    expect(client.appSecret).toBe("app-secret");
  });

  it("sends correct auth headers", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.listWallets();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.privy.io/v1/wallets");
    expect(opts.headers.Authorization).toBe(
      `Basic ${Buffer.from("app-id:app-secret").toString("base64")}`
    );
    expect(opts.headers["privy-app-id"]).toBe("app-id");
    // Credentialed request must refuse redirects rather than relay Basic auth /
    // privy-app-id to a redirect target.
    expect(opts.redirect).toBe("error");

    vi.unstubAllGlobals();
  });

  it("throws on API error with message", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: "Invalid chain_type" }),
    }));

    await expect(client.createWallet("invalid")).rejects.toThrow("Invalid chain_type");

    vi.unstubAllGlobals();
  });

  it("converts a redirect rejection (redirect: 'error') into an actionable message", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    // undici throws a bare TypeError('fetch failed') when redirect:'error' hits a 3xx.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const err = await client.listWallets().catch((e) => e);
    expect(err.message).toMatch(/Privy API request failed/);
    expect(err.message).toContain("GET /wallets");
    expect(err.message).not.toBe("fetch failed"); // not the undecorated TypeError

    vi.unstubAllGlobals();
  });

  it("createWallet sends correct body", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "w-123", address: "0xabc", chain_type: "ethereum" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.createWallet("ethereum");
    expect(result.id).toBe("w-123");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ chain_type: "ethereum" });

    vi.unstubAllGlobals();
  });

  it("sendTransaction sends correct RPC body", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hash: "0xdef" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.sendTransaction("w-123", {
      to: "0xrecipient",
      value: "1000",
      chainId: 8453,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("eth_sendTransaction");
    expect(body.caip2).toBe("eip155:8453");
    expect(body.params.transaction.to).toBe("0xrecipient");

    vi.unstubAllGlobals();
  });

  it("ethSignTypedDataV4 converts primaryType to primary_type", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { signature: "0xsig" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const typedData = { types: {}, primaryType: "Test", domain: {}, message: {} };
    const result = await client.ethSignTypedDataV4("w-123", typedData);
    expect(result.data.signature).toBe("0xsig");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("eth_signTypedData_v4");
    // Should have converted primaryType to primary_type
    expect(body.params.typed_data.primary_type).toBe("Test");
    expect(body.params.typed_data.primaryType).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("signEvmTransaction sends correct RPC request", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { signed_transaction: "0xsigned" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.signEvmTransaction("wl_123", {
      to: "0xRecipient",
      value: "0x0",
      data: "0xCalldata",
      chain_id: 8453,
      nonce: 5,
      gas_limit: "210000",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.privy.io/v1/wallets/wl_123/rpc");
    const body = JSON.parse(opts.body);
    expect(body.method).toBe("eth_signTransaction");
    expect(body.params.transaction.to).toBe("0xRecipient");
    expect(body.params.transaction.chain_id).toBe(8453);
    expect(body.params.transaction.nonce).toBe(5);
    expect(body.params.transaction.gas_limit).toBe("210000");
    expect(result.data.signed_transaction).toBe("0xsigned");

    vi.unstubAllGlobals();
  });

  it("signSolanaTransaction sends correct RPC request with chain_type", async () => {
    const client = new PrivyClient("app-id", "app-secret");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { signed_transaction: "c2lnbmVk" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.signSolanaTransaction("wl_456", "dW5zaWduZWQ=");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.privy.io/v1/wallets/wl_456/rpc");
    const body = JSON.parse(opts.body);
    expect(body.method).toBe("signTransaction");
    expect(body.chain_type).toBe("solana");
    expect(body.params.transaction).toBe("dW5zaWduZWQ=");
    expect(body.params.encoding).toBe("base64");
    expect(result.data.signed_transaction).toBe("c2lnbmVk");

    vi.unstubAllGlobals();
  });

});

// ============= createPrivyPaymentSignatures =============

describe("createPrivyPaymentSignatures", () => {
  let originalEnv;
  let tempDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nansen-privy-x402-"));
    process.env.HOME = tempDir;
    process.env.PRIVY_APP_ID = "test-app-id";
    process.env.PRIVY_APP_SECRET = "test-app-secret";
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function make402Response(requirements) {
    const encoded = btoa(JSON.stringify({ accepts: requirements }));
    return {
      headers: new Headers({ "payment-required": encoded }),
    };
  }

  const evmRequirement = {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xrecipient",
    amount: "50000",
    maxTimeoutSeconds: 120,
    extra: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      decimals: 6,
      symbol: "USDC",
    },
  };

  it("yields nothing if no requirements", async () => {
    const response = { headers: new Headers() };
    const results = [];
    for await (const r of createPrivyPaymentSignatures(response, "https://api.nansen.ai/test")) {
      results.push(r);
    }
    expect(results).toHaveLength(0);
  });

  it("yields a signature for Solana requirement", async () => {
    const solRequirement = {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi",
      amount: "50000",
      extra: { feePayer: "11111111111111111111111111111111" },
    };

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url) => {
      // Solana RPC (fetchRecentBlockhash) - mainnet-beta URL
      if (typeof url === "string" && url.includes("mainnet-beta")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            jsonrpc: "2.0",
            result: { value: { blockhash: "GHtXQBpokCUCJwhRAJbhGVPKp9VTVn65CWVRqFMJkFwh" } },
          }),
        });
      }
      // Privy: listWallets
      if (typeof url === "string" && url.includes("/wallets") && !url.includes("/rpc")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ id: "wl_sol_1", address: "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi", chain_type: "solana" }],
          }),
        });
      }
      // Privy: signSolanaTransaction
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { signed_transaction: "c2lnbmVkdHhiYXNlNjQ=" },
        }),
      });
    }));

    const response = make402Response([solRequirement]);
    const results = [];
    for await (const r of createPrivyPaymentSignatures(response, "https://api.nansen.ai/test")) {
      results.push(r);
    }

    expect(results).toHaveLength(1);
    expect(results[0].network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    const decoded = JSON.parse(atob(results[0].signature));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload.transaction).toBe("c2lnbmVkdHhiYXNlNjQ=");
    expect(decoded.resource.url).toBe("https://api.nansen.ai/test");
  });

  it("yields a signature for EVM requirement", async () => {
    // Mock fetch: first call = listWallets, second call = signTypedData
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // listWallets
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ id: "w-1", address: "0x1234567890abcdef1234567890abcdef12345678", chain_type: "ethereum" }],
          }),
        });
      }
      // signTypedData
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { signature: "0xfakesignature" } }),
      });
    }));

    const response = make402Response([evmRequirement]);
    const results = [];
    for await (const r of createPrivyPaymentSignatures(response, "https://api.nansen.ai/test")) {
      results.push(r);
    }

    expect(results).toHaveLength(1);
    expect(results[0].network).toBe("eip155:8453");
    // signature should be a base64-encoded JSON string
    const decoded = JSON.parse(atob(results[0].signature));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload.signature).toBe("0xfakesignature");
  });

  it("uses PRIVY_WALLET_ID when set", async () => {
    process.env.PRIVY_WALLET_ID = "w-specific";

    let fetchCalls = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url) => {
      fetchCalls.push(url);
      if (url.includes("/wallets/w-specific") && !url.includes("/rpc")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "w-specific", address: "0xabcdef1234567890abcdef1234567890abcdef12", chain_type: "ethereum" }),
        });
      }
      // signTypedData
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { signature: "0xsig" } }),
      });
    }));

    const response = make402Response([evmRequirement]);
    const results = [];
    for await (const r of createPrivyPaymentSignatures(response, "https://api.nansen.ai/test")) {
      results.push(r);
    }

    expect(results).toHaveLength(1);
    // Should have called getWallet (not listWallets)
    expect(fetchCalls[0]).toContain("/wallets/w-specific");
  });

  it("continues to next requirement on signing failure", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // listWallets
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ id: "w-1", address: "0x1234567890abcdef1234567890abcdef12345678", chain_type: "ethereum" }],
          }),
        });
      }
      if (callCount === 2) {
        // first sign attempt fails
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ message: "signing failed" }),
        });
      }
      // second sign attempt succeeds
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { signature: "0xgoodsig" } }),
      });
    }));

    const req2 = { ...evmRequirement, network: "eip155:1" };
    const response = make402Response([evmRequirement, req2]);
    const results = [];
    for await (const r of createPrivyPaymentSignatures(response, "https://api.nansen.ai/test")) {
      results.push(r);
    }

    // First failed, second succeeded
    expect(results).toHaveLength(1);
    expect(results[0].network).toBe("eip155:1");
  });
});

// ============= wallet.js provider guard =============

describe("wallet provider guard", () => {
  let originalEnv;
  let tempDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nansen-privy-guard-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("routes create to Privy when --provider privy is set", async () => {
    process.env.PRIVY_APP_ID = "test-id";
    process.env.PRIVY_APP_SECRET = "test-secret";

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "wl_evm_1", address: "0xEvmAddr", chain_type: "ethereum" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "wl_sol_1", address: "SolAddr", chain_type: "solana" }),
      });
    }));

    const { buildWalletCommands } = await import("../wallet.js");
    const logs = [];
    const commands = buildWalletCommands({
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
    });

    await commands.wallet(["create"], null, {}, { provider: "privy", name: "test-privy" });
    const output = logs.join("\n");
    expect(output).toContain("Privy wallet");
    expect(output).toContain("0xEvmAddr");
  });

  it("routes create to Privy when NANSEN_WALLET_PROVIDER=privy", async () => {
    process.env.NANSEN_WALLET_PROVIDER = "privy";
    process.env.PRIVY_APP_ID = "test-id";
    process.env.PRIVY_APP_SECRET = "test-secret";

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "wl_evm_1", address: "0xEvmAddr", chain_type: "ethereum" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "wl_sol_1", address: "SolAddr", chain_type: "solana" }),
      });
    }));

    const { buildWalletCommands } = await import("../wallet.js");
    const logs = [];
    const commands = buildWalletCommands({
      log: (msg) => logs.push(msg),
      exit: vi.fn(),
    });

    await commands.wallet(["create"], null, {}, { name: "test-privy-env" });
    const output = logs.join("\n");
    expect(output).toContain("Privy wallet");
  });
});
