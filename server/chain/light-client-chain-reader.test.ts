/**
 * Offline tests for the light-client `ChainReader`.
 *
 * Nothing here opens a socket and nothing here loads the WASM client: the client is a fake
 * satisfying the `LightClient` interface. What is being pinned is the part of the adapter that
 * is a DECISION rather than an observation —
 *
 *   1. every throw becomes `ChainUnavailableError` and never `null`, because the live client
 *      throws "Transaction not found" about transactions that exist (spike §6), and
 *   2. testnet gets its own seed nodes, because `config.network('TestAlbatross')` does not
 *      swap them and a client on mainnet seeds hangs for ever with no error (spike §2.1).
 *
 * The live behaviour of the real client is evidence from `spikes/light-client`, not from here.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LightClientChainReader,
  NETWORKS,
  TESTNET_SEED_NODES,
  defaultNetworkId,
  networkNameFromEnv,
  networkSpec,
  toRpcTransaction,
  type LightClient,
  type PlainTransactionDetailsLike,
} from './light-client-chain-reader';
import { ChainUnavailableError } from '../domain/ports';

const clock = { nowMs: () => 1_700_000_000_000 };

function fakeClient(overrides: Partial<LightClient> = {}): LightClient {
  return {
    getHeadHeight: async () => 11_343_845,
    getNetworkId: async () => 5,
    getAccount: async () => ({ type: 'basic', balance: 11_000_000_000 }),
    getTransaction: async () => {
      throw new Error('Transaction not found');
    },
    getTransactionsByAddress: async () => [],
    sendTransaction: async () => {
      throw new Error('not used here');
    },
    ...overrides,
  };
}

function included(over: Partial<PlainTransactionDetailsLike> = {}): PlainTransactionDetailsLike {
  return {
    transactionHash: 'a'.repeat(64),
    blockHeight: 11_343_845,
    timestamp: 1_789_311_313_000,
    confirmations: 3,
    sender: 'NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH',
    recipient: 'NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ',
    value: 1_000,
    fee: 189,
    data: { type: 'raw', raw: '5257313a503a6f72646572' },
    validityStartHeight: 11_343_840,
    executionResult: true,
    network: 'testalbatross',
    state: 'confirmed',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Network and seed selection
// ---------------------------------------------------------------------------

describe('network selection', () => {
  it('uses the four testnet seeds on port 8443 for testnet', () => {
    const spec = networkSpec('testnet');
    expect(spec.albatrossName).toBe('TestAlbatross');
    expect(spec.networkId).toBe(5);
    expect(spec.seedNodes).toEqual(TESTNET_SEED_NODES);
    expect(spec.seedNodes).toHaveLength(4);
    for (const seed of spec.seedNodes ?? []) {
      // Port 8443, not the 443 the mainnet seeds use, and a testnet host. A single wrong seed
      // here is a client that sits in `connecting` for ever with no error.
      expect(seed).toMatch(/^\/dns4\/seed[1-4]\.pos\.nimiq-testnet\.com\/tcp\/8443\/wss$/);
    }
  });

  it('leaves the built-in mainnet seeds alone for mainnet', () => {
    const spec = networkSpec('mainnet');
    expect(spec.albatrossName).toBe('MainAlbatross');
    expect(spec.networkId).toBe(24);
    // null means "do not call config.seedNodes()", which is not the same as an empty list.
    expect(spec.seedNodes).toBeNull();
  });

  it('never gives testnet the mainnet seed list, or the reverse', () => {
    expect(NETWORKS.testnet.seedNodes).not.toBeNull();
    expect(NETWORKS.testnet.networkId).not.toBe(NETWORKS.mainnet.networkId);
  });

  it('reads REWIND_NETWORK, and anything unrecognised is mainnet', () => {
    expect(networkNameFromEnv({ REWIND_NETWORK: 'testnet' } as NodeJS.ProcessEnv)).toBe('testnet');
    expect(networkNameFromEnv({ REWIND_NETWORK: 'mainnet' } as NodeJS.ProcessEnv)).toBe('mainnet');
    expect(networkNameFromEnv({} as NodeJS.ProcessEnv)).toBe('mainnet');
    // A typo must not silently select testnet and make every mainnet check pass against 5.
    expect(networkNameFromEnv({ REWIND_NETWORK: 'Testnet' } as NodeJS.ProcessEnv)).toBe('mainnet');
  });

  it('defaults networkId to 5 on testnet and 24 otherwise', () => {
    expect(defaultNetworkId({ REWIND_NETWORK: 'testnet' } as NodeJS.ProcessEnv)).toBe(5);
    expect(defaultNetworkId({} as NodeJS.ProcessEnv)).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// Throw -> ChainUnavailableError, never null
// ---------------------------------------------------------------------------

describe('getTransactionByHash: every throw is unavailable, never absent', () => {
  it('maps "Transaction not found" to ChainUnavailableError, NOT to null', async () => {
    // The whole reason this adapter exists in this shape. The live client threw exactly this
    // for a transaction it had itself just included, nine times over 23.8 s.
    const reader = new LightClientChainReader({ clock, client: fakeClient() });
    await expect(reader.getTransactionByHash('b'.repeat(64))).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );
  });

  it('maps a peer/transport failure to ChainUnavailableError too', async () => {
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({
        getTransaction: async () => {
          throw new Error('Outbound error: Couldn\'t send request');
        },
      }),
    });
    const err = await reader.getTransactionByHash('b'.repeat(64)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).code).toBe('CHAIN_UNAVAILABLE');
  });

  it('never resolves to null for any thrown message', async () => {
    for (const message of [
      'Transaction not found',
      'No valid transaction found',
      'not found',
      'timeout',
      '',
    ]) {
      const reader = new LightClientChainReader({
        clock,
        client: fakeClient({
          getTransaction: async () => {
            throw new Error(message);
          },
        }),
      });
      const outcome = await reader
        .getTransactionByHash('c'.repeat(64))
        .then((read) => ({ resolved: read.data }))
        .catch((err: unknown) => ({ threw: err }));
      expect(outcome).not.toHaveProperty('resolved');
      expect((outcome as { threw: unknown }).threw).toBeInstanceOf(ChainUnavailableError);
    }
  });

  it('returns the mapped transaction when the client answers', async () => {
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({ getTransaction: async () => included() }),
    });
    const read = await reader.getTransactionByHash('a'.repeat(64));
    expect(read.data?.hash).toBe('a'.repeat(64));
    expect(read.data?.blockNumber).toBe(11_343_845);
    expect(read.source).toBe('network');
    expect(read.fetchedAtMs).toBe(clock.nowMs());
  });

  it('reports a failure to boot the client as unavailable, not as a crash', async () => {
    const reader = new LightClientChainReader({
      clock,
      client: () => Promise.reject(new Error('no peers')),
    });
    await expect(reader.getBlockNumber()).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('the other three reads fail closed as well', () => {
  it('getBlockNumber: a throw is unavailable', async () => {
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({
        getHeadHeight: async () => {
          throw new Error('worker gone');
        },
      }),
    });
    await expect(reader.getBlockNumber()).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('getBlockNumber: a non-numeric height is unavailable, not a zero height', async () => {
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({ getHeadHeight: async () => undefined as unknown as number }),
    });
    await expect(reader.getBlockNumber()).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('getAccountByAddress: a missing balance is unavailable, never a fabricated zero', async () => {
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({ getAccount: async () => ({ type: 'staking' }) }),
    });
    await expect(reader.getAccountByAddress('NQ07 0000 0000 0000 0000 0000 0000 0000 0000'))
      .rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('getAccountByAddress: re-attaches the address the caller asked for', async () => {
    const address = 'NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH';
    const reader = new LightClientChainReader({ clock, client: fakeClient() });
    const read = await reader.getAccountByAddress(address);
    expect(read.data).toEqual({ address, balance: 11_000_000_000, type: 'basic' });
  });

  it('getTransactionsByAddress: retries, then reports unavailable — never an empty list', async () => {
    const attempts = vi.fn(async () => {
      throw new Error("Outbound error: Couldn't send request");
    });
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({ getTransactionsByAddress: attempts }),
      sleep: async () => {},
    });
    const err = await reader
      .getTransactionsByAddress('NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH', 50, null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    // An empty list would read as "this address has never been paid", which would strand a
    // real payment. Three attempts, because the spike saw 1 call in 27 fail outright.
    expect(attempts).toHaveBeenCalledTimes(3);
  });

  it('getTransactionsByAddress: a later attempt succeeding is enough', async () => {
    let calls = 0;
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({
        getTransactionsByAddress: async () => {
          calls += 1;
          if (calls === 1) throw new Error('Inbound error: No receiver for request');
          return [included()];
        },
      }),
      sleep: async () => {},
    });
    const read = await reader.getTransactionsByAddress('NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ', 50, null);
    expect(read.data).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('getTransactionsByAddress: passes the domain limit and startAt through, plus minPeers', async () => {
    const spy = vi.fn(async () => [] as PlainTransactionDetailsLike[]);
    const reader = new LightClientChainReader({
      clock,
      client: fakeClient({ getTransactionsByAddress: spy }),
      minPeers: 2,
    });
    await reader.getTransactionsByAddress('NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ', 50, 'cursor');
    // Six parameters, not the RPC's three: (address, sinceBlockHeight, knownDetails, startAt,
    // limit, minPeers).
    expect(spy).toHaveBeenCalledWith(
      'NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ',
      null,
      null,
      'cursor',
      50,
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe('toRpcTransaction', () => {
  it('remaps the field names the two shapes disagree on', () => {
    const tx = toRpcTransaction(included());
    expect(tx.hash).toBe('a'.repeat(64));
    expect(tx.from).toBe('NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH');
    expect(tx.to).toBe('NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ');
    expect(tx.recipientData).toBe('5257313a503a6f72646572');
    expect(tx.blockNumber).toBe(11_343_845);
  });

  it('turns the network STRING into the number the domain compares', () => {
    expect(toRpcTransaction(included({ network: 'testalbatross' })).networkId).toBe(5);
    expect(toRpcTransaction(included({ network: 'mainalbatross' })).networkId).toBe(24);
    // An unknown name is passed through unchanged so it fails the comparison rather than
    // accidentally matching a real id.
    expect(toRpcTransaction(included({ network: 'whatever' })).networkId).toBe('whatever');
  });

  it('reports a pending transaction as not-included rather than as failed', () => {
    // `executionResult` is undefined until inclusion, and the domain treats
    // `executionResult !== true` on a transaction that HAS a block number as
    // `execution_failed` — a FATAL mismatch that reverts the order. So a half-populated
    // record must read as "not in a block yet", which is the non-fatal answer.
    const pending = toRpcTransaction(
      included({ blockHeight: undefined, executionResult: undefined, confirmations: null }),
    );
    expect(pending.blockNumber).toBeNull();
    expect(pending.executionResult).toBe(false);

    const halfway = toRpcTransaction(included({ executionResult: undefined }));
    expect(halfway.blockNumber).toBeNull();
  });

  it('keeps an explicit execution failure visible', () => {
    const failed = toRpcTransaction(included({ executionResult: false }));
    expect(failed.executionResult).toBe(false);
    // Still not reported as included: the domain would call this execution_failed and revert,
    // and this adapter has never observed a false from the live client, so it fails closed.
    expect(failed.blockNumber).toBeNull();
  });

  it('handles an empty data field', () => {
    expect(toRpcTransaction(included({ data: null })).recipientData).toBe('');
    expect(toRpcTransaction(included({ data: { type: 'raw' } })).recipientData).toBe('');
  });
});
