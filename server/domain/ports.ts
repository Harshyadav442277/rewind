/**
 * Ports. Everything the domain needs from the outside world, and nothing else.
 *
 * No cryptography is implemented in `server/domain/`. The real implementations live beside it
 * and follow the two spikes:
 *   server/crypto/nimiq-signature-verifier.ts  -> SignatureVerifier   (spikes/sign-verify)
 *   server/chain/treasury-broadcaster.ts       -> RefundTxBuilder + TxBroadcaster (spikes/server-tx)
 *   server/chain/rpc-chain-reader.ts           -> ChainReader
 * The fakes in `fakes.ts` implement the same ports for tests and the local dev loop; they prove
 * logic, not cryptography.
 */

import type { RpcAccount, RpcTransaction } from './nimiq.js';

export interface Clock {
  nowMs(): number;
}

export interface RandomSource {
  /** Lowercase hex, exactly `bytes * 2` characters. */
  hex(bytes: number): string;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Which signing preimage actually verified.
 *
 * `nimiq-signed-message` is what `WalletAccount::sign_message` in core-rs-albatross produces:
 *   sha256("\x16Nimiq Signed Message:\n" + asciiDecimal(byteLength(message)) + message),
 * signed with Ed25519. `nimiq-connect-challenge` is the same construction with the keyguard's
 * second prefix "\x19Nimiq Connect Challenge:\n". Both were proved end to end in
 * `spikes/sign-verify` on 2026-09-13. Nimiq Pay on Android signed with the first one on a
 * device the same day; the verifier still accepts either and reports which one matched.
 */
export type SignedMessageVariant = 'nimiq-signed-message' | 'nimiq-connect-challenge';

export type SignatureVerification =
  | { ok: true; address: string; variant: SignedMessageVariant }
  | { ok: false; reason: 'bad_signature' | 'bad_public_key' | 'malformed' };

export interface SignatureVerifier {
  /**
   * Verifies `signatureHex` over the exact bytes of `message` under `publicKeyHex`, and
   * derives the Nimiq address of that public key.
   *
   * The address it returns is the whole point: the caller compares it with the refund
   * destination. A verifier that returns ok without deriving the address is useless here.
   */
  verify(message: string, publicKeyHex: string, signatureHex: string): Promise<SignatureVerification>;
}

// ---------------------------------------------------------------------------
// Refund transaction construction and broadcast (demo treasury path only)
// ---------------------------------------------------------------------------

export interface RefundTxRequest {
  recipient: string;
  valueLuna: number;
  /** Already length-checked reference text, e.g. `RW1:R:<orderId>`. */
  data: string;
  feeLuna: number;
  validityStartHeight: number;
}

export interface PreparedRefundTx {
  /** Hex serialised, ready to broadcast. Stored before the broadcast happens. */
  serializedTx: string;
  /** The hash the network will give this exact transaction. Deterministic from the bytes. */
  txHash: string;
  /** Sender address, derived from the signing key. */
  from: string;
  validityStartHeight: number;
}

export interface RefundTxBuilder {
  prepare(request: RefundTxRequest): Promise<PreparedRefundTx>;
}

export interface TxBroadcaster {
  /**
   * Pushes a serialised transaction to the network and returns the hash the network
   * reports. MUST be idempotent for identical bytes: re-broadcasting the same serialised
   * transaction is how crash recovery works, and it must not create a second transaction.
   */
  broadcast(serializedTx: string): Promise<{ hash: string }>;
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

/**
 * Every chain read carries when it was taken and whether it came from cache. The public RPC
 * is rate limited (20 tokens / 10 s / IP) and Vercel egress IPs are shared, so reads are
 * cached; the UI must be able to say "as of HH:MM:SS" rather than implying live data.
 */
export interface ChainRead<T> {
  data: T;
  fetchedAtMs: number;
  source: 'network' | 'cache';
}

/**
 * The chain could not be read: the node timed out, rate limited us, or answered with a 5xx
 * after every retry. This is NOT "the transaction is not there" — a hash the node has never
 * seen resolves to `null`, which is a normal polling answer. This error means we do not know,
 * and the API turns it into 503 "verification delayed" rather than a mismatch or a 500.
 */
export class ChainUnavailableError extends Error {
  readonly code = 'CHAIN_UNAVAILABLE';
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

export interface ChainReader {
  getBlockNumber(): Promise<ChainRead<number>>;
  /**
   * Balance, type and, for an HTLC, funder of one address. Read-only. Two readers:
   *  - `GET /api/health`, for the treasury balance and whether the demo is paused;
   *  - the money path, for the account TYPE and HTLC funder only: `resolveRefundDestination`
   *    decides where a refund may go, and `isRefundSender` accepts a shop's refund sent from an
   *    HTLC the shop funded. A balance is never evidence that a transfer happened.
   * A never-used address reads as `{ balance: 0, type: 'basic' }` on the public RPC (observed
   * 2026-09-15), so "basic" does not prove an account has ever existed.
   */
  getAccountByAddress(address: string): Promise<ChainRead<RpcAccount>>;
  getTransactionByHash(hash: string): Promise<ChainRead<RpcTransaction | null>>;
  /**
   * `[address, max, startAt]` — three parameters, `startAt` null for the first page.
   * A two-parameter call is rejected by the node with -32602 (E0 evidence, 2026-09-12).
   */
  getTransactionsByAddress(
    address: string,
    max: number,
    startAt: string | null,
  ): Promise<ChainRead<RpcTransaction[]>>;
}
