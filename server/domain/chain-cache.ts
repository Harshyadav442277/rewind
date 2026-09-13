import type { RpcAccount, RpcTransaction } from './nimiq';
import type { ChainRead, ChainReader, Clock } from './ports';

/**
 * A TTL cache in front of any ChainReader.
 *
 * Reason it exists: the public RPC allows roughly 20 tokens per 10 seconds per IP, and
 * Vercel's egress addresses are shared with every other tenant, so an uncached poll loop
 * would be throttled at the worst possible moment. Every value it hands back carries the
 * timestamp of the underlying read, and the UI shows that timestamp instead of pretending
 * the number is live.
 *
 * Deliberately not an LRU and deliberately per-instance: a serverless function instance is
 * short lived, and a shared cache would be a database, not a cache.
 */
export interface ChainCacheOptions {
  /** How long a found transaction stays fresh. Confirmed transactions do not change much. */
  txTtlMs?: number;
  /** How long a "not found yet" answer stays fresh. Short, because it is what polling waits on. */
  missTtlMs?: number;
  blockNumberTtlMs?: number;
  addressTtlMs?: number;
  /** Account balance. Short, because the health screen is the only reader and it polls. */
  accountTtlMs?: number;
  maxEntries?: number;
}

interface Entry {
  value: unknown;
  fetchedAtMs: number;
  expiresAtMs: number;
}

const DEFAULTS = {
  txTtlMs: 30_000,
  missTtlMs: 4_000,
  blockNumberTtlMs: 5_000,
  addressTtlMs: 8_000,
  accountTtlMs: 10_000,
  maxEntries: 500,
} as const;

export class CachingChainReader implements ChainReader {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: Required<ChainCacheOptions>;

  constructor(
    private readonly inner: ChainReader,
    private readonly clock: Clock,
    opts: ChainCacheOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private read<T>(key: string): ChainRead<T> | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.clock.nowMs()) {
      this.entries.delete(key);
      return null;
    }
    return { data: hit.value as T, fetchedAtMs: hit.fetchedAtMs, source: 'cache' };
  }

  private write(key: string, value: unknown, fetchedAtMs: number, ttlMs: number): void {
    if (this.entries.size >= this.opts.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, fetchedAtMs, expiresAtMs: fetchedAtMs + ttlMs });
  }

  async getBlockNumber(): Promise<ChainRead<number>> {
    const key = 'height';
    const cached = this.read<number>(key);
    if (cached) return cached;
    const fresh = await this.inner.getBlockNumber();
    this.write(key, fresh.data, fresh.fetchedAtMs, this.opts.blockNumberTtlMs);
    return fresh;
  }

  async getAccountByAddress(address: string): Promise<ChainRead<RpcAccount>> {
    const key = `account:${address}`;
    const cached = this.read<RpcAccount>(key);
    if (cached) return cached;
    const fresh = await this.inner.getAccountByAddress(address);
    this.write(key, fresh.data, fresh.fetchedAtMs, this.opts.accountTtlMs);
    return fresh;
  }

  async getTransactionByHash(hash: string): Promise<ChainRead<RpcTransaction | null>> {
    const key = `tx:${hash}`;
    const cached = this.read<RpcTransaction | null>(key);
    if (cached) return cached;
    const fresh = await this.inner.getTransactionByHash(hash);
    const ttl = fresh.data === null ? this.opts.missTtlMs : this.opts.txTtlMs;
    this.write(key, fresh.data, fresh.fetchedAtMs, ttl);
    return fresh;
  }

  async getTransactionsByAddress(
    address: string,
    max: number,
    startAt: string | null,
  ): Promise<ChainRead<RpcTransaction[]>> {
    const key = `addr:${address}:${max}:${startAt ?? ''}`;
    const cached = this.read<RpcTransaction[]>(key);
    if (cached) return cached;
    const fresh = await this.inner.getTransactionsByAddress(address, max, startAt);
    this.write(key, fresh.data, fresh.fetchedAtMs, this.opts.addressTtlMs);
    return fresh;
  }

  /** Test and operational aid. Not called in normal flow. */
  clear(): void {
    this.entries.clear();
  }
}
