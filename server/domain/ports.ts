/**
 * Ports. Everything the domain needs from the outside world, and nothing else.
 *
 * No cryptography is implemented anywhere in `server/`. `SignatureVerifier` and
 * `RefundTxBuilder` are the seams where the two spikes plug in their real implementations:
 *   spikes/sign-verify  -> SignatureVerifier
 *   spikes/server-tx    -> RefundTxBuilder + TxBroadcaster
 * Until then the fakes in `fakes.ts` are the only implementations, and they prove logic,
 * not cryptography.
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
 *   sha256("Nimiq Signed Message:
" + asciiDecimal(byteLength(message)) + message),
 * signed with Ed25519. `nimiq-connect-challenge` is the same construction with the keyguard's
 * second prefix "Nimiq Connect Challenge:
". Both were proved end to end in
 * `spikes/sign-verify` on 2026-09-13; which one Nimiq Pay actually uses has NOT been observed
 * on a device, so the verifier accepts either and reports which one matched.
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
   * The address it returns is the whole point: the caller compares it with the order's
   * verified payer. A verifier that returns ok without deriving the address is useless here.
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
   * Balance and type of one address. Read-only, and used only by `GET /api/health` to show
   * the Demo Store treasury balance and decide whether the demo is paused. Nothing in the
   * money path reads it: a balance is not evidence that a transfer happened.
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
