/**
 * The persistence port.
 *
 * Two design rules, both about money:
 *
 * 1. Uniqueness is the database's job, not the application's. "Check then write" loses under
 *    concurrency however carefully it is written, so every single-instance fact — one order
 *    per payment tx, one challenge per nonce, one execution per order, one refund tx hash —
 *    is a unique constraint, and the caller handles UniqueViolationError as a normal outcome.
 *
 * 2. Every state change is a compare-and-set on the current state. A writer that finds the
 *    row already moved gets `null`, not a silent overwrite. That is what makes two concurrent
 *    approvals resolve to one.
 */

import type {
  DemoRefundLedgerRow,
  Merchant,
  MerchantNonce,
  Order,
  RefundChallenge,
  RefundExecution,
} from '../domain/types.js';
import type { OrderState } from '../domain/states.js';

export const CONSTRAINTS = {
  orderId: 'orders_pkey',
  orderPaymentTx: 'orders_payment_tx_hash_key',
  challengeNonce: 'refund_challenges_pkey',
  executionOrder: 'refund_executions_order_id_key',
  executionRefundTx: 'refund_executions_refund_tx_hash_key',
  demoLedgerOrder: 'demo_refunds_order_id_key',
  merchantNonce: 'merchant_nonces_pkey',
} as const;

export type ConstraintName = (typeof CONSTRAINTS)[keyof typeof CONSTRAINTS];

export class UniqueViolationError extends Error {
  readonly code = 'UNIQUE_VIOLATION';
  constructor(readonly constraint: string) {
    super(`unique constraint violated: ${constraint}`);
    this.name = 'UniqueViolationError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = 'NotFoundError';
  }
}

export type OrderPatch = Partial<Omit<Order, 'id' | 'createdAt'>>;
export type ExecutionPatch = Partial<Omit<RefundExecution, 'id' | 'orderId' | 'createdAt'>>;
export type ChallengeConsumePatch = Pick<
  RefundChallenge,
  'consumedAt' | 'signaturePublicKey' | 'signatureHex' | 'signerAddress'
>;

export interface Repository {
  // -- merchants ------------------------------------------------------------
  getMerchant(id: string): Promise<Merchant | null>;
  listMerchants(): Promise<Merchant[]>;
  /**
   * Inserts a merchant, or renames an existing one. The address and the treasury flag of an
   * existing row are never changed: a merchant id is derived from its address, so a different
   * address is a different merchant.
   */
  upsertMerchant(merchant: Merchant): Promise<Merchant>;

  // -- orders ---------------------------------------------------------------
  createOrder(order: Order): Promise<Order>;
  getOrder(id: string): Promise<Order | null>;
  getOrderByPaymentTx(hash: string): Promise<Order | null>;
  listOrders(limit?: number): Promise<Order[]>;
  /**
   * Compare-and-set. Applies `patch` only if the order is currently in `expectedState`.
   * Returns the updated order, or null if the state had already moved.
   * Throws UniqueViolationError when the patch sets a payment tx hash another order owns.
   */
  updateOrder(id: string, expectedState: OrderState, patch: OrderPatch): Promise<Order | null>;

  // -- refund challenges ----------------------------------------------------
  createChallenge(challenge: RefundChallenge): Promise<RefundChallenge>;
  getChallenge(nonce: string): Promise<RefundChallenge | null>;
  listChallengesForOrder(orderId: string): Promise<RefundChallenge[]>;
  /**
   * Atomically marks a nonce consumed. Returns null if it was already consumed — that is
   * the replay case, and it must be indistinguishable from a race.
   */
  consumeChallenge(nonce: string, patch: ChallengeConsumePatch): Promise<RefundChallenge | null>;

  // -- refund executions ----------------------------------------------------
  /** Throws UniqueViolationError(CONSTRAINTS.executionOrder) when the order already has one. */
  createRefundExecution(execution: RefundExecution): Promise<RefundExecution>;
  getRefundExecution(id: string): Promise<RefundExecution | null>;
  getRefundExecutionByOrder(orderId: string): Promise<RefundExecution | null>;
  updateRefundExecution(id: string, patch: ExecutionPatch): Promise<RefundExecution>;
  /**
   * Compare-and-set that attaches the serialised transaction, allowed only while there is
   * none. Two callers preparing the same refund at the same moment would otherwise build two
   * different transactions — a different validity start height alone is enough to change the
   * bytes, and two sets of bytes are two refunds. The loser gets null and must adopt the
   * winner's stored transaction rather than sending its own.
   */
  prepareRefundExecution(id: string, patch: ExecutionPatch): Promise<RefundExecution | null>;
  /** Executions that were prepared or broadcast but never confirmed. The recovery worklist. */
  listUnsettledRefundExecutions(): Promise<RefundExecution[]>;

  // -- merchant challenge nonces (gap S3) -----------------------------------
  /**
   * Records a challenge at the moment it is issued. Throws
   * UniqueViolationError(CONSTRAINTS.merchantNonce) when the same text was already issued —
   * the caller treats that as "re-issue the identical challenge", not as an error.
   */
  createMerchantNonce(row: MerchantNonce): Promise<MerchantNonce>;
  getMerchantNonce(nonce: string): Promise<MerchantNonce | null>;
  /**
   * Atomically marks a nonce used. Returns null when it was never issued or was already
   * used — replay and race must be indistinguishable, exactly as for the buyer's challenge.
   */
  consumeMerchantNonce(
    nonce: string,
    patch: { consumedAt: number; signerAddress: string },
  ): Promise<MerchantNonce | null>;
  /** Housekeeping. Returns how many rows were removed. */
  purgeExpiredMerchantNonces(nowSec: number): Promise<number>;

  // -- demo treasury ledger -------------------------------------------------
  appendDemoRefund(row: DemoRefundLedgerRow): Promise<DemoRefundLedgerRow>;
  listDemoRefundsSince(sinceMs: number): Promise<DemoRefundLedgerRow[]>;
  listDemoRefundsForWalletSince(wallet: string, sinceMs: number): Promise<DemoRefundLedgerRow[]>;
}
