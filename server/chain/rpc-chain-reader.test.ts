/**
 * Offline unit tests for the RPC reader: every response shape is fed in through an injected
 * fetch, so nothing here opens a socket. The live counterpart is
 * `rpc-chain-reader.integration.test.ts`, which is skipped unless RUN_RPC_TESTS=1.
 *
 * The response bodies below are copied from real observations, not invented:
 *   - the wrapped envelope and the -32602 arity error from the E0 evidence document,
 *   - the "Transaction not found" error from spikes/server-tx (2026-09-13T07:45:08Z).
 */

import { describe, expect, it } from 'vitest';
import { RpcChainReader, isTransactionNotFound, RpcError, type FetchLike } from './rpc-chain-reader';
import { CachingChainReader } from '../domain/chain-cache';
import { ChainUnavailableError } from '../domain/ports';
import { ManualClock } from '../domain/fakes';
import { parseReferenceFromHex, utf8ToHex } from '../domain/nimiq';

const ENDPOINT = 'https://rpc.example.invalid';

interface Recorded {
  body: unknown;
}

function reader(
  responses: Array<{ status?: number; body: unknown } | Error>,
  opts: { clock?: ManualClock; maxAttempts?: number } = {},
) {
  const calls: Recorded[] = [];
  const slept: number[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push({ body: JSON.parse(init.body) });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    const status = next?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof next?.body === 'string' ? next.body : JSON.stringify(next?.body)),
    };
  };
  const clock = opts.clock ?? new ManualClock(1_700_000_000_000);
  return {
    calls,
    slept,
    clock,
    instance: new RpcChainReader({
      endpoint: ENDPOINT,
      clock,
      fetchImpl,
      maxAttempts: opts.maxAttempts ?? 3,
      backoffMs: 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }),
  };
}

const wrapped = (data: unknown) => ({ jsonrpc: '2.0', result: { data, metadata: null }, id: 1 });
const rpcError = (code: number, message: string, data?: string) => ({
  jsonrpc: '2.0',
  error: { code, message, ...(data ? { data } : {}) },
  id: 1,
});

const SAMPLE_TX = {
  hash: '90fca75b3a3bc3e35c0d8e74144df323e12c80914b497c51aa78f2fb1ede7616',
  blockNumber: 61420752,
  timestamp: 1789229039990,
  confirmations: 30,
  from: 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4JD',
  to: 'NQ87 T28S MDL1 TUC7 7L8L 5BED J4HC KBM7 MUXR',
  value: 1565,
  fee: 0,
  recipientData: utf8ToHex('RW1:P:order1234'),
  validityStartHeight: 61420752,
  executionResult: true,
  networkId: 24,
};

describe('getBlockNumber', () => {
  it('unwraps result.data', async () => {
    const { instance, calls, clock } = reader([{ body: wrapped(61420705) }]);
    const read = await instance.getBlockNumber();
    expect(read).toEqual({ data: 61420705, fetchedAtMs: clock.nowMs(), source: 'network' });
    expect(calls[0]?.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getBlockNumber', params: [] });
  });

  it('refuses a non-numeric height rather than passing it on', async () => {
    const { instance } = reader([{ body: wrapped('sixty million') }]);
    await expect(instance.getBlockNumber()).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('getTransactionByHash', () => {
  it('sends exactly one parameter', async () => {
    const { instance, calls } = reader([{ body: wrapped(SAMPLE_TX) }]);
    await instance.getTransactionByHash(SAMPLE_TX.hash);
    expect(calls[0]?.body).toMatchObject({
      method: 'getTransactionByHash',
      params: [SAMPLE_TX.hash],
    });
  });

  it('returns the parsed transaction', async () => {
    const { instance } = reader([{ body: wrapped(SAMPLE_TX) }]);
    const read = await instance.getTransactionByHash(SAMPLE_TX.hash);
    expect(read.source).toBe('network');
    expect(read.data?.blockNumber).toBe(61420752);
    expect(read.data?.networkId).toBe(24);
    expect(read.data?.executionResult).toBe(true);
  });

  it('hex-decodes recipientData into the RW1 reference', async () => {
    const { instance } = reader([{ body: wrapped(SAMPLE_TX) }]);
    const read = await instance.getTransactionByHash(SAMPLE_TX.hash);
    expect(parseReferenceFromHex(read.data?.recipientData)).toEqual({
      version: 'RW1',
      kind: 'P',
      orderId: 'order1234',
    });
  });

  it('treats "Transaction not found" as pending, not as a failure', async () => {
    const { instance, calls } = reader([
      { body: rpcError(-32603, `Transaction not found: ${'0'.repeat(64)}`) },
    ]);
    const read = await instance.getTransactionByHash('0'.repeat(64));
    expect(read.data).toBeNull();
    // A JSON-RPC error is a real answer, so it must not be retried against a rate-limited node.
    expect(calls).toHaveLength(1);
  });

  it('treats a null result as pending', async () => {
    const { instance } = reader([{ body: wrapped(null) }]);
    expect((await instance.getTransactionByHash('0'.repeat(64))).data).toBeNull();
  });

  it('does NOT treat an unmodelled JSON-RPC error as pending', async () => {
    const { instance } = reader([{ body: rpcError(-32602, 'Invalid params', 'bad hash') }]);
    await expect(instance.getTransactionByHash('nonsense')).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );
  });
});

describe('getTransactionsByAddress', () => {
  it('sends three parameters, because two is rejected with -32602', async () => {
    const { instance, calls } = reader([{ body: wrapped([SAMPLE_TX]) }]);
    await instance.getTransactionsByAddress(SAMPLE_TX.to, 50, null);
    expect(calls[0]?.body).toMatchObject({
      method: 'getTransactionsByAddress',
      params: [SAMPLE_TX.to, 50, null],
    });
  });

  it('finds the RW1:P:<orderId> payment in a page by decoding recipientData', async () => {
    const other = { ...SAMPLE_TX, hash: 'a'.repeat(64), recipientData: utf8ToHex('RW1:P:someone') };
    const bare = { ...SAMPLE_TX, hash: 'b'.repeat(64), recipientData: '' };
    const { instance } = reader([{ body: wrapped([other, bare, SAMPLE_TX]) }]);
    const page = await instance.getTransactionsByAddress(SAMPLE_TX.to, 50, null);
    const match = page.data.find(
      (tx) => parseReferenceFromHex(tx.recipientData)?.orderId === 'order1234',
    );
    expect(match?.hash).toBe(SAMPLE_TX.hash);
  });

  it('turns a null page into an empty array', async () => {
    const { instance } = reader([{ body: wrapped(null) }]);
    expect((await instance.getTransactionsByAddress(SAMPLE_TX.to, 50, null)).data).toEqual([]);
  });

  it('surfaces the arity error rather than pretending the address has no transactions', async () => {
    const { instance } = reader([
      {
        body: rpcError(
          -32602,
          'Invalid params',
          'invalid length 2, expected struct ...get_transactions_by_address with 3 elements',
        ),
      },
    ]);
    await expect(instance.getTransactionsByAddress(SAMPLE_TX.to, 50, null)).rejects.toBeInstanceOf(
      RpcError,
    );
  });
});

describe('retries and unavailability', () => {
  it('retries a 429 and succeeds', async () => {
    const { instance, calls, slept } = reader([
      { status: 429, body: 'rate limited' },
      { body: wrapped(61420705) },
    ]);
    expect((await instance.getBlockNumber()).data).toBe(61420705);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1]);
  });

  it('retries a 503 and gives up as ChainUnavailableError after maxAttempts', async () => {
    const { instance, calls, slept } = reader([{ status: 503, body: 'upstream down' }], {
      maxAttempts: 3,
    });
    await expect(instance.getBlockNumber()).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([1, 2]); // doubling backoff, no sleep after the last attempt
  });

  it('does not retry a 400', async () => {
    const { instance, calls } = reader([{ status: 400, body: 'nope' }]);
    await expect(instance.getBlockNumber()).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it('retries a transport failure', async () => {
    const { instance, calls } = reader([new Error('ECONNRESET'), { body: wrapped(1) }]);
    expect((await instance.getBlockNumber()).data).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('reports a timeout as unavailable', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const { instance } = reader([abort], { maxAttempts: 1 });
    await expect(instance.getBlockNumber()).rejects.toThrow(/timed out/);
  });

  it('reports a non-JSON body as unavailable', async () => {
    const { instance } = reader([{ body: '<html>502 Bad Gateway</html>' }], { maxAttempts: 1 });
    await expect(instance.getBlockNumber()).rejects.toThrow(/not JSON/);
  });

  it('reports an envelope with no result.data as unavailable, without retrying', async () => {
    const { instance, calls } = reader([{ body: { jsonrpc: '2.0', id: 1 } }]);
    await expect(instance.getBlockNumber()).rejects.toThrow(/unexpected envelope/);
    expect(calls).toHaveLength(1);
  });
});

describe('isTransactionNotFound', () => {
  it('matches the observed message and nothing else', () => {
    expect(isTransactionNotFound(new RpcError(-32603, 'Transaction not found: abc'))).toBe(true);
    expect(isTransactionNotFound(new RpcError(-32603, 'Internal error'))).toBe(false);
    expect(isTransactionNotFound(new Error('Transaction not found'))).toBe(false);
  });
});

describe('CachingChainReader over the RPC reader', () => {
  it('serves a second read from cache and keeps the original checkedAt timestamp', async () => {
    const clock = new ManualClock(1_000);
    const { instance, calls } = reader([{ body: wrapped(SAMPLE_TX) }], { clock });
    const cached = new CachingChainReader(instance, clock, { txTtlMs: 30_000 });

    const first = await cached.getTransactionByHash(SAMPLE_TX.hash);
    clock.advance(5_000);
    const second = await cached.getTransactionByHash(SAMPLE_TX.hash);

    expect(calls).toHaveLength(1);
    expect(first.source).toBe('network');
    expect(second.source).toBe('cache');
    expect(second.fetchedAtMs).toBe(1_000);
  });

  it('re-reads a pending answer sooner than a found one', async () => {
    const clock = new ManualClock(1_000);
    const { instance, calls } = reader(
      [{ body: rpcError(-32603, 'Transaction not found: x') }, { body: wrapped(SAMPLE_TX) }],
      { clock },
    );
    const cached = new CachingChainReader(instance, clock, { txTtlMs: 30_000, missTtlMs: 1_000 });

    expect((await cached.getTransactionByHash(SAMPLE_TX.hash)).data).toBeNull();
    clock.advance(1_500);
    expect((await cached.getTransactionByHash(SAMPLE_TX.hash)).data?.hash).toBe(SAMPLE_TX.hash);
    expect(calls).toHaveLength(2);
  });
});
