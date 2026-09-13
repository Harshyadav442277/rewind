import { describe, expect, it } from 'vitest';
import { buildReference } from './nimiq';
import { createOrder, submitPaymentHint, verifyOrderPayment } from './order-service';
import { AMOUNT_LUNA, PAYER, createPaidOrder, makeHarness } from './test-helpers';

async function freshOrder(h: ReturnType<typeof makeHarness>) {
  const created = await createOrder(h.deps, {
    merchantId: 'demo-store',
    itemLabel: 'Refund Test — 0.01 NIM',
    amountLuna: AMOUNT_LUNA,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.order;
}

describe('payment verification', () => {
  it('refuses a payment for the wrong amount and says which field disagreed', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);

    const tx = h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA - 1,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    await submitPaymentHint(h.deps, order.id, tx.hash);

    const result = await verifyOrderPayment(h.deps, order.id);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.mismatch.kind).toBe('value_mismatch');
    // No money is bound to a rejected hint, so the order goes back to awaiting payment.
    expect(result.order.state).toBe('CREATED');
    expect(result.order.paymentTxHash).toBeNull();
  });

  it('refuses a payment sent to a different address', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);

    const tx = h.chain.include({
      from: PAYER,
      to: 'NQ13 0THE R000 0000 0000 0000 0000 0000 0003',
      value: AMOUNT_LUNA,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    await submitPaymentHint(h.deps, order.id, tx.hash);

    const result = await verifyOrderPayment(h.deps, order.id);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.mismatch.kind).toBe('recipient_mismatch');
  });

  it('waits, rather than rejecting, while a payment is too shallow', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);

    const tx = h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    await submitPaymentHint(h.deps, order.id, tx.hash);

    const shallow = await verifyOrderPayment(h.deps, order.id);
    expect(shallow.status).toBe('waiting');
    if (shallow.status !== 'waiting') return;
    expect(shallow.mismatch.kind).toBe('insufficient_confirmations');
    expect(shallow.order.state).toBe('PAYMENT_PENDING');

    h.chain.advanceHeight(h.deps.config.minConfirmations);
    expect((await verifyOrderPayment(h.deps, order.id)).status).toBe('paid');
  });

  it('finds the payment by its reference when the wallet gave no usable hash', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);

    h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);

    const hint = await submitPaymentHint(h.deps, order.id, null);
    expect(hint.ok).toBe(true);
    if (!hint.ok) return;
    expect(hint.order.claimedPaymentTxHash).toBeNull();

    const result = await verifyOrderPayment(h.deps, order.id);
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') return;
    expect(result.order.payerAddress).toBe(PAYER);
  });

  it('will not let one payment back two orders', async () => {
    const h = makeHarness();
    const paid = await createPaidOrder(h);
    const second = await freshOrder(h);

    const hint = await submitPaymentHint(h.deps, second.id, paid.paymentTxHash ?? '');
    expect(hint.ok).toBe(false);
    if (hint.ok) return;
    expect(hint.reason).toBe('tx_already_used');
  });

  it('expires an unpaid order rather than leaving it open', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    h.clock.advance(h.deps.config.orderTtlMs + 1);

    const { expireOrderIfStale } = await import('./order-service');
    const expired = await expireOrderIfStale(h.deps, order.id);
    expect(expired?.state).toBe('EXPIRED');
  });
});
