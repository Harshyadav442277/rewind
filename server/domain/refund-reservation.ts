/**
 * The refund path, and the only code allowed to move NIM back to a buyer.
 *
 * The safety property, stated once: **a refund is sent at most once per order, under
 * concurrency and across a crash at any point.** Everything below exists to hold that.
 *
 * How it is held, in order of importance:
 *
 *  R1  The obligation is a ROW, not a flag. `refund_executions` has a unique constraint on
 *      `order_id`. Two concurrent approvals both attempt the insert; the database picks the
 *      winner and the loser is told a reservation already exists. No read-then-write window.
 *
 *  R2  The transaction is recorded BEFORE it is broadcast. `serialized_tx` and the hash it
 *      will have are written while the order is REFUND_APPROVED. A process that dies during
 *      the broadcast therefore leaves behind the exact bytes it was sending.
 *
 *  R3  Recovery re-checks the chain before it re-sends, and re-sends the SAME bytes. A
 *      serialised transaction hashes to one hash; re-broadcasting it is idempotent at the
 *      network. Recovery never builds a second transaction and never re-enters approval.
 *
 *  R4  A refund is only REFUNDED once a chain record satisfies `verifyRefund`. The broadcast
 *      returning a hash means the network accepted the bytes, nothing more.
 */

import { buildChallenge, checkChallengeAgainstOrder, parseChallenge } from './challenge.js';
import { checkTreasuryCaps, describeCapDenial, type CapDenialReason } from './demo-treasury.js';
import type { DomainDeps } from './deps.js';
import {
  addressEquals,
  buildReference,
  normalizeAddress,
  normalizeTxHash,
  parseReferenceFromHex,
} from './nimiq.js';
import type { Order, RefundChallenge, RefundExecution } from './types.js';
import { describeMismatch, verifyRefund, type Mismatch } from './verify.js';
import { UniqueViolationError } from '../db/repository.js';

// ---------------------------------------------------------------------------
// 1. Issue the challenge
// ---------------------------------------------------------------------------

export type IssueChallengeResult =
  | { ok: true; challenge: RefundChallenge }
  | {
      ok: false;
      reason: 'not_found' | 'not_paid' | 'already_requested' | 'unrefundable_payer';
      detail: string;
    };

export type RefundDestination = { ok: true; address: string } | { ok: false; detail: string };

/**
 * The wallet a refund for this payer can land in, read from the chain.
 *
 * Nimiq Pay does not pay from the user's wallet directly. It pays out of an HTLC that the
 * user's wallet funded, and it signs with that funding wallet (observed 2026-09-14 on mainnet,
 * `NQ66…` HTLC funded by `NQ87…`, and on testnet, `NQ34…` funded by the same `NQ87…`; GAPS N29).
 * An HTLC rejects an incoming transfer — the first mainnet refund to one executed as failed —
 * so an HTLC payer resolves to its funder. A basic account is its own destination. Any other
 * account type is refused rather than guessed at.
 */
export async function resolveRefundDestination(
  deps: DomainDeps,
  payerAddress: string,
): Promise<RefundDestination> {
  const account = (await deps.chain.getAccountByAddress(payerAddress)).data;
  const type = account.type;
  if (type === 'basic' || type === 0) {
    const address = normalizeAddress(payerAddress);
    return address ? { ok: true, address } : { ok: false, detail: `bad payer address ${payerAddress}` };
  }
  if (type === 'htlc' || type === 2) {
    const funder = account.sender === undefined ? null : normalizeAddress(account.sender);
    return funder
      ? { ok: true, address: funder }
      : { ok: false, detail: `htlc ${payerAddress} has no readable funder` };
  }
  return { ok: false, detail: `payer ${payerAddress} is a ${String(type)} account` };
}

export async function issueRefundChallenge(
  deps: DomainDeps,
  orderId: string,
): Promise<IssueChallengeResult> {
  const order = await deps.repo.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found', detail: orderId };
  if (order.state !== 'PAID') {
    const already =
      order.state === 'REFUND_REQUESTED' ||
      order.state === 'REFUND_APPROVED' ||
      order.state === 'REFUND_BROADCAST' ||
      order.state === 'REFUNDED';
    return { ok: false, reason: already ? 'already_requested' : 'not_paid', detail: order.state };
  }
  if (order.paymentTxHash === null || order.payerAddress === null) {
    return { ok: false, reason: 'not_paid', detail: 'no verified payment on this order' };
  }

  const destination = await resolveRefundDestination(deps, order.payerAddress);
  if (!destination.ok) return { ok: false, reason: 'unrefundable_payer', detail: destination.detail };

  const nowMs = deps.clock.nowMs();
  const expiresAtSec = Math.floor(nowMs / 1000) + deps.config.challengeTtlSec;
  const nonce = deps.random.hex(16);
  const message = buildChallenge({
    orderId: order.id,
    paymentTxHash: order.paymentTxHash,
    amountLuna: order.amountLuna,
    refundTo: destination.address,
    nonce,
    expiresAtSec,
  });

  const record: RefundChallenge = {
    nonce,
    orderId: order.id,
    message,
    refundTo: destination.address,
    amountLuna: order.amountLuna,
    paymentTxHash: order.paymentTxHash,
    expiresAtSec,
    createdAt: nowMs,
    consumedAt: null,
    signaturePublicKey: null,
    signatureHex: null,
    signerAddress: null,
  };
  return { ok: true, challenge: await deps.repo.createChallenge(record) };
}

// ---------------------------------------------------------------------------
// 2. Take the signed request
// ---------------------------------------------------------------------------

export interface SignedRefundRequest {
  orderId: string;
  /** The exact text the wallet signed. Compared byte for byte with the stored challenge. */
  message: string;
  publicKey: string;
  signature: string;
}

export type SubmitRefundFailure =
  | 'not_found'
  | 'malformed_challenge'
  | 'unknown_nonce'
  | 'message_mismatch'
  | 'challenge_rejected'
  | 'bad_signature'
  | 'wrong_signer'
  | 'nonce_already_used'
  | 'wrong_state';

export type SubmitRefundResult =
  | { ok: true; order: Order; challenge: RefundChallenge }
  | { ok: false; reason: SubmitRefundFailure; detail: string; message: string };

const fail = (
  reason: SubmitRefundFailure,
  detail: string,
  message: string,
): SubmitRefundResult => ({ ok: false, reason, detail, message });

export async function submitSignedRefundRequest(
  deps: DomainDeps,
  request: SignedRefundRequest,
): Promise<SubmitRefundResult> {
  const parsed = parseChallenge(request.message);
  if (!parsed.ok) {
    return fail('malformed_challenge', `${parsed.reason}: ${parsed.detail}`, 'That refund request is not readable.');
  }
  const order = await deps.repo.getOrder(request.orderId);
  if (!order) return fail('not_found', request.orderId, 'Order not found.');
  if (parsed.value.orderId !== order.id) {
    return fail('challenge_rejected', 'order_mismatch', 'That refund request belongs to a different order.');
  }

  const stored = await deps.repo.getChallenge(parsed.value.nonce);
  if (!stored) {
    return fail('unknown_nonce', parsed.value.nonce, 'That refund request was not issued by Rewind.');
  }
  if (stored.orderId !== order.id) {
    return fail('unknown_nonce', 'nonce belongs to another order', 'That refund request belongs to a different order.');
  }
  // Byte-exact. The signature covers these bytes; a "close enough" match is a bypass.
  if (stored.message !== request.message) {
    return fail('message_mismatch', 'signed text differs from the issued challenge', 'The signed text does not match the request Rewind issued.');
  }

  const check = checkChallengeAgainstOrder(
    parsed.value,
    order,
    Math.floor(deps.clock.nowMs() / 1000),
    stored.refundTo,
  );
  if (!check.ok) {
    const human =
      check.reason === 'expired'
        ? 'That refund request has expired. Start a new one.'
        : 'That refund request does not match this order.';
    return fail('challenge_rejected', `${check.reason}: ${check.detail}`, human);
  }

  const verification = await deps.signatureVerifier.verify(
    request.message,
    request.publicKey,
    request.signature,
  );
  if (!verification.ok) {
    return fail('bad_signature', verification.reason, 'That signature could not be verified.');
  }
  // Only the wallet the refund goes back to may ask for it. `stored.refundTo` was resolved from
  // the chain when the challenge was issued: the payer itself, or the wallet that funded the
  // payer's HTLC, which is the wallet Nimiq Pay signs with.
  if (!addressEquals(verification.address, stored.refundTo)) {
    return fail(
      'wrong_signer',
      `${verification.address} != ${stored.refundTo}`,
      'That signature is not from the wallet this refund goes back to.',
    );
  }

  // Consume the nonce first. A replay of the same signed text loses here, before any state moves.
  const consumed = await deps.repo.consumeChallenge(parsed.value.nonce, {
    consumedAt: deps.clock.nowMs(),
    signaturePublicKey: request.publicKey,
    signatureHex: request.signature,
    signerAddress: verification.address,
  });
  if (!consumed) {
    return fail('nonce_already_used', parsed.value.nonce, 'That refund request has already been used.');
  }

  const updated = await deps.repo.updateOrder(order.id, 'PAID', {
    state: 'REFUND_REQUESTED',
    updatedAt: deps.clock.nowMs(),
    lastError: null,
  });
  if (!updated) {
    const fresh = await deps.repo.getOrder(order.id);
    return fail('wrong_state', fresh?.state ?? 'unknown', 'This order already has a refund request.');
  }
  return { ok: true, order: updated, challenge: consumed };
}

// ---------------------------------------------------------------------------
// 3. Reserve the single refund obligation (merchant approval)
// ---------------------------------------------------------------------------

export type ReserveRefundFailure =
  | 'not_found'
  | 'wrong_state'
  | 'no_signed_request'
  | 'cap_denied'
  | 'reservation_lost';

export type ReserveRefundResult =
  | { ok: true; order: Order; execution: RefundExecution; alreadyReserved: boolean }
  | {
      ok: false;
      reason: ReserveRefundFailure;
      detail: string;
      message: string;
      capReason?: CapDenialReason;
    };

/**
 * Approves and reserves. R1 lives here.
 *
 * Idempotent by design: calling it twice, or twice at the same moment, yields the same single
 * execution row. The second caller is told `alreadyReserved: true` rather than being given an
 * error, because a merchant double-tapping Approve is a normal event, not a fault.
 */
export async function reserveRefund(
  deps: DomainDeps,
  orderId: string,
): Promise<ReserveRefundResult> {
  const order = await deps.repo.getOrder(orderId);
  if (!order) {
    return { ok: false, reason: 'not_found', detail: orderId, message: 'Order not found.' };
  }

  const existing = await deps.repo.getRefundExecutionByOrder(orderId);
  if (existing) {
    return { ok: true, order, execution: existing, alreadyReserved: true };
  }
  if (order.state !== 'REFUND_REQUESTED') {
    return {
      ok: false,
      reason: 'wrong_state',
      detail: order.state,
      message: 'This order has no refund request waiting for approval.',
    };
  }

  const challenges = await deps.repo.listChallengesForOrder(orderId);
  const signed = challenges.find((c) => c.consumedAt !== null && c.signerAddress !== null);
  if (!signed) {
    return {
      ok: false,
      reason: 'no_signed_request',
      detail: 'no consumed challenge',
      message: 'No signed refund request exists for this order.',
    };
  }

  const nowMs = deps.clock.nowMs();

  if (order.refundSource === 'DEMO_TREASURY') {
    const [walletRows, hourRows, allRows] = await Promise.all([
      deps.repo.listDemoRefundsForWalletSince(signed.refundTo, 0),
      deps.repo.listDemoRefundsSince(nowMs - 60 * 60 * 1000),
      deps.repo.listDemoRefundsSince(0),
    ]);
    const decision = checkTreasuryCaps(
      {
        amountLuna: order.amountLuna,
        nowMs,
        walletRows,
        globalHourRows: hourRows,
        totalLunaCommitted: allRows.reduce((acc, r) => acc + r.amountLuna, 0),
      },
      deps.config.treasuryCaps,
    );
    if (!decision.allowed) {
      return {
        ok: false,
        reason: 'cap_denied',
        detail: decision.detail,
        message: describeCapDenial(decision.reason),
        capReason: decision.reason,
      };
    }
  }

  const candidate: RefundExecution = {
    id: `rex_${deps.random.hex(8)}`,
    orderId: order.id,
    challengeNonce: signed.nonce,
    refundTo: signed.refundTo,
    amountLuna: order.amountLuna,
    refunderAddress: order.refunderAddress,
    source: order.refundSource,
    intendedTxHash: null,
    serializedTx: null,
    validityStartHeight: null,
    preparedAt: null,
    broadcastAt: null,
    refundTxHash: null,
    confirmedAt: null,
    refundBlockNumber: null,
    failureReason: null,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  let execution: RefundExecution;
  try {
    execution = await deps.repo.createRefundExecution(candidate);
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      // R1: the database decided. Somebody else reserved this order between our read and write.
      const winner = await deps.repo.getRefundExecutionByOrder(orderId);
      const fresh = (await deps.repo.getOrder(orderId)) ?? order;
      if (winner) return { ok: true, order: fresh, execution: winner, alreadyReserved: true };
      return {
        ok: false,
        reason: 'reservation_lost',
        detail: err.constraint,
        message: 'Could not reserve this refund. Try again.',
      };
    }
    throw err;
  }

  const approved = await deps.repo.updateOrder(orderId, 'REFUND_REQUESTED', {
    state: 'REFUND_APPROVED',
    updatedAt: nowMs,
  });
  if (!approved) {
    // The order moved out from under an accepted reservation. Refuse to send: mark the
    // execution failed so it can never later be picked up and broadcast by recovery.
    await deps.repo.updateRefundExecution(execution.id, {
      failureReason: 'order_state_moved_before_approval',
      updatedAt: nowMs,
    });
    const fresh = (await deps.repo.getOrder(orderId)) ?? order;
    return {
      ok: false,
      reason: 'reservation_lost',
      detail: fresh.state,
      message: 'This order changed while it was being approved. Nothing was sent.',
    };
  }

  return { ok: true, order: approved, execution, alreadyReserved: false };
}

export async function rejectRefund(deps: DomainDeps, orderId: string): Promise<Order | null> {
  const existing = await deps.repo.getRefundExecutionByOrder(orderId);
  // Never reject an order that already carries a refund obligation.
  if (existing) return null;
  return deps.repo.updateOrder(orderId, 'REFUND_REQUESTED', {
    state: 'REJECTED',
    updatedAt: deps.clock.nowMs(),
  });
}

// ---------------------------------------------------------------------------
// 4. Send it (Demo Store treasury only)
// ---------------------------------------------------------------------------

export type ExecuteRefundStatus =
  | 'broadcast'
  | 'rebroadcast'
  | 'already_on_chain'
  | 'already_settled'
  | 'dead_letter';

export type ExecuteRefundResult =
  | { ok: true; status: ExecuteRefundStatus; execution: RefundExecution }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'no_reservation'
        | 'wrong_state'
        | 'not_treasury'
        | 'not_configured'
        | 'broadcast_error'
        | 'failed';
      detail: string;
      execution?: RefundExecution;
    };

/**
 * Prepares, records, broadcasts. R2 and R3 live here.
 *
 * Safe to call any number of times, including after a crash at any line. It is the recovery
 * routine and the happy path at once, on purpose: one code path means one behaviour to reason
 * about, and no "recovery mode" that only runs in an emergency and has therefore never run.
 */
export async function executeTreasuryRefund(
  deps: DomainDeps,
  orderId: string,
): Promise<ExecuteRefundResult> {
  const order = await deps.repo.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found', detail: orderId };

  let execution = await deps.repo.getRefundExecutionByOrder(orderId);
  if (!execution) return { ok: false, reason: 'no_reservation', detail: order.state };
  if (execution.confirmedAt !== null) {
    return { ok: true, status: 'already_settled', execution };
  }
  if (execution.failureReason !== null) {
    return { ok: false, reason: 'failed', detail: execution.failureReason, execution };
  }
  if (execution.source !== 'DEMO_TREASURY') {
    return { ok: false, reason: 'not_treasury', detail: execution.source, execution };
  }
  if (order.state !== 'REFUND_APPROVED' && order.state !== 'REFUND_BROADCAST') {
    return { ok: false, reason: 'wrong_state', detail: order.state, execution };
  }
  if (!deps.txBuilder || !deps.broadcaster) {
    return { ok: false, reason: 'not_configured', detail: 'no treasury signer configured', execution };
  }

  const nowMs = deps.clock.nowMs();

  // A treasury refund may not leave without its ledger row. Written here rather than at
  // reservation so the cap can never be bypassed by a crash between the two writes.
  try {
    await deps.repo.appendDemoRefund({
      id: `dled_${deps.random.hex(6)}`,
      orderId: order.id,
      walletAddress: execution.refundTo,
      amountLuna: execution.amountLuna,
      createdAt: nowMs,
    });
  } catch (err) {
    if (!(err instanceof UniqueViolationError)) throw err;
    // Already counted. Fine.
  }

  // R2: prepare, then persist the bytes and the hash, and only then broadcast.
  if (execution.serializedTx === null) {
    const height = await deps.chain.getBlockNumber();
    const prepared = await deps.txBuilder.prepare({
      recipient: execution.refundTo,
      valueLuna: execution.amountLuna,
      data: buildReference('R', order.id),
      feeLuna: deps.config.refundFeeLuna,
      validityStartHeight: height.data,
    });
    // Compare-and-set. Two callers preparing at once would otherwise each hold their own
    // bytes — and a validity start height one block apart is enough to make them two
    // different transactions, which is two refunds. Only one set of bytes may ever attach.
    const stored = await deps.repo.prepareRefundExecution(execution.id, {
      serializedTx: prepared.serializedTx,
      intendedTxHash: prepared.txHash,
      validityStartHeight: prepared.validityStartHeight,
      refunderAddress: prepared.from,
      preparedAt: nowMs,
      updatedAt: nowMs,
    });
    if (stored === null) {
      // Lost. Adopt the winner's transaction and abandon ours, which was never broadcast.
      const winner = await deps.repo.getRefundExecutionByOrder(orderId);
      if (!winner) return { ok: false, reason: 'no_reservation', detail: 'execution vanished' };
      execution = winner;
      const recovered = await recheckBeforeResend(deps, order, execution, orderId);
      if (recovered) return recovered;
    } else {
      execution = stored;
    }
  } else {
    // R3: bytes already exist, so a previous attempt may have reached the network. Look
    // before sending. This is the crash-after-broadcast case.
    const recovered = await recheckBeforeResend(deps, order, execution, orderId);
    if (recovered) return recovered;
  }

  const serialized = execution.serializedTx;
  if (serialized === null) {
    return { ok: false, reason: 'broadcast_error', detail: 'no serialised transaction', execution };
  }

  const isRetry = execution.broadcastAt !== null;
  try {
    // Idempotent for identical bytes: the same serialised transaction has one hash, so a
    // re-send is the same transaction, not a second one.
    const { hash } = await deps.broadcaster.broadcast(serialized);
    execution = await deps.repo.updateRefundExecution(execution.id, {
      broadcastAt: deps.clock.nowMs(),
      intendedTxHash: execution.intendedTxHash ?? normalizeTxHash(hash) ?? hash,
      updatedAt: deps.clock.nowMs(),
    });
  } catch (err) {
    // The bytes may or may not have reached the network. Do NOT mark this failed and do NOT
    // build another transaction: the stored bytes are the record, and the next call re-checks
    // the chain before touching anything.
    return {
      ok: false,
      reason: 'broadcast_error',
      detail: err instanceof Error ? err.message : String(err),
      execution,
    };
  }

  if (order.state === 'REFUND_APPROVED') {
    await deps.repo.updateOrder(orderId, 'REFUND_APPROVED', {
      state: 'REFUND_BROADCAST',
      updatedAt: deps.clock.nowMs(),
    });
  }
  return { ok: true, status: isRetry ? 'rebroadcast' : 'broadcast', execution };
}

/**
 * The merchant sent the refund from their own wallet in Nimiq Pay and reported a hash.
 * The hash is a hint. `settleRefund` decides whether it is this order's refund.
 */
export async function recordMerchantRefundBroadcast(
  deps: DomainDeps,
  orderId: string,
  claimedTxHash: string,
): Promise<ExecuteRefundResult> {
  const hash = normalizeTxHash(String(claimedTxHash ?? ''));
  if (hash === null) return { ok: false, reason: 'broadcast_error', detail: 'bad tx hash' };

  const order = await deps.repo.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found', detail: orderId };
  const execution = await deps.repo.getRefundExecutionByOrder(orderId);
  if (!execution) return { ok: false, reason: 'no_reservation', detail: order.state };
  if (execution.confirmedAt !== null) return { ok: true, status: 'already_settled', execution };
  if (order.state !== 'REFUND_APPROVED' && order.state !== 'REFUND_BROADCAST') {
    return { ok: false, reason: 'wrong_state', detail: order.state, execution };
  }

  const nowMs = deps.clock.nowMs();
  const updated = await deps.repo.updateRefundExecution(execution.id, {
    intendedTxHash: hash,
    broadcastAt: execution.broadcastAt ?? nowMs,
    updatedAt: nowMs,
  });
  if (order.state === 'REFUND_APPROVED') {
    await deps.repo.updateOrder(orderId, 'REFUND_APPROVED', {
      state: 'REFUND_BROADCAST',
      updatedAt: nowMs,
    });
  }
  return { ok: true, status: 'broadcast', execution: updated };
}

// ---------------------------------------------------------------------------
// 5. Settle from chain evidence
// ---------------------------------------------------------------------------

export type SettleStatus = 'refunded' | 'pending' | 'failed' | 'nothing_to_check';

export interface SettleResult {
  status: SettleStatus;
  order: Order | null;
  execution: RefundExecution | null;
  mismatch?: Mismatch;
  message?: string;
  chainFetchedAtMs?: number;
}

/** R4. The only function that may set REFUNDED. */
export async function settleRefund(deps: DomainDeps, orderId: string): Promise<SettleResult> {
  const order = await deps.repo.getOrder(orderId);
  if (!order) return { status: 'nothing_to_check', order: null, execution: null };
  const execution = await deps.repo.getRefundExecutionByOrder(orderId);
  if (!execution) return { status: 'nothing_to_check', order, execution: null };
  if (execution.confirmedAt !== null) return { status: 'refunded', order, execution };
  if (execution.failureReason !== null) return { status: 'failed', order, execution };

  const candidate = execution.refundTxHash ?? execution.intendedTxHash;
  if (candidate === null) {
    if (execution.source !== 'MERCHANT_WALLET' || order.state !== 'REFUND_APPROVED') {
      return { status: 'nothing_to_check', order, execution };
    }
    // The merchant sends the refund from Nimiq Pay, which gives the app no dependable hash,
    // so the refund is found on chain by its reference instead.
    const found = await findMerchantRefund(deps, order.id, execution);
    if (found.data === null) {
      return {
        status: 'pending',
        order,
        execution,
        message: 'Waiting for the merchant to send the refund.',
        chainFetchedAtMs: found.fetchedAtMs,
      };
    }
    const recorded = await recordMerchantRefundBroadcast(deps, order.id, found.data);
    if (!recorded.ok) return { status: 'pending', order, execution, message: recorded.detail };
    // Recorded, so the execution now carries a hash and this cannot recurse again.
    return settleRefund(deps, orderId);
  }

  const read = await deps.chain.getTransactionByHash(candidate);
  const nowMs = deps.clock.nowMs();

  if (read.data === null) {
    if (isConclusivelyDead(deps, execution, await currentHeight(deps))) {
      const dead = await markFailed(deps, order.state, orderId, execution, 'validity_window_lapsed');
      const fresh = await deps.repo.getOrder(orderId);
      return {
        status: 'failed',
        order: fresh,
        execution: dead,
        message: 'The refund transaction was never included and can no longer be. It needs a person.',
        chainFetchedAtMs: read.fetchedAtMs,
      };
    }
    return {
      status: 'pending',
      order,
      execution,
      message: 'The refund is not in a block yet.',
      chainFetchedAtMs: read.fetchedAtMs,
    };
  }

  const result = verifyRefund(
    {
      orderId: order.id,
      recipient: execution.refundTo,
      amountLuna: execution.amountLuna,
      networkId: order.networkId,
      minConfirmations: deps.config.minConfirmations,
      expectedSender: (await isRefundSender(deps, read.data.from, execution.refunderAddress))
        ? read.data.from
        : execution.refunderAddress,
    },
    read.data,
  );

  if (!result.ok) {
    const message = describeMismatch(result.mismatch);
    if (result.mismatch.kind === 'insufficient_confirmations' || result.mismatch.kind === 'not_included') {
      return {
        status: 'pending',
        order,
        execution,
        mismatch: result.mismatch,
        message,
        chainFetchedAtMs: read.fetchedAtMs,
      };
    }
    const dead = await markFailed(deps, order.state, orderId, execution, `${result.mismatch.kind}: ${message}`);
    const fresh = await deps.repo.getOrder(orderId);
    return {
      status: 'failed',
      order: fresh,
      execution: dead,
      mismatch: result.mismatch,
      message,
      chainFetchedAtMs: read.fetchedAtMs,
    };
  }

  const settledExecution = await deps.repo.updateRefundExecution(execution.id, {
    refundTxHash: result.accepted.txHash,
    refundBlockNumber: result.accepted.blockNumber,
    confirmedAt: nowMs,
    updatedAt: nowMs,
  });
  const refundedOrder =
    order.state === 'REFUNDED'
      ? order
      : ((await deps.repo.updateOrder(orderId, order.state, {
          state: 'REFUNDED',
          updatedAt: nowMs,
        })) ?? (await deps.repo.getOrder(orderId)));

  return {
    status: 'refunded',
    order: refundedOrder,
    execution: settledExecution,
    chainFetchedAtMs: read.fetchedAtMs,
  };
}

/**
 * Whether `from` may send this refund: the refunder itself, or an HTLC the refunder funded,
 * which is how a merchant's refund leaves Nimiq Pay (GAPS N29).
 */
async function isRefundSender(deps: DomainDeps, from: string, refunder: string): Promise<boolean> {
  if (addressEquals(from, refunder)) return true;
  const account = (await deps.chain.getAccountByAddress(from)).data;
  const isHtlc = account.type === 'htlc' || account.type === 2;
  return isHtlc && account.sender !== undefined && addressEquals(account.sender, refunder);
}

/**
 * Finds the merchant's refund among recent transfers to the refund address: the right
 * reference, the exact amount, and a sender the merchant controls. A lookalike from anyone
 * else is ignored rather than recorded, so a stranger cannot mark an order failed by sending
 * a transaction with this order's reference.
 */
async function findMerchantRefund(
  deps: DomainDeps,
  orderId: string,
  execution: RefundExecution,
): Promise<{ data: string | null; fetchedAtMs: number }> {
  const reference = buildReference('R', orderId);
  const page = await deps.chain.getTransactionsByAddress(execution.refundTo, 50, null);
  for (const tx of page.data) {
    const ref = parseReferenceFromHex(tx.recipientData);
    if (ref === null || `${ref.version}:${ref.kind}:${ref.orderId}` !== reference) continue;
    if (!addressEquals(tx.to, execution.refundTo) || tx.value !== execution.amountLuna) continue;
    if (!(await isRefundSender(deps, tx.from, execution.refunderAddress))) continue;
    return { data: tx.hash, fetchedAtMs: page.fetchedAtMs };
  }
  return { data: null, fetchedAtMs: page.fetchedAtMs };
}

// ---------------------------------------------------------------------------
// 6. Recovery sweep
// ---------------------------------------------------------------------------

export interface ResumeSummary {
  checked: number;
  settled: number;
  resent: number;
  stillPending: number;
  failed: number;
}

/**
 * Run at boot and on a schedule. For every unsettled obligation: look at the chain first,
 * then re-send the stored bytes if and only if nothing is there.
 */
export async function resumeUnsettledRefunds(deps: DomainDeps): Promise<ResumeSummary> {
  const pending = await deps.repo.listUnsettledRefundExecutions();
  const summary: ResumeSummary = { checked: 0, settled: 0, resent: 0, stillPending: 0, failed: 0 };

  for (const execution of pending) {
    summary.checked += 1;
    const settle = await settleRefund(deps, execution.orderId);
    if (settle.status === 'refunded') {
      summary.settled += 1;
      continue;
    }
    if (settle.status === 'failed') {
      summary.failed += 1;
      continue;
    }
    if (execution.source === 'DEMO_TREASURY' && deps.txBuilder && deps.broadcaster) {
      const sent = await executeTreasuryRefund(deps, execution.orderId);
      if (sent.ok && (sent.status === 'broadcast' || sent.status === 'rebroadcast')) {
        summary.resent += 1;
        continue;
      }
      if (sent.ok && sent.status === 'already_on_chain') {
        summary.settled += 1;
        continue;
      }
      if (sent.ok && sent.status === 'dead_letter') {
        summary.failed += 1;
        continue;
      }
    }
    summary.stillPending += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * R3. Before re-sending stored bytes, look on chain for them. Returns a finished result when
 * there is nothing left to send, or null to say "go ahead and broadcast these exact bytes".
 */
async function recheckBeforeResend(
  deps: DomainDeps,
  order: Order,
  execution: RefundExecution,
  orderId: string,
): Promise<ExecuteRefundResult | null> {
  if (execution.intendedTxHash === null) return null;
  const read = await deps.chain.getTransactionByHash(execution.intendedTxHash);
  if (read.data !== null) {
    const settled = await settleRefund(deps, orderId);
    return { ok: true, status: 'already_on_chain', execution: settled.execution ?? execution };
  }
  if (isConclusivelyDead(deps, execution, await currentHeight(deps))) {
    const dead = await markFailed(deps, order.state, orderId, execution, 'validity_window_lapsed');
    return { ok: true, status: 'dead_letter', execution: dead };
  }
  return null;
}

async function currentHeight(deps: DomainDeps): Promise<number> {
  const read = await deps.chain.getBlockNumber();
  return read.data;
}

/**
 * A Nimiq transaction is only valid within a window after `validityStartHeight`. Past that
 * the exact bytes can never be included, so the obligation is conclusively dead and can be
 * failed rather than re-sent for ever.
 */
function isConclusivelyDead(
  deps: DomainDeps,
  execution: RefundExecution,
  height: number,
): boolean {
  if (execution.validityStartHeight === null) return false;
  return height > execution.validityStartHeight + deps.config.refundValidityWindowBlocks;
}

async function markFailed(
  deps: DomainDeps,
  fromState: Order['state'],
  orderId: string,
  execution: RefundExecution,
  reason: string,
): Promise<RefundExecution> {
  const nowMs = deps.clock.nowMs();
  const updated = await deps.repo.updateRefundExecution(execution.id, {
    failureReason: reason,
    updatedAt: nowMs,
  });
  if (fromState === 'REFUND_APPROVED' || fromState === 'REFUND_BROADCAST') {
    await deps.repo.updateOrder(orderId, fromState, {
      state: 'REFUND_FAILED',
      updatedAt: nowMs,
      lastError: reason,
    });
  }
  return updated;
}

/** Used by the merchant screen and the receipt. */
export function refundToAddressOf(execution: RefundExecution): string {
  return normalizeAddress(execution.refundTo) ?? execution.refundTo;
}
