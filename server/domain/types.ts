import type { OrderState } from './states';

/** Where the refund NIM comes from. */
export type RefundSource = 'MERCHANT_WALLET' | 'DEMO_TREASURY';

export interface Merchant {
  id: string;
  name: string;
  /** Address that receives payments and, for a real merchant, sends the refund. */
  address: string;
  /** Only the built-in Demo Store may draw on the capped server treasury. */
  allowTreasuryRefund: boolean;
}

export interface Order {
  id: string;
  state: OrderState;
  merchantId: string;
  /** Recipient the buyer must pay. Snapshotted so a merchant edit cannot rewrite history. */
  merchantAddress: string;
  itemLabel: string;
  amountLuna: number;
  networkId: number | string;

  createdAt: number;
  updatedAt: number;
  /** Unix ms after which an unpaid order is EXPIRED. */
  expiresAt: number;

  /** Set only once a payment has been verified against a chain record. */
  paymentTxHash: string | null;
  /** The verified sender. This, and only this, is the address a refund may be sent to. */
  payerAddress: string | null;
  paidAt: number | null;
  paymentBlockNumber: number | null;

  /** Unverified hint from the wallet callback. Never a source of truth for state. */
  claimedPaymentTxHash: string | null;

  refundSource: RefundSource;
  /** Address that will send the refund. Never equal to payerAddress. */
  refunderAddress: string;

  lastError: string | null;
}

export interface RefundChallenge {
  /** The nonce doubles as the primary key. It is unique across the whole table. */
  nonce: string;
  orderId: string;
  /** The exact canonical text the buyer must sign, byte for byte. */
  message: string;
  refundTo: string;
  amountLuna: number;
  paymentTxHash: string;
  /** Unix seconds. */
  expiresAtSec: number;
  createdAt: number;

  consumedAt: number | null;
  signaturePublicKey: string | null;
  signatureHex: string | null;
  signerAddress: string | null;
}

export interface RefundExecution {
  id: string;
  /** UNIQUE. One refund obligation per order, enforced by the repository, not by convention. */
  orderId: string;
  challengeNonce: string;
  refundTo: string;
  amountLuna: number;
  refunderAddress: string;
  source: RefundSource;

  /** Recorded BEFORE the broadcast, so a crash mid-broadcast is recoverable. */
  intendedTxHash: string | null;
  serializedTx: string | null;
  /** Lets recovery decide when a prepared transaction is conclusively dead. */
  validityStartHeight: number | null;
  preparedAt: number | null;
  broadcastAt: number | null;

  /** Set only from a verified chain record. */
  refundTxHash: string | null;
  confirmedAt: number | null;
  refundBlockNumber: number | null;

  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One row per treasury-funded refund. The basis for every demo cap. */
export interface DemoRefundLedgerRow {
  id: string;
  orderId: string;
  /** The wallet the refund was paid to. Caps are per recipient wallet. */
  walletAddress: string;
  amountLuna: number;
  createdAt: number;
}

/**
 * One issued merchant challenge. Closes gap S3: the merchant challenge used to be stateless,
 * so the same signed text could be replayed inside its window.
 *
 * `nonce` is the SHA-256 of the challenge text, computed by the server that issued it. The
 * canonical text is not changed to carry a random nonce, because the text is what a wallet
 * displays and what 33 tests pin; the digest of that exact text is just as unique per
 * issuance and is derivable by the verifier from the bytes it was handed.
 */
export interface MerchantNonce {
  /** SHA-256 hex of `message`. Primary key. */
  nonce: string;
  merchantId: string;
  merchantAddress: string;
  /** `approve` | `reject` | `record-tx` | `list`. */
  action: string;
  /** The order the challenge is bound to, or the all-zero sentinel for a `list` challenge. */
  orderId: string;
  /** The exact bytes the merchant is asked to sign. */
  message: string;
  createdAt: number;
  /** Unix seconds. */
  expiresAtSec: number;
  consumedAt: number | null;
  signerAddress: string | null;
}

export interface RefundRequestView {
  order: Order;
  challenge: RefundChallenge;
  execution: RefundExecution | null;
}
