/**
 * Fakes for every port.
 *
 * READ THIS BEFORE TRUSTING A GREEN TEST. None of these fakes performs cryptography and
 * none of them touches a network. `FakeSignatureVerifier` accepts a signature that a real
 * Ed25519 verifier would reject, and `FakeRefundTxBuilder` produces a hash that is not a
 * Blake2b hash of anything. They prove the state machine, the uniqueness and the recovery
 * logic. They prove nothing at all about signatures, serialisation or the chain.
 */

import type { RpcAccount, RpcTransaction } from './nimiq.js';
import { ACCOUNT_TYPE, addressToHex, normalizeAddress } from './nimiq.js';
import type {
  ChainRead,
  ChainReader,
  Clock,
  PreparedRefundTx,
  RandomSource,
  RefundTxBuilder,
  RefundTxRequest,
  SignatureVerification,
  SignatureVerifier,
  TxBroadcaster,
} from './ports.js';

// ---------------------------------------------------------------------------
// Clock and randomness
// ---------------------------------------------------------------------------

export class ManualClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export const systemClock: Clock = { nowMs: () => Date.now() };

/** Deterministic, sequential, and obviously not random. Tests only. */
export class SeededRandom implements RandomSource {
  private counter = 0;
  constructor(private readonly seed = 'seed') {}
  hex(bytes: number): string {
    this.counter += 1;
    let out = '';
    let h = fnv1a(`${this.seed}:${this.counter}`);
    while (out.length < bytes * 2) {
      out += h.toString(16).padStart(8, '0');
      h = fnv1a(out);
    }
    return out.slice(0, bytes * 2);
  }
}

export const cryptoRandom: RandomSource = {
  hex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    let out = '';
    for (const b of buf) out += b.toString(16).padStart(2, '0');
    return out;
  },
};

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable 64 hex character string. NOT a cryptographic hash. Test fixtures only. */
export function fakeHash(input: string): string {
  let out = '';
  let salt = 0;
  while (out.length < 64) {
    out += fnv1a(`${salt}|${input}`).toString(16).padStart(8, '0');
    salt += 1;
  }
  return out.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * A fake keypair. `publicKey` is an opaque token, and the "signature" is a digest of the
 * message and the key. Swapping the message or the key changes it, which is the only
 * property the domain tests rely on.
 */
export interface FakeKey {
  publicKey: string;
  address: string;
}

export function fakeKeyFor(address: string): FakeKey {
  const normalized = normalizeAddress(address);
  if (normalized === null) throw new Error(`fakeKeyFor: invalid address ${address}`);
  return { publicKey: `pk_${fakeHash(normalized).slice(0, 32)}`, address: normalized };
}

export function fakeSign(key: FakeKey, message: string): string {
  return fakeHash(`${key.publicKey}|${message}`);
}

export class FakeSignatureVerifier implements SignatureVerifier {
  private readonly keys = new Map<string, string>();

  register(key: FakeKey): FakeKey {
    this.keys.set(key.publicKey, key.address);
    return key;
  }

  registerAddress(address: string): FakeKey {
    return this.register(fakeKeyFor(address));
  }

  async verify(
    message: string,
    publicKeyHex: string,
    signatureHex: string,
  ): Promise<SignatureVerification> {
    if (typeof message !== 'string' || !publicKeyHex || !signatureHex) {
      return { ok: false, reason: 'malformed' };
    }
    const address = this.keys.get(publicKeyHex);
    if (address === undefined) return { ok: false, reason: 'bad_public_key' };
    const expected = fakeSign({ publicKey: publicKeyHex, address }, message);
    if (expected !== signatureHex) return { ok: false, reason: 'bad_signature' };
    return { ok: true, address, variant: 'nimiq-signed-message' };
  }
}

// ---------------------------------------------------------------------------
// Refund transaction building and broadcast
// ---------------------------------------------------------------------------

export class FakeRefundTxBuilder implements RefundTxBuilder {
  prepared: PreparedRefundTx[] = [];

  constructor(private readonly from: string) {}

  async prepare(request: RefundTxRequest): Promise<PreparedRefundTx> {
    const serializedTx = `fake-tx:${request.recipient}|${request.valueLuna}|${request.data}|${request.feeLuna}|${request.validityStartHeight}`;
    const tx: PreparedRefundTx = {
      serializedTx,
      // Deterministic in the bytes, exactly like a real hash, so re-preparing the same
      // refund yields the same hash and cannot become a second transaction.
      txHash: fakeHash(serializedTx),
      from: this.from,
      validityStartHeight: request.validityStartHeight,
    };
    this.prepared.push(tx);
    return tx;
  }
}

export type BroadcastOutcome = 'ok' | 'throw_before_send' | 'send_then_throw';

/**
 * Records every broadcast. `sent` counts transactions that actually reached the network,
 * including the ones where the call then blew up — that is the crash case that matters.
 */
export class FakeTxBroadcaster implements TxBroadcaster {
  readonly sent: string[] = [];
  readonly calls: string[] = [];
  outcome: BroadcastOutcome = 'ok';

  constructor(private readonly onSend?: (serializedTx: string, hash: string) => void) {}

  async broadcast(serializedTx: string): Promise<{ hash: string }> {
    this.calls.push(serializedTx);
    if (this.outcome === 'throw_before_send') {
      throw new Error('fake broadcaster: network refused before send');
    }
    const hash = fakeHash(serializedTx);
    this.sent.push(serializedTx);
    this.onSend?.(serializedTx, hash);
    if (this.outcome === 'send_then_throw') {
      throw new Error('fake broadcaster: sent, then the response was lost');
    }
    return { hash };
  }

  /** How many distinct transactions actually left. The number a double-spend test asserts on. */
  distinctSentCount(): number {
    return new Set(this.sent).size;
  }
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export interface FakeTxInput {
  hash?: string;
  from: string;
  to: string;
  value: number;
  fee?: number;
  /** Plain text; encoded to hex as `recipientData`. */
  data?: string;
  /** Raw hex `recipientData`, for binary data such as an HTLC's creation data. Wins over `data`. */
  dataHex?: string;
  blockNumber?: number | null;
  executionResult?: boolean;
  networkId?: number | string;
  timestamp?: number | null;
  validityStartHeight?: number;
  /** Defaults: 2 when `from` is a registered HTLC, otherwise 0. `toType` defaults to 0. */
  fromType?: number;
  toType?: number;
  flags?: number;
  /** Leave `fromType` / `toType` / `flags` out of the record, as an older node's answer would. */
  omitTypes?: boolean;
}

/**
 * An in-memory chain. `height` drives `confirmations`, so a test can mine blocks by
 * calling `advanceHeight` instead of sleeping.
 */
export class FakeChain {
  private readonly byHash = new Map<string, RpcTransaction>();
  height = 1_000_000;
  networkId: number | string = 24;
  /**
   * Balances, for `getAccountByAddress`. Only the health endpoint reads a balance; the money
   * path reads the account type and HTLC funder (`setHtlc`), never the balance — a fake balance
   * must never look like evidence of a transfer.
   */
  readonly balances = new Map<string, number>();
  /** What an address with no explicit balance reports. 100 NIM, so the demo is not paused. */
  defaultBalanceLuna = 10_000_000;
  /** Counts calls that would have hit the RPC. Used to prove the cache is doing its job. */
  reads = 0;

  include(input: FakeTxInput): RpcTransaction {
    const blockNumber = input.blockNumber === undefined ? this.height : input.blockNumber;
    const hash = input.hash ?? fakeHash(`${input.from}|${input.to}|${input.value}|${input.data ?? ''}|${blockNumber}`);
    const tx: RpcTransaction = {
      hash,
      blockNumber,
      timestamp: input.timestamp ?? null,
      confirmations: null,
      from: input.from,
      to: input.to,
      value: input.value,
      fee: input.fee ?? 0,
      recipientData:
        input.dataHex !== undefined ? input.dataHex : input.data === undefined ? undefined : utf8Hex(input.data),
      validityStartHeight: input.validityStartHeight ?? (blockNumber ?? this.height),
      executionResult: input.executionResult ?? true,
      networkId: input.networkId ?? this.networkId,
      ...(input.omitTypes
        ? {}
        : {
            fromType:
              input.fromType ??
              (this.htlcFunders.has(normalizeAddress(input.from) ?? input.from)
                ? ACCOUNT_TYPE.HTLC
                : ACCOUNT_TYPE.BASIC),
            toType: input.toType ?? ACCOUNT_TYPE.BASIC,
            flags: input.flags ?? 0,
          }),
    };
    this.byHash.set(hash, tx);
    return tx;
  }

  /** HTLC accounts by address, mapped to the address that funded them. Every other address is basic. */
  readonly htlcFunders = new Map<string, string>();

  setBalance(address: string, luna: number): void {
    this.balances.set(normalizeAddress(address) ?? address, luna);
  }

  /** Makes `address` an HTLC funded by `funder`, the way Nimiq Pay's paying address is. */
  setHtlc(address: string, funder: string): void {
    this.htlcFunders.set(normalizeAddress(address) ?? address, funder);
  }

  /**
   * `setHtlc`, plus the creation transaction in the address's history, laid out like the mainnet
   * creation `9bf66ef2…`: sender, recipient, Blake2b, zero hash root, count 1, timeout.
   */
  createHtlc(address: string, funder: string, recipient: string): RpcTransaction {
    this.setHtlc(address, funder);
    const creationData = `${addressToHex(funder)}${addressToHex(recipient)}01${'0'.repeat(64)}01${(1_790_530_365_363).toString(16).padStart(16, '0')}`;
    return this.include({
      from: funder,
      to: address,
      value: 20_000_000,
      dataHex: creationData,
      fromType: ACCOUNT_TYPE.BASIC,
      toType: ACCOUNT_TYPE.HTLC,
      flags: 1,
      blockNumber: this.height - 1_000,
    });
  }

  /** The contract is gone (emptied, or resolved after its timeout): the address reads as basic again. */
  closeHtlc(address: string): void {
    this.htlcFunders.delete(normalizeAddress(address) ?? address);
  }

  balanceOf(address: string): number {
    const key = normalizeAddress(address) ?? address;
    return this.balances.get(key) ?? this.defaultBalanceLuna;
  }

  advanceHeight(blocks: number): void {
    this.height += blocks;
  }

  get(hash: string): RpcTransaction | null {
    const tx = this.byHash.get(hash);
    if (!tx) return null;
    return {
      ...tx,
      confirmations: tx.blockNumber === null ? 0 : Math.max(0, this.height - tx.blockNumber + 1),
    };
  }

  all(): RpcTransaction[] {
    return [...this.byHash.keys()].map((h) => this.get(h)).filter((t): t is RpcTransaction => t !== null);
  }
}

function utf8Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export class FakeChainReader implements ChainReader {
  /**
   * `autoMinePerRead` makes the fake chain produce a block on every read, so a developer
   * clicking through the app sees confirmations accumulate the way a real chain would.
   * It defaults to 0: tests control height explicitly and must not have it drift underneath
   * them.
   */
  constructor(
    readonly chain: FakeChain,
    private readonly clock: Clock,
    private readonly autoMinePerRead = 0,
  ) {}

  private wrap<T>(data: T): ChainRead<T> {
    this.chain.reads += 1;
    if (this.autoMinePerRead > 0) this.chain.advanceHeight(this.autoMinePerRead);
    return { data, fetchedAtMs: this.clock.nowMs(), source: 'network' };
  }

  async getBlockNumber(): Promise<ChainRead<number>> {
    return this.wrap(this.chain.height);
  }

  async getTransactionByHash(hash: string): Promise<ChainRead<RpcTransaction | null>> {
    return this.wrap(this.chain.get(hash));
  }

  async getAccountByAddress(address: string): Promise<ChainRead<RpcAccount>> {
    const normalized = normalizeAddress(address) ?? address;
    const funder = this.chain.htlcFunders.get(normalized);
    return this.wrap({
      address: normalized,
      balance: this.chain.balanceOf(address),
      ...(funder === undefined ? { type: 'basic' } : { type: 'htlc', sender: funder }),
    });
  }

  async getTransactionsByAddress(
    address: string,
    max: number,
    startAt: string | null,
  ): Promise<ChainRead<RpcTransaction[]>> {
    const norm = normalizeAddress(address);
    const matching = this.chain
      .all()
      .filter((tx) => normalizeAddress(tx.from) === norm || normalizeAddress(tx.to) === norm)
      .sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0));
    const startIndex = startAt === null ? 0 : matching.findIndex((tx) => tx.hash === startAt) + 1;
    return this.wrap(matching.slice(startIndex, startIndex + max));
  }
}
