/**
 * Solana swap-outcome simulation: run a swap transaction through
 * `simulateTransaction` and report the resulting balance changes to the
 * signer's wallet.
 *
 * This is the Solana sibling of swap-simulation.js. Solana signs the
 * aggregator's serialized transaction verbatim, so this is the only check that
 * confirms the wallet actually comes out the way the quote promised — the
 * static checks in trade-validation.js inspect the instructions themselves,
 * not their effect. All delta math runs here, client-side, from the raw
 * `accounts` snapshot the RPC returns, so the verification stays independent
 * of the service that built the quote.
 *
 * Unlike the EVM simulation endpoint, `simulateTransaction` (with `accounts` +
 * `replaceRecentBlockhash`) is a standard public-RPC method — no trace RPC, no
 * Nansen-hosted proxy. It is always called anonymously (see SIMULATION_RPCS.solana
 * in rpc-urls.js); the Nansen API key is never attached here.
 */

import { SIMULATION_RPCS } from './rpc-urls.js';
import { parseTransactionMessage } from './solana-tx.js';
import { base58Encode } from './wallet.js';

// Mirrors NATIVE_SOL_SYSTEM_MINT in trading.js / SOLANA_NATIVE_SOL_ALIASES in
// trade-validation.js (duplicated, not imported, to avoid a circular import —
// both of those modules will import from this one).
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_SENTINEL = '11111111111111111111111111111111';

function isSolanaNativeMint(mint) {
  return mint === WSOL_MINT || mint === SOL_SENTINEL;
}

// getMultipleAccounts caps at 100 keys per call; batch defensively even though
// a real swap's writable-account set is well under this.
const MAX_ACCOUNTS_PER_CALL = 100;

/**
 * A simulation error the caller can distinguish from a genuine outcome mismatch.
 * `code` is one of:
 *   NO_SIM_RPC             - no simulation endpoint configured for the chain
 *   SIM_RPC_ERROR           - transport/parse failure talking to the endpoint
 *   SIM_REVERTED            - the transaction itself reverted in simulation
 *   SIM_RESULT_UNPARSEABLE  - the sim ran, but a tracked balance or lookup
 *                             table couldn't be resolved/parsed
 * NO_SIM_RPC and SIM_RPC_ERROR are degrade conditions (warn, proceed per
 * policy); the caller decides. SIM_REVERTED and SIM_RESULT_UNPARSEABLE are
 * outcome/parse problems and must not be silently ignored — fail closed.
 */
export class SolanaSimulationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SolanaSimulationError';
    this.code = code;
  }
}

/** Whether a sim-capable endpoint is configured for this chain. */
export function hasSolanaSimulationRpc(chain) {
  return chain === 'solana' && Boolean(SIMULATION_RPCS.solana);
}

async function rpcCall(rpcUrl, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SolanaSimulationError(
        'SIM_RPC_ERROR',
        `Simulation RPC returned non-JSON (HTTP ${res.status}) for ${method}: ${text.slice(0, 120)}`,
      );
    }
    const ok = res.ok ?? (res.status >= 200 && res.status < 300);
    if (!ok) {
      const detail = body?.error?.message || text.slice(0, 120);
      throw new SolanaSimulationError('SIM_RPC_ERROR', `Simulation RPC HTTP ${res.status} for ${method}: ${detail}`);
    }
    if (body.error) {
      throw new SolanaSimulationError('SIM_RPC_ERROR', `${method} error: ${body.error.message || JSON.stringify(body.error)}`);
    }
    return body.result;
  } catch (e) {
    if (e instanceof SolanaSimulationError) throw e;
    if (e.name === 'AbortError') {
      throw new SolanaSimulationError('SIM_RPC_ERROR', `Simulation RPC timed out after ${timeoutMs}ms (${method})`);
    }
    throw new SolanaSimulationError('SIM_RPC_ERROR', `Simulation RPC request failed (${method}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getMultipleAccountsChunked(rpcUrl, pubkeys, encoding, timeoutMs) {
  if (!pubkeys.length) return [];
  const out = [];
  for (let i = 0; i < pubkeys.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = pubkeys.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const result = await rpcCall(rpcUrl, 'getMultipleAccounts', [chunk, { encoding }], timeoutMs);
    out.push(...(result?.value ?? []));
  }
  return out;
}

/**
 * A static account index is writable unless it's a readonly signer or one of
 * the trailing readonly non-signers. Mirrors the header layout parsed by
 * parseTransactionMessage (solana-tx.js).
 */
function isStaticWritable(parsed, index) {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = parsed.header;
  const numStatic = parsed.staticAccountKeys.length;
  if (index < numRequiredSignatures) {
    return index < numRequiredSignatures - numReadonlySignedAccounts;
  }
  return index < numStatic - numReadonlyUnsignedAccounts;
}

/**
 * Resolve only the WRITABLE accounts a v0 transaction references through
 * address-lookup-tables. A readonly ALT account can never change balance, so
 * it's irrelevant to the drain-surface check below — resolving only the
 * writable indexes saves decoding entries this check will never use.
 */
async function resolveAltWritableAccounts(rpcUrl, parsed, timeoutMs) {
  if (!parsed.addressTableLookups.length) return [];
  const tableAddresses = parsed.addressTableLookups.map((l) => l.lookupTableAddress);
  const tableInfos = await getMultipleAccountsChunked(rpcUrl, tableAddresses, 'base64', timeoutMs);

  const resolved = [];
  parsed.addressTableLookups.forEach((lookup, i) => {
    const info = tableInfos[i];
    if (!info) {
      throw new SolanaSimulationError(
        'SIM_RESULT_UNPARSEABLE',
        `Address lookup table ${lookup.lookupTableAddress} not found; cannot resolve its accounts.`,
      );
    }
    // LookupTableMeta: typeIndex u32, deactivationSlot u64, lastExtendedSlot u64,
    // lastExtendedSlotStartIndex u8, authority Option<Pubkey>, padding — 32-byte
    // pubkeys begin at byte offset 56.
    const raw = Array.isArray(info.data) ? info.data[0] : info.data;
    const buf = Buffer.from(raw, 'base64');
    for (const idx of lookup.writableIndexes) {
      const offset = 56 + idx * 32;
      if (offset + 32 > buf.length) {
        throw new SolanaSimulationError(
          'SIM_RESULT_UNPARSEABLE',
          `Address lookup table ${lookup.lookupTableAddress} has no entry at index ${idx}.`,
        );
      }
      resolved.push(base58Encode(buf.subarray(offset, offset + 32)));
    }
  });
  return resolved;
}

/** Lamports (native) or SPL token base-unit balance from a jsonParsed account. */
function extractBalance(kind, info) {
  if (!info) return 0n;
  try {
    if (kind === 'native') return BigInt(info.lamports ?? 0);
    const amt = info.data?.parsed?.info?.tokenAmount?.amount;
    return amt != null ? BigInt(amt) : 0n;
  } catch {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', `Could not parse a simulated ${kind} balance.`);
  }
}

/**
 * Simulate a Solana swap transaction and return the normalised asset changes
 * it causes to `walletAddress`'s wallet.
 *
 * @param {string} chain - chain key (only 'solana' is wired today)
 * @param {string} txBase64 - the serialized transaction to simulate, unsigned
 * @param {{ walletAddress: string, timeoutMs?: number }} opts
 * @returns {Promise<{ deltas: Record<string, bigint>, method: string }>}
 *   deltas is keyed by mint address, with native SOL (and any WSOL leg of the
 *   same swap) folded under SOL_SENTINEL.
 * @throws {SolanaSimulationError} on any degrade condition, an in-sim revert,
 *   or an unparseable result.
 */
export async function simulateSolanaAssetChanges(chain, txBase64, { walletAddress, timeoutMs = 20000 } = {}) {
  const rpcUrl = SIMULATION_RPCS[chain];
  if (!rpcUrl) {
    throw new SolanaSimulationError('NO_SIM_RPC', `No simulation RPC configured for chain '${chain}'.`);
  }
  if (!walletAddress) {
    throw new SolanaSimulationError('SIM_RPC_ERROR', 'simulateSolanaAssetChanges requires a `walletAddress`.');
  }

  const parsed = parseTransactionMessage(txBase64);

  const writableKeys = [];
  for (let i = 0; i < parsed.staticAccountKeys.length; i++) {
    if (isStaticWritable(parsed, i)) writableKeys.push(parsed.staticAccountKeys[i]);
  }
  writableKeys.push(...(await resolveAltWritableAccounts(rpcUrl, parsed, timeoutMs)));

  const preAccountInfos = await getMultipleAccountsChunked(rpcUrl, writableKeys, 'jsonParsed', timeoutMs);

  // Track the wallet's own accounts among the writable set — that's the
  // complete drain surface assertSolanaSwapOutcome needs (input/output/sibling).
  // Accounts that don't exist pre-swap are tracked as *candidates*: a first-ever
  // purchase of the output token has the tx create its ATA, so it has no
  // pre-state to read ownership from. We snapshot it post-simulation anyway and
  // classify it from the created account's owner (below); a zero pre-balance
  // makes its whole post-balance the delta. Skipping these would report a 0n
  // output delta and false-block every first-time buy.
  const tracked = []; // { pubkey, preInfo, classified, kind?, mint? }
  let sawWalletAccount = false;
  writableKeys.forEach((pubkey, i) => {
    const info = preAccountInfos[i];
    if (!info) {
      tracked.push({ pubkey, preInfo: null, classified: false });
      return;
    }
    if (pubkey === walletAddress) {
      tracked.push({ pubkey, preInfo: info, classified: true, kind: 'native' });
      sawWalletAccount = true;
      return;
    }
    const parsedInfo = info.data?.parsed;
    if (parsedInfo?.type === 'account' && parsedInfo.info?.owner === walletAddress) {
      tracked.push({ pubkey, preInfo: info, classified: true, kind: 'token', mint: parsedInfo.info.mint });
      sawWalletAccount = true;
    }
  });

  // The wallet's native account is the fee payer, so it always pre-exists and is
  // writable; not seeing it means we couldn't locate the signer's own accounts
  // and can't meaningfully verify the outcome. (Unclassified candidates alone
  // don't count — they may all belong to other parties.)
  if (!sawWalletAccount) {
    throw new SolanaSimulationError(
      'SIM_RESULT_UNPARSEABLE',
      'Could not resolve the signer wallet as a writable account in this transaction; cannot verify the outcome.',
    );
  }

  const simResult = await rpcCall(
    rpcUrl,
    'simulateTransaction',
    [
      txBase64,
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        encoding: 'base64',
        accounts: { addresses: tracked.map((t) => t.pubkey), encoding: 'jsonParsed' },
      },
    ],
    timeoutMs,
  );

  if (simResult?.value?.err != null) {
    throw new SolanaSimulationError('SIM_REVERTED', `Swap reverts in simulation: ${JSON.stringify(simResult.value.err)}`);
  }
  const postAccountInfos = simResult?.value?.accounts;
  if (!Array.isArray(postAccountInfos) || postAccountInfos.length !== tracked.length) {
    throw new SolanaSimulationError('SIM_RESULT_UNPARSEABLE', 'Simulation did not return balance data for the tracked accounts.');
  }

  const deltas = {};
  tracked.forEach((t, i) => {
    const postInfo = postAccountInfos[i];
    let { kind, mint } = t;
    if (!t.classified) {
      // Newly-created account: classify from its post-simulation state and
      // count it only if the tx created it as one of the wallet's own accounts
      // (e.g. the output-token ATA). Anything else is another party's account.
      if (!postInfo) return;
      const parsedInfo = postInfo.data?.parsed;
      if (parsedInfo?.type === 'account' && parsedInfo.info?.owner === walletAddress) {
        kind = 'token';
        mint = parsedInfo.info.mint;
      } else {
        return;
      }
    }
    const pre = extractBalance(kind, t.preInfo); // null preInfo (new account) → 0n
    const post = extractBalance(kind, postInfo);
    const delta = post - pre;
    if (delta === 0n) return;
    const key = kind === 'native' ? SOL_SENTINEL : (isSolanaNativeMint(mint) ? SOL_SENTINEL : mint);
    deltas[key] = (deltas[key] || 0n) + delta;
  });
  for (const k of Object.keys(deltas)) {
    if (deltas[k] === 0n) delete deltas[k];
  }

  return { deltas, method: 'simulateTransaction' };
}
