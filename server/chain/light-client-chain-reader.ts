/**
 * `ChainReader` over the `@nimiq/core` light client, for the LOCAL testnet rehearsal.
 *
 * Why this exists: Nimiq Pay's hidden developer menu can put the phone on testnet, where NIM
 * is free, but there is no public testnet JSON-RPC endpoint of the kind `RpcChainReader`
 * talks to. The light client needs none — it dials the testnet seed nodes directly over
 * WebSocket and verifies what it reads against the chain proof.
 *
 * ============================ ONE CLIENT PER PROCESS ============================
 * Reaching consensus costs 4.9-6.0 s on testnet and 8.4-32.1 s on mainnet, measured over 11
 * cold starts on this machine on 2026-09-13 (`spikes/light-client/README.md` §3). Every read
 * after that is 0-4 s, and `getHeadHeight` is sub-millisecond because the head is already in
 * the client's own state. So the client is a lazy per-process singleton: booted once, awaited
 * once, shared by every request. This is why the mode is dev-only — a Vercel function
 * instance would pay that boot on every cold invocation, inside a 15 s budget.
 * ================================================================================
 *
 * Facts pinned by the spike and encoded here:
 *
 *  1. `config.network('TestAlbatross')` does NOT swap the seed nodes. The WASM ships the 14
 *     mainnet seeds and nothing else (grepping the .wasm for "nimiq-testnet" gives 0 hits), so
 *     a testnet client on the defaults dials mainnet seeds and hangs in `connecting` for ever
 *     with no error. The four testnet seeds must be set explicitly, on port 8443.
 *  2. The method is `getTransaction`, not `getTransactionByHash`, and `getHeadHeight`, not
 *     `getBlockNumber`.
 *  3. `getTransaction(hash)` THROWS "Transaction not found" for transactions that exist and
 *     are already included — nine consecutive times over 23.8 s for a transaction the same
 *     client had just broadcast and reported as included. So a throw is NEVER absence. Every
 *     throw maps to `ChainUnavailableError`; absence is decided by the caller's own validity
 *     window, never by this class. Mapping that string to `null` would tell Rewind a real,
 *     mined payment never happened, which is the worst answer this system can give.
 *  4. `getTransactionsByAddress` takes six parameters, not three, and the extra `minPeers`
 *     makes it throw rather than answer short. It failed 1 call in 27 in the spike, so it is
 *     retried here. A failure is `ChainUnavailableError`, never an empty list.
 *  5. Field names differ from the RPC's throughout; see `toRpcTransaction`.
 *
 * TESTED: `light-client-chain-reader.test.ts`, offline, against an injected fake client — the
 * throw mapping, the field mapping and the network/seed selection. The live behaviour was
 * observed by the spike, not by this file.
 */

import type { RpcAccount, RpcTransaction } from '../domain/nimiq.js';
import {
  ChainUnavailableError,
  type ChainRead,
  type ChainReader,
  type Clock,
} from '../domain/ports.js';

// ---------------------------------------------------------------------------
// Networks and seeds
// ---------------------------------------------------------------------------

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkSpec {
  /** What `ClientConfiguration.network()` wants. */
  albatrossName: 'TestAlbatross' | 'MainAlbatross';
  /** The number the domain compares `networkId` against. */
  networkId: number;
  /** `null` means "keep the built-in mainnet seeds"; a list means "replace them". */
  seedNodes: readonly string[] | null;
}

/**
 * Port 8443, not the 443 the mainnet seeds use. All four resolve and accept TCP (observed
 * 2026-09-13). Source: `node_modules/@nimiq/core/README.md`.
 */
export const TESTNET_SEED_NODES: readonly string[] = [
  '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
];

export const NETWORKS: Record<NetworkName, NetworkSpec> = {
  testnet: {
    albatrossName: 'TestAlbatross',
    networkId: 5,
    seedNodes: TESTNET_SEED_NODES,
  },
  mainnet: {
    albatrossName: 'MainAlbatross',
    networkId: 24,
    // The built-in defaults ARE the mainnet seeds. Setting them explicitly would pin a list
    // that the package updates.
    seedNodes: null,
  },
};

/** `REWIND_NETWORK`. Anything other than `testnet` is mainnet, so a typo fails safe. */
export function networkNameFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkName {
  return env.REWIND_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
}

export function networkSpec(name: NetworkName): NetworkSpec {
  return NETWORKS[name];
}

/** The networkId the domain should expect, with no `REWIND_NETWORK_ID` override set. */
export function defaultNetworkId(env: NodeJS.ProcessEnv = process.env): number {
  return networkSpec(networkNameFromEnv(env)).networkId;
}

// ---------------------------------------------------------------------------
// The slice of `Client` this adapter uses
// ---------------------------------------------------------------------------

/** `PlainTransactionDetails`, only the fields read here. */
export interface PlainTransactionDetailsLike {
  transactionHash: string;
  blockHeight?: number | null;
  timestamp?: number | null;
  confirmations?: number | null;
  sender: string;
  recipient: string;
  value: number;
  fee: number;
  data?: { type?: string; raw?: string } | null;
  validityStartHeight: number;
  executionResult?: boolean | undefined;
  network: string;
  state?: string;
}

export interface PlainAccountLike {
  type?: string | number;
  balance?: number;
}

/**
 * Structurally satisfied by `@nimiq/core`'s `Client`. Declared locally so the tests can inject
 * a fake without loading a 7.7 MB WASM worker, and so nothing outside `bootLightClient` has to
 * import `@nimiq/core` at all.
 */
export interface LightClient {
  getHeadHeight(): Promise<number>;
  getNetworkId(): Promise<number>;
  getAccount(address: string): Promise<PlainAccountLike>;
  getTransaction(hash: string): Promise<PlainTransactionDetailsLike>;
  getTransactionsByAddress(
    address: string,
    sinceBlockHeight?: number | null,
    knownTransactionDetails?: unknown[] | null,
    startAt?: string | null,
    limit?: number | null,
    minPeers?: number | null,
  ): Promise<PlainTransactionDetailsLike[]>;
  sendTransaction(transaction: string): Promise<PlainTransactionDetailsLike>;
}

// ---------------------------------------------------------------------------
// Boot, and the per-process singleton
// ---------------------------------------------------------------------------

export interface BootOptions {
  network?: NetworkName;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Called with progress lines so the dev server can show what the boot is doing. */
  onLog?: (line: string) => void;
}

/**
 * Creates a client and waits for consensus. Slow by construction — see the header. The
 * returned client's `networkId` is re-checked against the spec before it is handed back: a
 * client that silently ended up on the wrong network would verify payments against the wrong
 * chain, and that must fail loudly at boot rather than quietly per order.
 */
export async function bootLightClient(options: BootOptions = {}): Promise<LightClient> {
  const name = options.network ?? networkNameFromEnv();
  const spec = networkSpec(name);
  const log = options.onLog ?? ((line: string) => console.log(line));

  // Dynamic: importing `@nimiq/core` loads WASM, and nothing but this function should pay
  // that cost. The fake-chain and RPC paths never reach here.
  const { Client, ClientConfiguration } = await import('@nimiq/core');
  const config = new ClientConfiguration();
  config.network(spec.albatrossName);
  config.logLevel(options.logLevel ?? 'warn');
  if (spec.seedNodes) config.seedNodes([...spec.seedNodes]);

  const startedAt = Date.now();
  log(`[lightclient] booting ${name} (${spec.albatrossName}), this takes a few seconds`);
  const client = (await Client.create(config.build())) as unknown as LightClient;
  await (client as unknown as { waitForConsensusEstablished(): Promise<void> }).waitForConsensusEstablished();
  const consensusMs = Date.now() - startedAt;

  const actual = await client.getNetworkId();
  if (actual !== spec.networkId) {
    throw new Error(
      `light client reports networkId ${actual}, expected ${spec.networkId} for ${name}`,
    );
  }
  log(`[lightclient] consensus on ${name} in ${consensusMs} ms, networkId ${actual}`);
  return client;
}

let shared: Promise<LightClient> | null = null;

/**
 * The one client this process will ever have. Concurrent callers await the same promise, so
 * two requests arriving during the boot do not start two clients.
 */
export function getSharedLightClient(options: BootOptions = {}): Promise<LightClient> {
  if (!shared) {
    shared = bootLightClient(options).catch((err: unknown) => {
      // A failed boot must not poison the process for ever: the next request retries.
      shared = null;
      throw err;
    });
  }
  return shared;
}

/** Test aid. Never called by a handler. */
export function resetSharedLightClient(): void {
  shared = null;
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

const NETWORK_NAME_TO_ID: Record<string, number> = {
  mainalbatross: 24,
  testalbatross: 5,
  devalbatross: 6,
};

/**
 * `PlainTransactionDetails` -> the domain's `RpcTransaction`.
 *
 * Two mappings are load-bearing:
 *
 *  - `network` is a STRING (`'testalbatross'`), the domain compares a number. Remapped, and an
 *    unknown name is passed through unchanged so it fails the comparison rather than matching
 *    something by accident.
 *  - `executionResult` is `undefined` until inclusion, and the domain treats
 *    `executionResult !== true` on an included transaction as `execution_failed`, which is a
 *    FATAL mismatch that reverts the order. So a record that has a block height but no
 *    execution result is reported as not-yet-included (`blockNumber: null`), which is the
 *    non-fatal "keep polling" answer. Fail closed, and never towards a wrong terminal state.
 */
export function toRpcTransaction(t: PlainTransactionDetailsLike): RpcTransaction {
  const included = t.blockHeight !== undefined && t.blockHeight !== null && t.executionResult === true;
  return {
    hash: t.transactionHash,
    blockNumber: included ? (t.blockHeight as number) : null,
    timestamp: t.timestamp ?? null,
    confirmations: t.confirmations ?? null,
    from: t.sender,
    to: t.recipient,
    value: t.value,
    fee: t.fee,
    recipientData: t.data?.raw ?? '',
    validityStartHeight: t.validityStartHeight,
    executionResult: t.executionResult === true,
    networkId: NETWORK_NAME_TO_ID[t.network] ?? t.network,
  };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface LightClientChainReaderOptions {
  clock: Clock;
  /** Supplied in tests. In the app this is `getSharedLightClient`. */
  client?: LightClient | (() => Promise<LightClient>);
  network?: NetworkName;
  /** Attempts for the history query, which the spike saw fail 1 call in 27. Default 3. */
  historyAttempts?: number;
  /** Injectable so a retry test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Below this many peers `getTransactionsByAddress` throws instead of answering short. */
  minPeers?: number;
}

export class LightClientChainReader implements ChainReader {
  private readonly resolveClient: () => Promise<LightClient>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LightClientChainReaderOptions) {
    const supplied = options.client;
    this.resolveClient =
      typeof supplied === 'function'
        ? supplied
        : supplied
          ? async () => supplied
          : () => getSharedLightClient(options.network ? { network: options.network } : {});
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private wrap<T>(data: T): ChainRead<T> {
    return { data, fetchedAtMs: this.options.clock.nowMs(), source: 'network' };
  }

  /** Every failure below this line is "we do not know", never "it is not there". */
  private async client(): Promise<LightClient> {
    try {
      return await this.resolveClient();
    } catch (err) {
      throw new ChainUnavailableError(`light client is not ready: ${describe(err)}`, err);
    }
  }

  async getBlockNumber(): Promise<ChainRead<number>> {
    const client = await this.client();
    let height: number;
    try {
      // Local read: the head is in the client's own state, no round trip.
      height = await client.getHeadHeight();
    } catch (err) {
      throw new ChainUnavailableError(`light client getHeadHeight: ${describe(err)}`, err);
    }
    if (typeof height !== 'number' || !Number.isFinite(height)) {
      throw new ChainUnavailableError(`light client getHeadHeight: ${describe(height)} is not a height`);
    }
    return this.wrap(height);
  }

  /**
   * Only `GET /api/health` reads this. `PlainAccount` is a union and only the basic variant
   * carries a plain balance; anything without a finite `balance` is unavailable rather than a
   * fabricated zero, which would pause the demo for the wrong reason.
   */
  async getAccountByAddress(address: string): Promise<ChainRead<RpcAccount>> {
    const client = await this.client();
    let account: PlainAccountLike;
    try {
      account = await client.getAccount(address);
    } catch (err) {
      throw new ChainUnavailableError(`light client getAccount(${address}): ${describe(err)}`, err);
    }
    if (
      account === null ||
      typeof account !== 'object' ||
      typeof account.balance !== 'number' ||
      !Number.isFinite(account.balance)
    ) {
      throw new ChainUnavailableError(`light client getAccount: ${describe(account)} has no balance`);
    }
    // PlainAccount has no `address` field; it is re-attached from the argument.
    return this.wrap({
      address,
      balance: account.balance,
      ...(account.type === undefined ? {} : { type: account.type }),
    });
  }

  /**
   * NEVER returns null.
   *
   * `ChainReader` allows `null` for "the chain has never seen this hash", and the RPC reader
   * uses it. The light client cannot distinguish that case from "no peer has served me a
   * proof yet": it throws "Transaction not found" for both, including for transactions it
   * has itself just broadcast and reported as included (nine polls over 23.8 s,
   * `spikes/light-client/runs/send-1.txt`). Reporting that as `null` would mark a real
   * payment as absent, so every throw is `ChainUnavailableError` and the caller's validity
   * window is the only thing allowed to conclude absence.
   *
   * The visible cost is that a settlement poll answers 503 "verification delayed" for the
   * first half-minute after a broadcast, and then settles. That is the honest answer.
   */
  async getTransactionByHash(hash: string): Promise<ChainRead<RpcTransaction | null>> {
    const client = await this.client();
    try {
      const tx = await client.getTransaction(hash);
      return this.wrap(toRpcTransaction(tx));
    } catch (err) {
      throw new ChainUnavailableError(
        `light client getTransaction(${hash}): ${describe(err)} (a throw is never "absent" here)`,
        err,
      );
    }
  }

  /**
   * The reliable way to find a payment: scan the merchant address for `RW1:P:<orderId>`.
   * Retried, because the spike saw this call fail outright 1 time in 27 with
   * "Outbound error: Couldn't send request". A failure is unavailability — an empty list would
   * read as "this address has never been paid".
   */
  async getTransactionsByAddress(
    address: string,
    max: number,
    startAt: string | null,
  ): Promise<ChainRead<RpcTransaction[]>> {
    const client = await this.client();
    const attempts = Math.max(1, this.options.historyAttempts ?? 3);
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const list = await client.getTransactionsByAddress(
          address,
          null,
          null,
          startAt,
          max,
          this.options.minPeers ?? 1,
        );
        if (!Array.isArray(list)) {
          throw new Error(`result was not an array: ${describe(list)}`);
        }
        return this.wrap(list.map(toRpcTransaction));
      } catch (err) {
        last = err;
        if (attempt === attempts) break;
        await this.sleep(400 * 2 ** (attempt - 1));
      }
    }
    throw new ChainUnavailableError(
      `light client getTransactionsByAddress(${address}) failed ${attempts}x: ${describe(last)}`,
      last,
    );
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
