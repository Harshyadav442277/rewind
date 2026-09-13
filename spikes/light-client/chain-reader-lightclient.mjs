#!/usr/bin/env node
// Rewind spike — light-client. SKETCH ONLY.
//
// How the app's `ChainReader` port (server/domain/ports.ts) would be implemented over the
// @nimiq/core light client instead of over `rpc.nimiqwatch.com`, as the fallback for when the
// public RPC is down.
//
// This file is a design artifact, not production code. The three read paths it wraps were all
// exercised for real by sync.mjs on testnet and mainnet on 2026-09-13; what is NOT proven here
// is the null/error semantics in the "KNOWN SEMANTIC GAP" note below, and nothing in this file
// has been wired into `server/`.
//
// Run `node chain-reader-lightclient.mjs --demo --network testnet` to see the adapter drive a
// real client end to end.

import { Client, ClientConfiguration } from '@nimiq/core';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NETWORKS = {
  testnet: {
    name: 'TestAlbatross',
    networkId: 5,
    // Required. The WASM default seed list is mainnet-only; config.network() does not swap it.
    seedNodes: [
      '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
    ],
  },
  mainnet: {
    name: 'MainAlbatross',
    networkId: 24,
    seedNodes: null, // the built-in defaults are the mainnet seeds
  },
};

// Mirrors `ChainUnavailableError` in server/domain/ports.ts: "we do not know", NOT "absent".
export class ChainUnavailableError extends Error {
  code = 'CHAIN_UNAVAILABLE';
  constructor(message, cause) {
    super(message);
    this.name = 'ChainUnavailableError';
    this.cause_ = cause;
  }
}

// ---------------------------------------------------------------------------
// Field mapping: PlainTransactionDetails (light client) -> RpcTransaction (domain)
// ---------------------------------------------------------------------------
//
// The two shapes do NOT line up field for field. Observed differences, 2026-09-13:
//
//   domain RpcTransaction     light client PlainTransactionDetails
//   ----------------------    --------------------------------------------------
//   hash                      transactionHash
//   blockNumber               blockHeight        (undefined while pending, not null)
//   from / to                 sender / recipient
//   recipientData (hex)       data.raw           (data is an object: {type:'raw', raw:'..'})
//   executionResult           executionResult    (undefined until included)
//   networkId (number 5/24)   network (STRING 'testalbatross' | 'mainalbatross')  <-- remap
//   (absent)                  state: new|pending|included|confirmed|invalidated|expired
//
// `state` is strictly more information than the RPC gives and the domain currently throws it
// away. If this adapter is adopted, `state` is worth adding to RpcTransaction: 'invalidated'
// and 'expired' are answers the RPC path can only infer from a timeout.

const NETWORK_NAME_TO_ID = { mainalbatross: 24, testalbatross: 5, devalbatross: 6 };

function toRpcTransaction(t) {
  return {
    hash: t.transactionHash,
    blockNumber: t.blockHeight ?? null,
    timestamp: t.timestamp ?? null,
    confirmations: t.confirmations ?? null,
    from: t.sender,
    to: t.recipient,
    value: t.value,
    fee: t.fee,
    recipientData: t.data?.raw ?? '',
    validityStartHeight: t.validityStartHeight,
    // `executionResult` is undefined until inclusion. The domain types it as a plain boolean,
    // so a not-yet-included transaction must NOT be coerced to false — that would read as
    // "the transfer failed". Left undefined so the caller trips its own guard.
    executionResult: t.executionResult,
    networkId: NETWORK_NAME_TO_ID[t.network] ?? t.network,
    // Extra, not in RpcTransaction today. See note above.
    state: t.state,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Implements `ChainReader` over a light client.
 *
 * ============================ COLD START — THE WHOLE POINT ============================
 *
 * `LightClientChainReader` takes a CLIENT THAT ALREADY HAS CONSENSUS. It deliberately does
 * not create one, because where the client's lifetime sits is the entire decision:
 *
 *   Long-lived process (a container, a VM, `vercel dev`, a Fly/Railway worker):
 *     Pay consensus ONCE at boot — measured 5.7-8.6 s on testnet, 6.2-7.9 s on mainnet
 *     (2026-09-13, this machine). Every read after that is 0.3-4 s. This is the mode the
 *     adapter is designed for and the mode in which it is a genuine RPC fallback.
 *
 *   Per-invocation (a Vercel serverless function):
 *     EVERY cold invocation pays the whole consensus cost again, because a function instance
 *     starts with no peers, no chain state and an empty (in-memory only) store — the client
 *     logs `Volatile` storage under Node and cannot persist a sync between invocations.
 *     Budget per cold call: ~0.2 s WASM import + ~0.15 s worker spawn + 5.7-8.6 s consensus
 *     + 0.3-3.7 s for the actual read = 6-12 s before a single byte of answer. A warm
 *     instance that happens to still hold the client is fast, but nothing guarantees one
 *     exists, and Vercel gives no way to keep the WebSocket peer set alive across freezes.
 *     A frozen instance's sockets are dead on thaw and consensus must be re-established.
 *
 * So: construct ONE of these per process, at boot, and share it. Do not construct one inside
 * a request handler.
 * ======================================================================================
 */
export class LightClientChainReader {
  #client;
  #cacheMs;
  #cache = new Map();

  /** @param client a Client that has already resolved waitForConsensusEstablished() */
  constructor(client, { cacheMs = 5000 } = {}) {
    this.#client = client;
    this.#cacheMs = cacheMs;
  }

  /**
   * Boots a client and waits for consensus. Call this ONCE, at process start.
   * Returns { reader, consensusMs } so the caller can log what the boot cost.
   */
  static async boot(network = 'mainnet', { logLevel = 'warn', cacheMs = 5000 } = {}) {
    const net = NETWORKS[network];
    if (!net) throw new Error(`unknown network ${network}`);
    const config = new ClientConfiguration();
    config.network(net.name);
    config.logLevel(logLevel);
    if (net.seedNodes) config.seedNodes(net.seedNodes);

    const t0 = performance.now();
    const client = await Client.create(config.build());
    await client.waitForConsensusEstablished();
    const consensusMs = performance.now() - t0;

    const actual = await client.getNetworkId();
    if (actual !== net.networkId) {
      throw new Error(`client reports networkId ${actual}, expected ${net.networkId}`);
    }
    return { client, reader: new LightClientChainReader(client, { cacheMs }), consensusMs };
  }

  #wrap(data, source) {
    return { data, fetchedAtMs: Date.now(), source };
  }

  async #cached(key, fn) {
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.fetchedAtMs < this.#cacheMs) {
      return { data: hit.data, fetchedAtMs: hit.fetchedAtMs, source: 'cache' };
    }
    const read = this.#wrap(await fn(), 'network');
    this.#cache.set(key, read);
    return read;
  }

  // -------------------------------------------------------------- getBlockNumber
  async getBlockNumber() {
    try {
      // Local: the head is already in the client's own state, so this is not a network round
      // trip at all. Measured sub-millisecond once consensus holds.
      return await this.#cached('head', () => this.#client.getHeadHeight());
    } catch (e) {
      throw new ChainUnavailableError('light client: getHeadHeight failed', e);
    }
  }

  // ------------------------------------------------------- getAccountByAddress
  async getAccountByAddress(address) {
    try {
      return await this.#cached(`acc:${address}`, async () => {
        const a = await this.#client.getAccount(address);
        // PlainAccount is a discriminated union; only "basic" carries a plain balance the
        // health endpoint cares about. It has no `address` field, so it is re-attached.
        return { address, balance: a.balance, type: a.type };
      });
    } catch (e) {
      throw new ChainUnavailableError(`light client: getAccount(${address}) failed`, e);
    }
  }

  // ------------------------------------------------------- getTransactionByHash
  /**
   * ================== KNOWN SEMANTIC GAP — READ BEFORE ADOPTING ==================
   * `ChainReader.getTransactionByHash` MUST return `null` for "the chain has never seen this
   * hash" and MUST throw `ChainUnavailableError` for "we could not find out". The whole
   * polling loop and the 503-vs-mismatch split in the API depend on that distinction.
   *
   * The light client's `getTransaction(hash)` THROWS in both cases, and worse, it throws the
   * literal message "Transaction not found" for transactions that DO exist and ARE included.
   *
   * HARD EVIDENCE, runs/send-1.txt, testnet 2026-09-13:
   *   sendTransaction() returned state="included", blockHeight=11343845 at t=0.
   *   getTransaction(<that same hash>) then threw "Transaction not found" on nine consecutive
   *   polls over the next 23.8 seconds before finally returning state="confirmed" at +26.4 s.
   *
   * So "Transaction not found" is NOT a not-found answer. It is "no peer served me a proof
   * yet", and for a freshly included transaction it is wrong for roughly half a minute. Any
   * adapter that maps that string to `null` would tell the app a real, already-mined payment
   * does not exist — the single worst answer this system can give.
   *
   * The honest behaviour is therefore to treat EVERY throw as CHAIN_UNAVAILABLE (fail closed:
   * "we do not know"), never as null. `#looksLikeNotFound` stays off by default and exists
   * only to mark where the work is; on this evidence it should probably be deleted rather
   * than fixed, and absence should be decided by the caller's own validity-window timeout.
   * ===============================================================================
   */
  async getTransactionByHash(hash, { trustNotFoundHeuristic = false } = {}) {
    try {
      const t = await this.#client.getTransaction(hash);
      return this.#wrap(toRpcTransaction(t), 'network');
    } catch (e) {
      if (trustNotFoundHeuristic && this.#looksLikeNotFound(e)) {
        return this.#wrap(null, 'network');
      }
      throw new ChainUnavailableError(`light client: getTransaction(${hash}) failed`, e);
    }
  }

  #looksLikeNotFound(e) {
    const m = String(e?.message ?? e).toLowerCase();
    return m.includes('no valid transaction') || m.includes('not found');
  }

  // ---------------------------------------------------- getTransactionsByAddress
  /**
   * Signature mismatch with the RPC port, and it matters.
   *
   *   domain:       getTransactionsByAddress(address, max, startAt)
   *   light client: getTransactionsByAddress(address, sinceBlockHeight, knownDetails,
   *                                          startAt, limit, minPeers)
   *
   * The extra `minPeers` argument has no RPC equivalent: below that many peers the call
   * throws instead of returning a short answer. That is a NEW failure mode the RPC path does
   * not have, and it maps to ChainUnavailableError, not to an empty list. An empty list from
   * a 1-peer client would silently read as "this address has no transactions".
   *
   * Unlike the RPC, these transactions are VERIFIED by the client against the chain proof
   * before being returned, which is the actual argument for this path being a trustworthy
   * fallback rather than just a second opinion.
   */
  async getTransactionsByAddress(address, max, startAt, { sinceBlockHeight = null, minPeers = 1 } = {}) {
    try {
      const list = await this.#client.getTransactionsByAddress(
        address,
        sinceBlockHeight,
        null,
        startAt,
        max,
        minPeers,
      );
      return this.#wrap(list.map(toRpcTransaction), 'network');
    } catch (e) {
      throw new ChainUnavailableError(`light client: getTransactionsByAddress(${address}) failed`, e);
    }
  }
}

/**
 * How it would actually be wired: try the RPC, fall back to the light client.
 *
 * Note what this does NOT do — it does not boot a client on demand. `lightReader` is either
 * already up or the fallback is simply unavailable, because booting one inside a request
 * would add 6-12 s to a request that is already failing.
 */
export function withLightClientFallback(rpcReader, lightReader) {
  const wrap = (method) => async (...args) => {
    try {
      return await rpcReader[method](...args);
    } catch (e) {
      if (e?.code !== 'CHAIN_UNAVAILABLE' || !lightReader) throw e;
      console.warn(`[chain] RPC ${method} unavailable, falling back to light client`);
      return await lightReader[method](...args);
    }
  };
  return {
    getBlockNumber: wrap('getBlockNumber'),
    getAccountByAddress: wrap('getAccountByAddress'),
    getTransactionByHash: wrap('getTransactionByHash'),
    getTransactionsByAddress: wrap('getTransactionsByAddress'),
  };
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

if (process.argv.includes('--demo')) {
  const i = process.argv.indexOf('--network');
  const network = i === -1 ? 'testnet' : process.argv[i + 1];
  const busy =
    network === 'testnet'
      ? 'NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ'
      : 'NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M';

  const { reader, consensusMs } = await LightClientChainReader.boot(network);
  console.log(`boot (consensus)     ${consensusMs.toFixed(0)} ms   <-- paid once per PROCESS`);

  const h = await reader.getBlockNumber();
  console.log(`getBlockNumber       ${h.data}  (source=${h.source})`);
  const h2 = await reader.getBlockNumber();
  console.log(`getBlockNumber again ${h2.data}  (source=${h2.source})`);

  const acc = await reader.getAccountByAddress(busy);
  console.log(`getAccountByAddress  ${JSON.stringify(acc.data)}`);

  const txs = await reader.getTransactionsByAddress(busy, 3, null);
  console.log(`getTransactionsByAddress -> ${txs.data.length}`);
  for (const t of txs.data) {
    console.log(`   ${t.hash} block=${t.blockNumber} networkId=${t.networkId} state=${t.state} value=${t.value}`);
  }

  if (txs.data[0]) {
    const one = await reader.getTransactionByHash(txs.data[0].hash);
    console.log(`getTransactionByHash -> ${JSON.stringify(one.data)}`);
  }

  // Prove the null-vs-throw gap rather than assert it.
  const bogus = '0'.repeat(64);
  try {
    const miss = await reader.getTransactionByHash(bogus);
    console.log(`unknown hash -> returned ${JSON.stringify(miss.data)} (would be a null answer)`);
  } catch (e) {
    console.log(`unknown hash -> THREW ${e.name}: ${String(e.cause_?.message ?? e.cause_ ?? '').slice(0, 160)}`);
    console.log('   ^ this is the semantic gap: indistinguishable from a peer failure.');
  }

  process.exit(0);
}
