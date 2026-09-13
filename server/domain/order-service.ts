/**
 * Order lifecycle: create, take a payment hint, verify the payment on chain.
 *
 * The only way an order becomes PAID is `verifyOrderPayment` accepting a real chain record.
 * `submitPaymentHint` records what the wallet said and nothing more; it is a pointer to a
 * record to fetch, not evidence.
 */

import {
  addressEquals,
  buildReference,
  isValidTxHash,
  normalizeAddress,
  normalizeTxHash,
  parseReferenceFromHex,
  type RpcTransaction,
} from './nimiq';
import { describeMismatch, verifyPayment, type Mismatch } from './verify';
import type { DomainDeps } from './deps';
import type { ChainRead } from './ports';
import type { Order, RefundSource } from './types';
import { UniqueViolationError } from '../db/repository';

export interface CreateOrderInput {
  merchantId: string;
  itemLabel: string;
  amountLuna: number;
}

export type CreateOrderResult =
  | { ok: true; order: Order }
  | { ok: false; reason: 'unknown_merchant' | 'bad_amount' | 'bad_merchant_address'; detail: string };

export async function createOrder(
  deps: DomainDeps,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const merchant = await deps.repo.getMerchant(input.merchantId);
  if (!merchant) {
    return { ok: false, reason: 'unknown_merchant', detail: input.merchantId };
  }
  if (!Number.isSafeInteger(input.amountLuna) || input.amountLuna <= 0) {
    return { ok: false, reason: 'bad_amount', detail: String(input.amountLuna) };
  }
  const merchantAddress = normalizeAddress(merchant.address);
  if (merchantAddress === null) {
    return { ok: false, reason: 'bad_merchant_address', detail: merchant.address };
  }

  const now = deps.clock.nowMs();
  const source: RefundSource = merchant.allowTreasuryRefund ? 'DEMO_TREASURY' : 'MERCHANT_WALLET';
  const order: Order = {
    id: deps.random.hex(8),
    state: 'CREATED',
    merchantId: merchant.id,
    merchantAddress,
    itemLabel: input.itemLabel,
    amountLuna: input.amountLuna,
    networkId: deps.config.networkId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + deps.config.orderTtlMs,
    paymentTxHash: null,
    payerAddress: null,
    paidAt: null,
    paymentBlockNumber: null,
    claimedPaymentTxHash: null,
    refundSource: source,
    // The refund always leaves the merchant's own address. For the Demo Store that address
    // is the capped treasury, which is why the Demo Store is the only automatic path.
    refunderAddress: merchantAddress,
    lastError: null,
  };
  return { ok: true, order: await deps.repo.createOrder(order) };
}

export type PaymentHintResult =
  | { ok: true; order: Order }
  | {
      ok: false;
      reason: 'not_found' | 'bad_tx_hash' | 'wrong_state' | 'tx_already_used';
      detail: string;
    };

/**
 * Records the hash the wallet handed back. Moves CREATED -> PAYMENT_PENDING and nothing else.
 *
 * `claimedTxHash` may be null. The provider's `sendBasicTransactionWithData` is documented as
 * returning "the serialized transaction", not a hash, so a real wallet may give the client
 * nothing it can use as a pointer. In that case the order still moves to PAYMENT_PENDING and
 * `verifyOrderPayment` finds the payment by scanning the merchant address for the order's
 * reference. Slower, one more RPC call, and it needs no cooperation from the wallet.
 */
export async function submitPaymentHint(
  deps: DomainDeps,
  orderId: string,
  claimedTxHash: string | null,
): Promise<PaymentHintResult> {
  const hash = claimedTxHash === null ? null : normalizeTxHash(String(claimedTxHash));
  if (claimedTxHash !== null && hash === null) {
    return { ok: false, reason: 'bad_tx_hash', detail: String(claimedTxHash) };
  }

  const order = await deps.repo.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found', detail: orderId };

  // A hint for an order already paid is a no-op, not an error, so a retried request is safe.
  if (order.state !== 'CREATED') {
    if (order.state === 'PAYMENT_PENDING' && order.claimedPaymentTxHash === hash) {
      return { ok: true, order };
    }
    if (hash !== null && order.paymentTxHash === hash) return { ok: true, order };
    return { ok: false, reason: 'wrong_state', detail: order.state };
  }

  if (hash !== null) {
    const owner = await deps.repo.getOrderByPaymentTx(hash);
    if (owner && owner.id !== orderId) {
      return { ok: false, reason: 'tx_already_used', detail: owner.id };
    }
  }

  const updated = await deps.repo.updateOrder(orderId, 'CREATED', {
    state: 'PAYMENT_PENDING',
    claimedPaymentTxHash: hash,
    updatedAt: deps.clock.nowMs(),
    lastError: null,
  });
  if (!updated) {
    const fresh = await deps.repo.getOrder(orderId);
    return { ok: false, reason: 'wrong_state', detail: fresh?.state ?? 'unknown' };
  }
  return { ok: true, order: updated };
}

export type PaymentCheckResult =
  | { status: 'not_found' }
  | { status: 'no_hint'; order: Order }
  | { status: 'already_paid'; order: Order }
  | { status: 'paid'; order: Order; checkedAtMs: number; chainFetchedAtMs: number }
  | {
      status: 'waiting';
      order: Order;
      mismatch: Mismatch;
      message: string;
      chainFetchedAtMs: number;
    }
  | {
      status: 'rejected';
      order: Order;
      mismatch: Mismatch;
      message: string;
      chainFetchedAtMs: number;
    };

/** Mismatches that time cannot fix. Anything else is worth polling for. */
const FATAL_MISMATCHES = new Set([
  'execution_failed',
  'network_mismatch',
  'recipient_mismatch',
  'value_mismatch',
  'data_missing',
  'data_mismatch',
  'sender_equals_recipient',
  'sender_mismatch',
]);

/**
 * Fetches the hinted transaction and applies the acceptance predicate. This is the only
 * function in the codebase that may set PAID.
 */
export async function verifyOrderPayment(
  deps: DomainDeps,
  orderId: string,
): Promise<PaymentCheckResult> {
  const order = await deps.repo.getOrder(orderId);
  if (!order) return { status: 'not_found' };
  if (order.paymentTxHash !== null && order.payerAddress !== null && order.state !== 'PAYMENT_PENDING') {
    return { status: 'already_paid', order };
  }
  const hash = order.claimedPaymentTxHash;
  if (order.state !== 'PAYMENT_PENDING') return { status: 'no_hint', order };

  // Either follow the hint, or find the payment ourselves by its reference.
  const read =
    hash !== null && isValidTxHash(hash)
      ? await deps.chain.getTransactionByHash(hash)
      : await findPaymentByReference(deps, order);
  const now = deps.clock.nowMs();

  if (read.data === null) {
    const mismatch: Mismatch = { kind: 'not_included', expected: 'a block number', got: null };
    return {
      status: 'waiting',
      order,
      mismatch,
      message: describeMismatch(mismatch),
      chainFetchedAtMs: read.fetchedAtMs,
    };
  }

  const result = verifyPayment(
    {
      orderId: order.id,
      recipient: order.merchantAddress,
      amountLuna: order.amountLuna,
      networkId: order.networkId,
      minConfirmations: deps.config.minConfirmations,
    },
    read.data,
  );

  if (!result.ok) {
    const message = describeMismatch(result.mismatch);
    if (FATAL_MISMATCHES.has(result.mismatch.kind)) {
      // Drop back to awaiting payment so the buyer can pay properly. No money is bound here.
      const reverted =
        (await deps.repo.updateOrder(order.id, 'PAYMENT_PENDING', {
          state: 'CREATED',
          claimedPaymentTxHash: null,
          updatedAt: now,
          lastError: `${result.mismatch.kind}: ${message}`,
        })) ?? order;
      return {
        status: 'rejected',
        order: reverted,
        mismatch: result.mismatch,
        message,
        chainFetchedAtMs: read.fetchedAtMs,
      };
    }
    return {
      status: 'waiting',
      order,
      mismatch: result.mismatch,
      message,
      chainFetchedAtMs: read.fetchedAtMs,
    };
  }

  const payer = normalizeAddress(result.accepted.from);
  if (payer === null) {
    const mismatch: Mismatch = {
      kind: 'sender_mismatch',
      expected: 'a well formed address',
      got: result.accepted.from,
    };
    return {
      status: 'rejected',
      order,
      mismatch,
      message: 'The paying address could not be read.',
      chainFetchedAtMs: read.fetchedAtMs,
    };
  }
  if (addressEquals(payer, order.refunderAddress)) {
    // The refund would be a self-transfer, which the protocol refuses. Better to know now.
    const mismatch: Mismatch = {
      kind: 'sender_equals_recipient',
      expected: 'a payer other than the merchant',
      got: payer,
    };
    return {
      status: 'rejected',
      order,
      mismatch,
      message: 'That payment came from the merchant address, so it cannot be refunded to itself.',
      chainFetchedAtMs: read.fetchedAtMs,
    };
  }

  try {
    const updated = await deps.repo.updateOrder(order.id, 'PAYMENT_PENDING', {
      state: 'PAID',
      paymentTxHash: result.accepted.txHash,
      payerAddress: payer,
      paidAt: now,
      paymentBlockNumber: result.accepted.blockNumber,
      updatedAt: now,
      lastError: null,
    });
    if (!updated) {
      const fresh = await deps.repo.getOrder(order.id);
      if (fresh && fresh.state === 'PAID') return { status: 'already_paid', order: fresh };
      return {
        status: 'waiting',
        order: fresh ?? order,
        mismatch: { kind: 'not_included', expected: 'PAYMENT_PENDING', got: fresh?.state ?? null },
        message: 'The order moved while its payment was being verified.',
        chainFetchedAtMs: read.fetchedAtMs,
      };
    }
    return { status: 'paid', order: updated, checkedAtMs: now, chainFetchedAtMs: read.fetchedAtMs };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      // Another order already owns this payment. One order per verified direct payment.
      const mismatch: Mismatch = {
        kind: 'data_mismatch',
        expected: order.id,
        got: 'another order',
      };
      const reverted =
        (await deps.repo.updateOrder(order.id, 'PAYMENT_PENDING', {
          state: 'CREATED',
          claimedPaymentTxHash: null,
          updatedAt: now,
          lastError: 'that payment is already attached to another order',
        })) ?? order;
      return {
        status: 'rejected',
        order: reverted,
        mismatch,
        message: 'That payment is already attached to another order.',
        chainFetchedAtMs: read.fetchedAtMs,
      };
    }
    throw err;
  }
}

/**
 * Finds this order's payment without a hash, by scanning recent transactions to the merchant
 * address for one carrying `RW1:P:<orderId>`. Used when the wallet gave the client no usable
 * hash. It narrows the candidate set only; the same acceptance predicate still decides.
 */
async function findPaymentByReference(
  deps: DomainDeps,
  order: Order,
): Promise<ChainRead<RpcTransaction | null>> {
  const reference = buildReference('P', order.id);
  const page = await deps.chain.getTransactionsByAddress(order.merchantAddress, 50, null);
  const match =
    page.data.find((tx) => {
      const ref = parseReferenceFromHex(tx.recipientData);
      return ref !== null && `${ref.version}:${ref.kind}:${ref.orderId}` === reference;
    }) ?? null;
  return { data: match, fetchedAtMs: page.fetchedAtMs, source: page.source };
}

/** Marks an unpaid, expired order EXPIRED. Never touches an order that has money against it. */
export async function expireOrderIfStale(deps: DomainDeps, orderId: string): Promise<Order | null> {
  const order = await deps.repo.getOrder(orderId);
  if (!order) return null;
  if (order.state !== 'CREATED' && order.state !== 'PAYMENT_PENDING') return order;
  if (deps.clock.nowMs() < order.expiresAt) return order;
  return (
    (await deps.repo.updateOrder(orderId, order.state, {
      state: 'EXPIRED',
      updatedAt: deps.clock.nowMs(),
    })) ?? order
  );
}
