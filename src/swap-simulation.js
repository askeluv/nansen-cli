/**
 * Swap-outcome simulation: run a swap transaction through a trace-capable RPC
 * and report the asset changes it would cause to the sender's wallet.
 *
 * This is a defence-in-depth check that complements the static checks in
 * trade-validation.js: instead of only inspecting the swap calldata, it
 * simulates the call so assertSwapOutcome can confirm the resulting balance
 * changes match what the user asked for, failing closed on any mismatch.
 *
 * The endpoint returns the RAW simulation result and all delta math runs here,
 * client-side, so the verification stays independent of the service that built
 * the quote. See src/rpc-urls.js SIMULATION_RPCS for why this needs a separate,
 * trace-capable endpoint.
 *
 * EVM-only: Solana signs the aggregator transaction verbatim and is out of scope.
 */

import { SIMULATION_RPCS, isNansenHostedUrl } from './rpc-urls.js';

// keccak256("Transfer(address,address,uint256)") — shared by ERC-20 and ERC-721.
// ERC-20 indexes (from, to) and carries value in `data` (3 topics); ERC-721 also
// indexes the tokenId (4 topics). We distinguish them by topic count below.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// keccak256("Approval(address,address,uint256)") — shared by ERC-20 and ERC-721.
// ERC-20 indexes (owner, spender) with the value in `data` (3 topics); ERC-721
// also indexes the tokenId (4 topics), granting control of one specific NFT.
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
// keccak256("ApprovalForAll(address,address,bool)") — ERC-721 AND ERC-1155. Grants
// an operator control of the owner's ENTIRE collection; `data` is the bool flag.
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
// keccak256("TransferSingle(address,address,address,uint256,uint256)") — ERC-1155
const ERC1155_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
// keccak256("TransferBatch(address,address,address,uint256[],uint256[])") — ERC-1155
const ERC1155_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

// The CLI's EVM native-asset sentinel (mirrors EVM_NATIVE in trading.js and
// NATIVE_TOKEN_ADDRESSES in trade-validation.js). Native ETH movements surface
// in traces either as synthetic Transfer logs from the zero address
// (eth_simulateV1 traceTransfers) or as call-frame `value` fields (callTracer);
// both are normalised to this sentinel so the caller can compare native deltas
// against a quote's inputMint/outputMint uniformly with ERC-20 deltas.
export const EVM_NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// callTracer frame types that can actually move ETH. STATICCALL forbids value
// and DELEGATECALL runs in the caller's context (its `value` mirrors the parent
// frame rather than being a transfer), so both must be excluded from native
// delta accounting — some nodes populate their `value` field regardless, which
// would otherwise double-count or invent ETH movement.
const ETH_MOVING_FRAME_TYPES = new Set(['CALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);

/**
 * A simulation error the caller can distinguish from a genuine outcome mismatch.
 * `code` is one of:
 *   NO_SIM_RPC        - no simulation endpoint configured for the chain
 *   NOT_SIM_CAPABLE   - endpoint reachable but does not support any trace method
 *   SIM_RPC_ERROR     - transport/parse failure talking to the endpoint
 *   SIM_REVERTED      - the swap call itself reverted in simulation
 * The first three are degrade conditions (warn, proceed per policy); the caller
 * decides. SIM_REVERTED is an outcome problem and should not be silently ignored.
 */
export class SwapSimulationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SwapSimulationError';
    this.code = code;
  }
}

/** Whether a sim-capable endpoint is configured for this chain. */
export function hasSimulationRpc(chain) {
  return Boolean(SIMULATION_RPCS[chain]);
}

/** Last 20 bytes of a 32-byte topic, as a lowercased 0x address. */
function topicToAddress(topic) {
  if (typeof topic !== 'string') return null;
  const hex = topic.replace(/^0x/, '').padStart(64, '0');
  return '0x' + hex.slice(-40).toLowerCase();
}

/** Parse a hex data field as a uint256; returns 0n on anything unparseable. */
function hexToBigInt(hex) {
  if (typeof hex !== 'string' || hex === '0x' || hex === '') return 0n;
  try {
    return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
  } catch {
    return 0n;
  }
}

/** Normalise a token address, mapping the zero address (native) to the sentinel. */
function normalizeToken(addr) {
  if (typeof addr !== 'string') return null;
  const lower = addr.toLowerCase();
  return lower === ZERO_ADDRESS ? EVM_NATIVE_SENTINEL : lower;
}

/**
 * Fold a flat list of logs into per-token deltas for `wallet`, the ERC-20
 * Approvals the wallet granted, any non-fungible (ERC-721/ERC-1155) transfer OUT
 * of the wallet, and any non-fungible approval the wallet GRANTED. `deltas` is
 * signed: positive = received, negative = sent. Tokens with a net-zero delta are
 * dropped.
 *
 * `nftOut` / `nftApprovals` exist because the fungible `deltas` (and the ERC-20
 * `approvals`) map cannot represent an NFT: a DEX swap should only move native
 * currency and ERC-20 tokens, so an ERC-721 / ERC-1155 leaving the wallet OR the
 * wallet granting an NFT operator approval is an out-of-scope, asset-endangering
 * event the caller must fail closed on (assertSwapOutcome) rather than silently
 * ignore. A single-NFT Approval carries empty `data`, so it would otherwise fold
 * into `approvals` as amount 0n and be mistaken for a harmless revoke; an
 * ApprovalForAll is not an ERC-20 Approval at all and would be dropped entirely.
 * Inbound NFTs, self-transfers, and NFT revokes are harmless and not recorded.
 *
 * @param {Array} logs - [{ address, topics, data }]
 * @param {string} wallet - the sender whose balance changes we care about
 */
function foldLogs(logs, wallet) {
  const w = wallet.toLowerCase();
  const deltas = {}; // token -> bigint (signed)
  const approvals = []; // { token, spender, amount } — ERC-20 approvals
  const nftOut = []; // { standard, token } — non-fungible transfers leaving `w`
  const nftApprovals = []; // { standard, token, operator } — NFT approvals `w` granted

  for (const lg of logs || []) {
    const topics = lg?.topics || [];
    const topic0 = (topics[0] || '').toLowerCase();

    if (topic0 === TRANSFER_TOPIC && topics.length >= 4) {
      // ERC-721: shares the ERC-20 Transfer signature but indexes the tokenId as
      // a 4th topic. Flag only when the NFT leaves the wallet for someone else (a
      // self-transfer is a no-op, mirroring the ERC-20 net-zero cleanup).
      const from = topicToAddress(topics[1]);
      const to = topicToAddress(topics[2]);
      if (from === w && to !== w) nftOut.push({ standard: 'ERC-721', token: normalizeToken(lg.address) });
    } else if (topic0 === TRANSFER_TOPIC && topics.length >= 3) {
      const from = topicToAddress(topics[1]);
      const to = topicToAddress(topics[2]);
      // eth_simulateV1 emits native transfers from the zero address; those carry
      // the moved value in `data` and their log `address` is 0x0 too — both
      // normalise to the native sentinel.
      const token = normalizeToken(lg.address);
      const amount = hexToBigInt(lg.data);
      if (!token || amount === 0n) continue;
      if (to === w) deltas[token] = (deltas[token] || 0n) + amount;
      if (from === w) deltas[token] = (deltas[token] || 0n) - amount;
    } else if ((topic0 === ERC1155_SINGLE_TOPIC || topic0 === ERC1155_BATCH_TOPIC) && topics.length >= 4) {
      // ERC-1155 TransferSingle/Batch index (operator, from, to); `from` is the
      // 3rd topic, `to` the 4th. Flag only a real outbound transfer.
      const from = topicToAddress(topics[2]);
      const to = topicToAddress(topics[3]);
      if (from === w && to !== w) nftOut.push({ standard: 'ERC-1155', token: normalizeToken(lg.address) });
    } else if (topic0 === APPROVAL_TOPIC && topics.length >= 4) {
      // ERC-721 single-token Approval (owner, approved, tokenId indexed; empty
      // data). Approving the zero address is a revoke and grants nothing.
      const owner = topicToAddress(topics[1]);
      const approved = topicToAddress(topics[2]);
      if (owner === w && approved && approved !== ZERO_ADDRESS) {
        nftApprovals.push({ standard: 'ERC-721', token: normalizeToken(lg.address), operator: approved });
      }
    } else if (topic0 === APPROVAL_TOPIC && topics.length >= 3) {
      const owner = topicToAddress(topics[1]);
      const spender = topicToAddress(topics[2]);
      if (owner === w) {
        approvals.push({
          token: normalizeToken(lg.address),
          spender,
          amount: hexToBigInt(lg.data),
        });
      }
    } else if (topic0 === APPROVAL_FOR_ALL_TOPIC && topics.length >= 3) {
      // ERC-721/ERC-1155 ApprovalForAll(owner, operator indexed; bool in data).
      // data == 0 is a revoke (grants nothing); any non-zero flag is a grant of
      // control over the wallet's whole collection.
      const owner = topicToAddress(topics[1]);
      const operator = topicToAddress(topics[2]);
      if (owner === w && hexToBigInt(lg.data) !== 0n) {
        nftApprovals.push({ standard: 'ERC-721/1155 (all)', token: normalizeToken(lg.address), operator });
      }
    }
  }

  for (const t of Object.keys(deltas)) {
    if (deltas[t] === 0n) delete deltas[t];
  }
  return { deltas, approvals, nftOut, nftApprovals };
}

// ============= eth_simulateV1 (primary) =============

function buildSimRpcBody(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

async function postSim(rpcUrl, apiKey, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Attach the Nansen API key ONLY when the endpoint is Nansen-hosted. A
    // NANSEN_BASE_SIM_RPC override can point at any host (dev node, third-party
    // trace RPC); forwarding the user's credential there would leak it, so an
    // untrusted endpoint is always called anonymously (see isNansenHostedUrl).
    const sendApiKey = Boolean(apiKey) && isNansenHostedUrl(rpcUrl);
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sendApiKey ? { apikey: apiKey } : {}),
      },
      body: buildSimRpcBody(method, params),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SwapSimulationError(
        'SIM_RPC_ERROR',
        `Simulation RPC returned non-JSON (HTTP ${res.status}) for ${method}: ${text.slice(0, 120)}`,
      );
    }
    return body;
  } catch (e) {
    if (e instanceof SwapSimulationError) throw e;
    if (e.name === 'AbortError') {
      throw new SwapSimulationError('SIM_RPC_ERROR', `Simulation RPC timed out after ${timeoutMs}ms (${method})`);
    }
    throw new SwapSimulationError('SIM_RPC_ERROR', `Simulation RPC request failed (${method}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when an RPC error indicates the method itself is unavailable, as opposed
 * to a normal execution failure. We only fall back to another trace method on
 * "unsupported", never on a genuine revert or bad-params error.
 */
function isMethodUnsupported(rpcError) {
  const msg = (rpcError?.message || '').toLowerCase();
  const code = rpcError?.code;
  // -32601 = method not found (JSON-RPC). Providers also phrase disabled trace
  // methods as "method ... not supported"/"not available"/"not enabled".
  return (
    code === -32601 ||
    msg.includes('method not found') ||
    msg.includes('not supported') ||
    msg.includes('not available') ||
    msg.includes('not enabled') ||
    msg.includes('unsupported method')
  );
}

async function simulateViaEthSimulateV1(rpcUrl, apiKey, { from, to, data, value }, timeoutMs) {
  const params = [
    {
      blockStateCalls: [
        {
          calls: [{ from, to, data: data || '0x', value: value || '0x0' }],
        },
      ],
      // Surface native ETH movements as synthetic Transfer logs, and don't let
      // validation (nonce/balance) reject the pre-broadcast sim.
      traceTransfers: true,
      validation: false,
    },
    'latest',
  ];
  const body = await postSim(rpcUrl, apiKey, 'eth_simulateV1', params, timeoutMs);
  if (body.error) {
    if (isMethodUnsupported(body.error)) {
      throw new SwapSimulationError('NOT_SIM_CAPABLE', `eth_simulateV1 unavailable: ${body.error.message}`);
    }
    throw new SwapSimulationError('SIM_RPC_ERROR', `eth_simulateV1 error: ${body.error.message}`);
  }
  const blockResult = Array.isArray(body.result) ? body.result[0] : body.result;
  const call = blockResult?.calls?.[0];
  if (!call) {
    throw new SwapSimulationError('SIM_RPC_ERROR', 'eth_simulateV1 returned no call result');
  }
  // status is '0x1' on success, '0x0' on revert.
  if (call.status != null && BigInt(call.status) === 0n) {
    throw new SwapSimulationError(
      'SIM_REVERTED',
      `Swap reverts in simulation${call.error?.message ? `: ${call.error.message}` : ''}`,
    );
  }
  const { deltas, approvals, nftOut, nftApprovals } = foldLogs(call.logs, from);
  return { deltas, approvals, nftOut, nftApprovals, method: 'eth_simulateV1' };
}

// ============= debug_traceCall + callTracer (fallback) =============

/** Depth-first flatten a callTracer frame tree into { logs, frames }. */
function flattenFrames(root) {
  const logs = [];
  const frames = [];
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f) continue;
    frames.push(f);
    for (const lg of f.logs || []) logs.push(lg);
    for (const child of f.calls || []) stack.push(child);
  }
  return { logs, frames };
}

async function simulateViaDebugTraceCall(rpcUrl, apiKey, { from, to, data, value }, timeoutMs) {
  const params = [
    { from, to, data: data || '0x', value: value || '0x0' },
    'latest',
    { tracer: 'callTracer', tracerConfig: { withLog: true } },
  ];
  const body = await postSim(rpcUrl, apiKey, 'debug_traceCall', params, timeoutMs);
  if (body.error) {
    if (isMethodUnsupported(body.error)) {
      throw new SwapSimulationError('NOT_SIM_CAPABLE', `debug_traceCall unavailable: ${body.error.message}`);
    }
    throw new SwapSimulationError('SIM_RPC_ERROR', `debug_traceCall error: ${body.error.message}`);
  }
  const root = body.result;
  if (!root) throw new SwapSimulationError('SIM_RPC_ERROR', 'debug_traceCall returned no result');
  if (root.error) {
    throw new SwapSimulationError('SIM_REVERTED', `Swap reverts in simulation: ${root.error}`);
  }

  const { logs, frames } = flattenFrames(root);
  const { deltas, approvals, nftOut, nftApprovals } = foldLogs(logs, from);

  // callTracer does NOT emit synthetic logs for native ETH, so derive native
  // movement from the `value` on each frame: value the wallet sends is an
  // outflow, value it receives is an inflow. Mirrors traceTransfers semantics.
  //
  // Only value-carrying opcodes actually move ETH: skip STATICCALL (value
  // forbidden) and DELEGATECALL (runs in the caller's context, its `value`
  // mirrors the parent rather than transferring) so a node that populates their
  // `value` field anyway can't invent or double-count native flow. A frame with
  // no `type` (unusual) is treated as non-moving and skipped.
  const w = from.toLowerCase();
  let native = 0n;
  for (const f of frames) {
    if (!ETH_MOVING_FRAME_TYPES.has((f.type || '').toUpperCase())) continue;
    const v = hexToBigInt(f.value);
    if (v === 0n) continue;
    if ((f.to || '').toLowerCase() === w) native += v;
    if ((f.from || '').toLowerCase() === w) native -= v;
  }
  if (native !== 0n) {
    deltas[EVM_NATIVE_SENTINEL] = (deltas[EVM_NATIVE_SENTINEL] || 0n) + native;
    if (deltas[EVM_NATIVE_SENTINEL] === 0n) delete deltas[EVM_NATIVE_SENTINEL];
  }

  // callTracer only sets `error` on the frame that reverted; a top-level call can
  // "succeed" while a sub-call reverts silently, moving nothing. If the trace
  // yielded no deltas and no approvals but some frame errored, surface that as a
  // revert — clearer than letting an all-zero outcome fail downstream as a
  // mismatch. (The primary eth_simulateV1 path reports status directly.)
  //
  // Deliberately scoped to the moved-nothing case: DO NOT widen this to throw on
  // any errored frame. Aggregators routinely make sub-calls that revert and are
  // caught (probe pool A, revert, fall back to pool B) inside an otherwise
  // successful swap, so those frame errors are normal. When tokens actually
  // moved, assertSwapOutcome judges the real outcome (a partial swap that failed
  // to deliver the output still fails assertion 2), so an errored frame there is
  // not a reliable revert signal and would false-positive on legitimate swaps.
  if (
    Object.keys(deltas).length === 0 &&
    approvals.length === 0 &&
    nftOut.length === 0 &&
    nftApprovals.length === 0
  ) {
    const errored = frames.find((f) => f.error);
    if (errored) {
      throw new SwapSimulationError('SIM_REVERTED', `Swap reverts in simulation: ${errored.error}`);
    }
  }
  return { deltas, approvals, nftOut, nftApprovals, method: 'debug_traceCall' };
}

// ============= public entry point =============

/**
 * Simulate a single swap transaction and return the normalised asset changes it
 * causes to `from`'s wallet.
 *
 * Placement: call this on the swap call alone, AFTER any required approval is
 * confirmed on-chain, so the live allowance is reflected on `latest` and a
 * single-transaction simulation matches what the broadcast swap will do.
 *
 * @param {string} chain - chain key (only 'base' is wired today)
 * @param {{ to: string, data: string, value?: string }} swapCall - the swap tx
 * @param {{ from: string, apiKey?: string|null, timeoutMs?: number }} opts
 * @returns {Promise<{ deltas: Record<string,bigint>, approvals: Array<{token,spender,amount}>, nftOut: Array<{standard,token}>, nftApprovals: Array<{standard,token,operator}>, method: string }>}
 * @throws {SwapSimulationError} on any degrade condition or an in-sim revert.
 */
export async function simulateAssetChanges(chain, swapCall, { from, apiKey = null, timeoutMs = 20000 } = {}) {
  const rpcUrl = SIMULATION_RPCS[chain];
  if (!rpcUrl) {
    throw new SwapSimulationError('NO_SIM_RPC', `No simulation RPC configured for chain '${chain}'.`);
  }
  if (!from) {
    throw new SwapSimulationError('SIM_RPC_ERROR', 'simulateAssetChanges requires a `from` address.');
  }

  const call = { from, to: swapCall.to, data: swapCall.data, value: swapCall.value };

  // Primary: eth_simulateV1 (native transfers as synthetic logs, single round
  // trip). Fall back to debug_traceCall only when eth_simulateV1 is unavailable.
  try {
    return await simulateViaEthSimulateV1(rpcUrl, apiKey, call, timeoutMs);
  } catch (e) {
    if (e instanceof SwapSimulationError && e.code === 'NOT_SIM_CAPABLE') {
      return await simulateViaDebugTraceCall(rpcUrl, apiKey, call, timeoutMs);
    }
    throw e;
  }
}
