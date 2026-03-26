/**
 * End-to-end swap tests — runs the actual CLI against mainnet.
 *
 * Prerequisites:
 *   - A wallet in ~/.nansen/wallets/ with at least 0.001 ETH on Base and SOL on Solana
 *   - NANSEN_WALLET_PASSWORD env var set
 *
 * Run: npm run test:trade
 *
 * These tests execute REAL swaps with REAL funds. They are excluded
 * from the default test suite and must be run explicitly.
 *
 * Same-chain tests round-trip native → USDC → native. Cross-chain tests
 * round-trip ETH (Base) → SOL (Solana) → ETH (Base).
 * Net cost is gas + slippage + bridge fees.
 */

import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import path from 'path';

const CLI_PATH = path.resolve('src/index.js');

/**
 * Run the CLI and return { stdout, stderr, exitCode }.
 * Captures both stdout and stderr regardless of exit code.
 */
function runCli(...args) {
  const opts = typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) ? args.pop() : {};
  const { stdout, stderr, status } = spawnSync('node', [CLI_PATH, ...args], {
    env: process.env,
    encoding: 'utf8',
    timeout: opts.timeout || 120_000,
  });
  return { stdout: stdout || '', stderr: stderr || '', exitCode: status ?? 1 };
}

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SWAP_AMOUNT_ETH = '270000000000000'; // ~$0.50 ETH (18 decimals)

describe.sequential('e2e: ETH ↔ USDC swap round-trip on Base', () => {
  const state = {
    forwardQuoteId: null,
    forwardTxHash: null,
    reverseQuoteId: null,
    reverseTxHash: null,
    receivedUsdcAmount: null,
  };

  it('should have a wallet configured', () => {
    const result = runCli('wallet', 'list');
    const output = result.stdout + result.stderr;
    expect(output).toContain('EVM:');
  });

  it('quote ETH → USDC on Base', () => {
    const result = runCli(
      'trade', 'quote',
      '--chain', 'base',
      '--from', BASE_ETH,
      '--to', BASE_USDC,
      '--amount', SWAP_AMOUNT_ETH,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.forwardQuoteId = quoteMatch[1];
  });

  it('execute ETH → USDC swap', () => {
    expect(state.forwardQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.forwardQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    state.forwardTxHash = txMatch[1];
    console.log(`Forward swap: https://basescan.org/tx/${state.forwardTxHash}`);

    // Extract received USDC amount for the reverse swap (format: "Output:       500000 → 0x8335...")
    const swapMatch = output.match(/Output:\s+(\d+)\s+→/);
    expect(swapMatch, `Expected Output amount in output:\n${output}`).toBeTruthy();
    state.receivedUsdcAmount = swapMatch[1];
  });

  it('quote USDC → ETH on Base (reverse)', () => {
    expect(state.receivedUsdcAmount, 'Forward swap must capture USDC amount').toBeTruthy();

    const result = runCli(
      'trade', 'quote',
      '--chain', 'base',
      '--from', BASE_USDC,
      '--to', BASE_ETH,
      '--amount', state.receivedUsdcAmount,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.reverseQuoteId = quoteMatch[1];
  });

  it('execute USDC → ETH swap (reverse)', () => {
    expect(state.reverseQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.reverseQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    state.reverseTxHash = txMatch[1];
    console.log(`Reverse swap: https://basescan.org/tx/${state.reverseTxHash}`);
  });
});

// ============= Cross-chain: ETH (Base) → SOL (Solana) → ETH (Base) =============

// Bridge execute polls for up to 10 min; give the spawn an extra minute of headroom.
const BRIDGE_SPAWN_TIMEOUT = 660_000;
// Vitest per-test timeout: spawn timeout + 30s buffer for quote/setup.
const BRIDGE_TEST_TIMEOUT = 690_000;
// Forward: 0.0008 ETH — assumes ~0.001 ETH starting balance, leaves ~0.0002 ETH for gas on the return bridge.
const CROSS_CHAIN_ETH_AMOUNT = '800000000000000';
// Reserve 0.008 SOL: covers the SOL↔USDC test swap (2,000,000 lamports) + fees
// for both swaps (~1,000,000 lamports) + buffer. The SOL↔USDC suite runs after
// this cross-chain suite, so the reserve must be large enough for it to execute.
const SOL_GAS_RESERVE = 8_000_000n;
// Solana RPC for balance queries.
const SOLANA_RPC = process.env.NANSEN_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

/** Query SPL token balance (in native units) for a wallet + mint. Returns 0n if no account found. */
async function getSplBalance(walletAddress, mintAddress, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getTokenAccountsByOwner',
          params: [walletAddress, { mint: mintAddress }, { encoding: 'jsonParsed' }],
          id: 1,
        }),
      });
      const { result } = await res.json();
      if (!result.value.length) return 0n;
      return BigInt(result.value[0].account.data.parsed.info.tokenAmount.amount);
    } catch {
      if (i === retries - 1) return 0n;
      await new Promise(r => setTimeout(r, 2_000));
    }
  }
}

/** Query native SOL balance (in lamports) for a Solana address. Retries on transient failures. */
async function getSolBalance(address, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'getBalance', params: [address], id: 1 }),
      });
      const { result } = await res.json();
      return BigInt(result.value);
    } catch {
      if (i === retries - 1) throw new Error(`Failed to query SOL balance after ${retries} attempts`);
      await new Promise(r => setTimeout(r, 2_000));
    }
  }
}

/**
 * Poll SOL balance until it exceeds `minBalance`, meaning the bridge has
 * delivered. Returns the new balance. Times out after `timeoutMs`.
 */
async function waitForSolDeposit(address, minBalance, { timeoutMs = 600_000, pollMs = 5_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const balance = await getSolBalance(address);
    if (balance > minBalance) return balance;
    await new Promise(r => setTimeout(r, pollMs));
  }
  // Timed out — return whatever is there now.
  return getSolBalance(address);
}

describe.sequential('e2e: cross-chain ETH (Base) ↔ SOL (Solana) round-trip', () => {
  const state = {
    solanaAddress: null,
    solBalanceBefore: 0n,
    forwardQuoteId: null,
    forwardTxHash: null,
    reverseQuoteId: null,
    reverseTxHash: null,
  };

  it('should have a wallet with both EVM and Solana addresses', () => {
    const result = runCli('wallet', 'list');
    const output = result.stdout + result.stderr;
    expect(output).toContain('EVM:');
    expect(output).toContain('Solana:');
    const solMatch = output.match(/Solana:\s+([1-9A-HJ-NP-Za-km-z]+)/);
    expect(solMatch, `Expected Solana address in output:\n${output}`).toBeTruthy();
    state.solanaAddress = solMatch[1];
  });

  it('snapshot SOL balance before forward swap', async () => {
    state.solBalanceBefore = await getSolBalance(state.solanaAddress);
    console.log(`SOL balance before: ${state.solBalanceBefore} lamports`);
  });

  it('quote ETH → SOL (Base → Solana)', () => {
    const result = runCli(
      'trade', 'quote',
      '--chain', 'base',
      '--to-chain', 'solana',
      '--from', 'ETH',
      '--to', 'SOL',
      '--amount', CROSS_CHAIN_ETH_AMOUNT,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('cross-chain quote');
    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.forwardQuoteId = quoteMatch[1];
  });

  it('execute ETH → SOL (Base → Solana)', () => {
    expect(state.forwardQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.forwardQuoteId,
      { timeout: BRIDGE_SPAWN_TIMEOUT },
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    state.forwardTxHash = txMatch[1];
    console.log(`Forward (Base→Solana): https://basescan.org/tx/${state.forwardTxHash}`);

    // Bridge polling is best-effort — log outcome but don't fail the test.
    // The bridge status API can be flaky (502s) or the bridge may still be
    // in progress after the polling window.
    if (output.includes('Bridge completed')) {
      console.log('Bridge completed successfully');
    } else {
      console.log('Bridge status inconclusive — check manually');
    }
  }, BRIDGE_TEST_TIMEOUT);

  it('quote SOL → ETH (Solana → Base)', async () => {
    expect(state.forwardTxHash, 'Forward bridge must have completed').toBeTruthy();

    // Wait for the bridge to deliver SOL (balance must exceed pre-swap snapshot).
    console.log('Waiting for bridged SOL to arrive...');
    const balance = await waitForSolDeposit(state.solanaAddress, state.solBalanceBefore);
    const swapAmount = balance - SOL_GAS_RESERVE;
    expect(swapAmount > 0n, `SOL balance too low to swap back: ${balance} lamports`).toBe(true);
    console.log(`SOL balance: ${balance} lamports, swapping ${swapAmount}`);

    const result = runCli(
      'trade', 'quote',
      '--chain', 'solana',
      '--to-chain', 'base',
      '--from', 'SOL',
      '--to', 'ETH',
      '--amount', swapAmount.toString(),
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('cross-chain quote');
    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.reverseQuoteId = quoteMatch[1];
  }, BRIDGE_TEST_TIMEOUT);

  it('execute SOL → ETH (Solana → Base)', () => {
    expect(state.reverseQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.reverseQuoteId,
      { timeout: BRIDGE_SPAWN_TIMEOUT },
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const sigMatch = output.match(/Signature:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Signature in output:\n${output}`).toBeTruthy();
    state.reverseTxHash = sigMatch[1];
    console.log(`Reverse (Solana→Base): https://solscan.io/tx/${state.reverseTxHash}`);

    if (output.includes('Bridge completed')) {
      console.log('Reverse bridge completed successfully');
    } else {
      console.log('Reverse bridge status inconclusive — check manually');
    }
  }, BRIDGE_TEST_TIMEOUT);

});

// ============= Same-chain swaps =============

const SOL_NATIVE = 'So11111111111111111111111111111111111111112';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SWAP_AMOUNT_SOL = '2000000'; // 0.002 SOL (~$0.17, 9 decimals)

describe.sequential('e2e: SOL ↔ USDC swap round-trip on Solana', () => {
  const state = {
    solanaAddress: null,
    forwardQuoteId: null,
    forwardSignature: null,
    reverseQuoteId: null,
    reverseSignature: null,
    receivedUsdcAmount: null,
  };

  it('should have a wallet with Solana address', () => {
    const result = runCli('wallet', 'list');
    const output = result.stdout + result.stderr;
    expect(output).toContain('Solana:');
    const solMatch = output.match(/Solana:\s+([1-9A-HJ-NP-Za-km-z]+)/);
    expect(solMatch, `Expected Solana address in output:\n${output}`).toBeTruthy();
    state.solanaAddress = solMatch[1];
  });

  it('quote SOL → USDC on Solana', () => {
    const result = runCli(
      'trade', 'quote',
      '--chain', 'solana',
      '--from', SOL_NATIVE,
      '--to', SOL_USDC,
      '--amount', SWAP_AMOUNT_SOL,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.forwardQuoteId = quoteMatch[1];
  });

  it('execute SOL → USDC swap', async () => {
    expect(state.forwardQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.forwardQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    // Solana tx signatures are base58 strings (typically 87-88 chars)
    const sigMatch = output.match(/Signature:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Signature in output:\n${output}`).toBeTruthy();
    state.forwardSignature = sigMatch[1];
    console.log(`Forward swap: https://solscan.io/tx/${state.forwardSignature}`);

    // Use actual on-chain USDC balance rather than the quoted output amount.
    // The quoted amount may differ from the actual received amount due to slippage,
    // which would cause OKX's simulation to fail with InsufficientFunds (0x1).
    const actualBalance = await getSplBalance(state.solanaAddress, SOL_USDC);
    expect(actualBalance > 0n, `Expected USDC balance > 0 after forward swap`).toBe(true);
    state.receivedUsdcAmount = actualBalance.toString();
    console.log(`Actual USDC balance: ${state.receivedUsdcAmount}`);
  });

  it('quote USDC → SOL on Solana (reverse)', () => {
    expect(state.receivedUsdcAmount, 'Forward swap must capture USDC amount').toBeTruthy();

    const result = runCli(
      'trade', 'quote',
      '--chain', 'solana',
      '--from', SOL_USDC,
      '--to', SOL_NATIVE,
      '--amount', state.receivedUsdcAmount,
    );
    const output = result.stdout + result.stderr;

    const quoteMatch = output.match(/Quote ID:\s+(\S+)/);
    expect(quoteMatch, `Expected Quote ID in output:\n${output}`).toBeTruthy();
    state.reverseQuoteId = quoteMatch[1];
  });

  it('execute USDC → SOL swap (reverse)', () => {
    expect(state.reverseQuoteId).toBeTruthy();

    const result = runCli(
      'trade', 'execute',
      '--quote', state.reverseQuoteId,
    );
    const output = result.stdout + result.stderr;

    expect(output).toContain('Transaction successful');

    const sigMatch = output.match(/Signature:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Signature in output:\n${output}`).toBeTruthy();
    state.reverseSignature = sigMatch[1];
    console.log(`Reverse swap: https://solscan.io/tx/${state.reverseSignature}`);
  });
});
