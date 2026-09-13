/**
 * Public Nimiq RPC reader. JSON-RPC 2.0 over POST.
 *
 * Every schema fact below was observed live against https://rpc.nimiqwatch.com and is pinned
 * in `spikes/server-tx/README.md` (2026-09-13) and
 * `Hackathons/Nimiq hackathon/docs/evidence/E0-chain-access-2026-09-12.md`:
 *
 *   1. Results are wrapped: `{"jsonrpc","result":{"data":<value>,"metadata":...},"id"}`.
 *      The value is at `result.data`, not `result`.
 *   2. `getTransactionByHash` takes ONE parameter, `["<hash>"]`.
 *   3. A hash the node has never seen is a JSON-RPC **error**, not a null result:
 *      `{"code":-32603,"message":"Transaction not found: <hash>"}`. That is the normal state
 *      of a transaction that is still propagating, so it maps to `null` — pending — and not
 *      to a failure. Getting this backwards would either stall every poll or report a
 *      never-sent transaction as confirmed.
 *   4. `getTransactionsByAddress` takes THREE parameters, `[address, max, startAt]`.
 *      A two-parameter call is rejected with -32602.
 *   5. The data field comes back hex encoded, under `recipientData`. The domain decodes it and
 *      scans for `RW1:P:<orderId>` (`parseReferenceFromHex`, used by `findPaymentByReference`).
 *   6. Mainnet `networkId` is 24.
 *
 * Anything else — a timeout, a 429, a 5xx, an unrecognised JSON-RPC error — is
 * `ChainUnavailableError`, which the API turns into 503 "verification delayed". It never
 * becomes a mismatch, because "we could not read the chain" and "the chain disagrees" are
 * different answers and only one of them may move an order's state.
 *
 * Caching lives one layer out, in `CachingChainReader`, which stamps every value with the
 * `fetchedAtMs` it was actually read at and marks cache hits. It is a separate class because
 * the public node allows roughly 20 tokens per 10 s per IP and Vercel's egress addresses are
 * shared: the cache is a rate-limit measure, not a performance one.
 *
 * TESTED: unit tests against an injected fetch, and integration tests against mainnet gated
 * behind `RUN_RPC_TESTS=1` (`rpc-chain-reader.integration.test.ts`).
 */

import type { RpcAccount, RpcTransaction } from '../domain/nimiq';
import { ChainUnavailableError, type ChainRead, type ChainReader, type Clock } from '../domain/ports';

interface RpcEnvelope<T> {
  jsonrpc?: string;
  id?: number;
  result?: { data: T; metadata?: unknown };
  error?: { code: number; message: string; data?: unknown };
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RpcChainReaderOptions {
  endpoint: string;
  clock: Clock;
  /** Per attempt, not for the whole call. Default 8 s. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff in ms; doubles each retry. Default 400. */
  backoffMs?: number;
  /** Optional bearer or basic credential for a private node. Never logged. */
  authorization?: string | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests, so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class RpcError extends Error {
  constructor(
    readonly rpcCode: number,
    readonly rpcMessage: string,
    readonly rpcData?: unknown,
  ) {
    super(`rpc ${rpcCode}: ${rpcMessage}`);
    this.name = 'RpcError';
  }
}

/**
 * The node's answer for a hash it has never seen. Confirmed live 2026-09-13T07:45:08Z:
 * `{"code":-32603,"message":"Transaction not found: <hash>"}`. Matched on the message rather
 * than the code alone, because -32603 is the generic internal-error code and is reused.
 */
export function isTransactionNotFound(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  const text = `${err.rpcMessage} ${typeof err.rpcData === 'string' ? err.rpcData : ''}`;
  return /transaction not found/i.test(text);
}

const RETRYABLE_HTTP = (status: number): boolean => status === 429 || status >= 500;

export class RpcChainReader implements ChainReader {
  private id = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RpcChainReaderOptions) {
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** One HTTP attempt. Throws RpcError for a JSON-RPC error, ChainUnavailableError otherwise. */
  private async attempt<T>(method: string, params: unknown[]): Promise<T> {
    this.id += 1;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.authorization ? { authorization: this.options.authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.id, method, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ChainUnavailableError(
          `${method}: http ${response.status}`,
          new RetryHint(RETRYABLE_HTTP(response.status)),
        );
      }
      let envelope: RpcEnvelope<T>;
      try {
        envelope = JSON.parse(text) as RpcEnvelope<T>;
      } catch {
        throw new ChainUnavailableError(`${method}: response was not JSON`, new RetryHint(true));
      }
      if (envelope.error) {
        throw new RpcError(envelope.error.code, envelope.error.message, envelope.error.data);
      }
      if (!envelope.result || !('data' in envelope.result)) {
        throw new ChainUnavailableError(`${method}: unexpected envelope`, new RetryHint(false));
      }
      return envelope.result.data;
    } catch (err) {
      if (err instanceof RpcError || err instanceof ChainUnavailableError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new ChainUnavailableError(
        aborted ? `${method}: timed out after ${timeoutMs}ms` : `${method}: ${describe(err)}`,
        new RetryHint(true),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retries on 429, 5xx, timeouts and transport failures. A JSON-RPC error is never retried. */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? 3);
    const base = this.options.backoffMs ?? 400;
    let last: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.attempt<T>(method, params);
      } catch (err) {
        last = err;
        if (err instanceof RpcError) throw err;
        const retryable = err instanceof ChainUnavailableError && err.cause_ instanceof RetryHint
          ? err.cause_.retryable
          : false;
        if (!retryable || attempt === maxAttempts) throw err;
        // Linear-in-attempts doubling. The public node's budget is ~20 tokens / 10 s / IP, so
        // a tight retry loop is the fastest way to be locked out of it.
        await this.sleep(base * 2 ** (attempt - 1));
      }
    }
    throw last instanceof Error ? last : new ChainUnavailableError(`${method}: exhausted`);
  }

  private wrap<T>(data: T): ChainRead<T> {
    return { data, fetchedAtMs: this.options.clock.nowMs(), source: 'network' };
  }

  async getBlockNumber(): Promise<ChainRead<number>> {
    const height = await this.call<number>('getBlockNumber', []);
    if (typeof height !== 'number' || !Number.isFinite(height)) {
      throw new ChainUnavailableError(`getBlockNumber: ${describe(height)} is not a height`);
    }
    return this.wrap(height);
  }

  /**
   * Balance of one address. Used only by the health endpoint.
   *
   * UNVERIFIED: unlike the three reads above, this method's response shape has NOT been
   * observed live from this repository. It is validated defensively — a missing or
   * non-numeric `balance` is ChainUnavailableError, never a zero balance, because a
   * fabricated zero would pause the demo for the wrong reason.
   */
  async getAccountByAddress(address: string): Promise<ChainRead<RpcAccount>> {
    const account = await this.call<RpcAccount | null>('getAccountByAddress', [address]);
    if (
      account === null ||
      typeof account !== 'object' ||
      typeof (account as RpcAccount).balance !== 'number' ||
      !Number.isFinite((account as RpcAccount).balance)
    ) {
      throw new ChainUnavailableError(`getAccountByAddress: ${describe(account)} has no balance`);
    }
    return this.wrap({
      address: typeof account.address === 'string' ? account.address : address,
      balance: account.balance,
      ...(account.type === undefined ? {} : { type: account.type }),
    });
  }

  /**
   * `null` means "the node does not have it yet" — pending — and is the normal answer while a
   * transaction propagates. It never means "the node is unreachable"; that throws.
   */
  async getTransactionByHash(hash: string): Promise<ChainRead<RpcTransaction | null>> {
    try {
      const tx = await this.call<RpcTransaction | null>('getTransactionByHash', [hash]);
      return this.wrap(tx ?? null);
    } catch (err) {
      if (isTransactionNotFound(err)) return this.wrap(null);
      if (err instanceof RpcError) {
        // Any other JSON-RPC error is the node telling us something we did not model. Do not
        // pretend it is "pending" — an unparseable hash reported as pending polls for ever.
        throw new ChainUnavailableError(`getTransactionByHash: ${err.message}`, err);
      }
      throw err;
    }
  }

  async getTransactionsByAddress(
    address: string,
    max: number,
    startAt: string | null,
  ): Promise<ChainRead<RpcTransaction[]>> {
    // Three parameters. Two is rejected with -32602 (E0, 2026-09-12).
    const txs = await this.call<RpcTransaction[] | null>('getTransactionsByAddress', [
      address,
      max,
      startAt,
    ]);
    if (txs !== null && !Array.isArray(txs)) {
      throw new ChainUnavailableError('getTransactionsByAddress: result was not an array');
    }
    return this.wrap(txs ?? []);
  }
}

/** Carried on ChainUnavailableError so the retry loop knows whether another attempt can help. */
export class RetryHint {
  constructor(readonly retryable: boolean) {}
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}
