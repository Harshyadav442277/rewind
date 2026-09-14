/**
 * Chain acceptance predicates.
 *
 * These are the only place a payment or a refund becomes true. A wallet callback, a tx hash
 * typed by a user, or anything else the client says is a hint: it selects which chain record
 * to fetch, and nothing more. If the record does not satisfy the predicate the state does not
 * move, and the caller is told exactly which field disagreed.
 */

import {
  addressEquals,
  buildReference,
  parseReferenceFromHex,
  type RpcTransaction,
} from './nimiq.js';

export type MismatchKind =
  | 'not_included'
  | 'insufficient_confirmations'
  | 'execution_failed'
  | 'network_mismatch'
  | 'recipient_mismatch'
  | 'value_mismatch'
  | 'data_missing'
  | 'data_mismatch'
  | 'sender_mismatch'
  | 'sender_equals_recipient';

export interface Mismatch {
  kind: MismatchKind;
  expected: string | null;
  got: string | null;
}

export interface AcceptedTransfer {
  txHash: string;
  from: string;
  to: string;
  valueLuna: number;
  blockNumber: number;
  confirmations: number;
  /** Unix ms as the RPC reports it, or null when absent. */
  timestamp: number | null;
}

export type VerifyResult =
  | { ok: true; accepted: AcceptedTransfer }
  | { ok: false; mismatch: Mismatch };

export interface TransferExpectation {
  orderId: string;
  /** Address that must appear as `to`. */
  recipient: string;
  /** Exact Luna. Full amounts only in Cycle II: an underpayment and an overpayment both fail. */
  amountLuna: number;
  networkId: number | string;
  minConfirmations: number;
  /** Optional. When the sender is already known and bound, it must match exactly. */
  expectedSender?: string | null;
}

function mismatch(kind: MismatchKind, expected: unknown, got: unknown): VerifyResult {
  return {
    ok: false,
    mismatch: {
      kind,
      expected: expected === undefined || expected === null ? null : String(expected),
      got: got === undefined || got === null ? null : String(got),
    },
  };
}

function verifyTransfer(
  expectation: TransferExpectation,
  tx: RpcTransaction,
  expectedReference: string,
): VerifyResult {
  // 1. Is it on the chain at all?
  if (tx.blockNumber === null || tx.blockNumber === undefined) {
    return mismatch('not_included', 'a block number', null);
  }
  const confirmations = tx.confirmations ?? 0;

  // 2. Did it execute? A included-but-failed transaction moves no money.
  if (tx.executionResult !== true) {
    return mismatch('execution_failed', 'true', String(tx.executionResult));
  }

  // 3. Right chain. Compared as a string because the RPC's concrete type for networkId
  //    was recorded as "present" and not pinned. See the E0 evidence note.
  if (String(tx.networkId) !== String(expectation.networkId)) {
    return mismatch('network_mismatch', expectation.networkId, tx.networkId);
  }

  // 4. Right recipient.
  if (!addressEquals(tx.to, expectation.recipient)) {
    return mismatch('recipient_mismatch', expectation.recipient, tx.to);
  }

  // 5. Right amount, to the Luna. Fees are paid on top by the sender and are not counted.
  if (tx.value !== expectation.amountLuna) {
    return mismatch('value_mismatch', expectation.amountLuna, tx.value);
  }

  // 6. Right reference in the data field. This is what binds a transfer to this order.
  const ref = parseReferenceFromHex(tx.recipientData);
  if (ref === null) {
    if (!tx.recipientData) return mismatch('data_missing', expectedReference, null);
    return mismatch('data_mismatch', expectedReference, tx.recipientData);
  }
  const refText = `${ref.version}:${ref.kind}:${ref.orderId}`;
  if (refText !== expectedReference) {
    return mismatch('data_mismatch', expectedReference, refText);
  }

  // 7. Sender sanity. Nimiq refuses sender === recipient, but an adapter bug could still
  //    hand us one, and a self-transfer would look like a refund that never left.
  if (addressEquals(tx.from, tx.to)) {
    return mismatch('sender_equals_recipient', 'from != to', tx.from);
  }
  if (expectation.expectedSender && !addressEquals(tx.from, expectation.expectedSender)) {
    return mismatch('sender_mismatch', expectation.expectedSender, tx.from);
  }

  // 8. Deep enough. Checked last so the caller sees "nearly there" rather than a field error.
  if (confirmations < expectation.minConfirmations) {
    return mismatch('insufficient_confirmations', expectation.minConfirmations, confirmations);
  }

  return {
    ok: true,
    accepted: {
      txHash: tx.hash,
      from: tx.from,
      to: tx.to,
      valueLuna: tx.value,
      blockNumber: tx.blockNumber,
      confirmations,
      timestamp: tx.timestamp ?? null,
    },
  };
}

/** The buyer paid the merchant: `to` = merchant, data = `RW1:P:<orderId>`. */
export function verifyPayment(expectation: TransferExpectation, tx: RpcTransaction): VerifyResult {
  return verifyTransfer(expectation, tx, buildReference('P', expectation.orderId));
}

/**
 * The refund went back: `to` = the verified payer, `from` = the merchant wallet or the demo
 * treasury, data = `RW1:R:<orderId>`. `expectedSender` is required here; a refund from an
 * unexpected wallet is not this order's refund.
 */
export function verifyRefund(
  expectation: TransferExpectation & { expectedSender: string },
  tx: RpcTransaction,
): VerifyResult {
  return verifyTransfer(expectation, tx, buildReference('R', expectation.orderId));
}

/** Human readable, safe to show a buyer. No internal ids, no hints about internals. */
export function describeMismatch(m: Mismatch): string {
  switch (m.kind) {
    case 'not_included':
      return 'That transaction is not in a block yet.';
    case 'insufficient_confirmations':
      return `Waiting for confirmations (${m.got ?? '0'} of ${m.expected ?? '?'}).`;
    case 'execution_failed':
      return 'That transaction is on chain but its execution failed, so no NIM moved.';
    case 'network_mismatch':
      return `That transaction is on a different network (${m.got ?? 'unknown'}).`;
    case 'recipient_mismatch':
      return 'That transaction was sent to a different address than this order.';
    case 'value_mismatch':
      return `The amount does not match this order (expected ${m.expected ?? '?'} Luna, saw ${m.got ?? '?'}).`;
    case 'data_missing':
      return 'That transaction carries no Rewind reference, so it cannot be tied to this order.';
    case 'data_mismatch':
      return 'That transaction carries a reference for a different order.';
    case 'sender_mismatch':
      return 'That transaction was sent from a different wallet than expected.';
    case 'sender_equals_recipient':
      return 'Sender and recipient are the same address.';
  }
}
