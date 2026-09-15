import { describe, expect, it } from 'vitest';
import { buildReference } from './nimiq.js';
import { ChainUnavailableError } from './ports.js';
import { createOrder, submitPaymentHint, verifyOrderPayment } from './order-service.js';
import { AMOUNT_LUNA, PAYER, createPaidOrder, makeHarness } from './test-helpers.js';

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

  it('falls back to the reference scan when the node cannot answer for the hinted hash', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);

    const tx = h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    await submitPaymentHint(h.deps, order.id, tx.hash);

    const chain = h.deps.chain;
    const blind = Object.create(chain);
    blind.getTransactionByHash = async () => {
      throw new ChainUnavailableError('Transaction not found');
    };
    const deps = { ...h.deps, chain: blind };

    const result = await verifyOrderPayment(deps, order.id);
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') return;
    expect(result.order.paymentTxHash).toBe(tx.hash);
  });

  it('finds the real payment when the hinted hash does not exist on chain', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    // Anyone who knows the order id can post a hash that will never exist, before the buyer's
    // client posts the real one.
    const bogus = 'b'.repeat(64);
    expect((await submitPaymentHint(h.deps, order.id, bogus)).ok).toBe(true);

    const tx = h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);

    // The buyer's own hint arrives second. It is accepted as a no-op, not refused.
    const second = await submitPaymentHint(h.deps, order.id, tx.hash);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.order.claimedPaymentTxHash).toBe(bogus);

    const result = await verifyOrderPayment(h.deps, order.id);
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') return;
    expect(result.order.paymentTxHash).toBe(tx.hash);
    expect(result.order.payerAddress).toBe(PAYER);
  });

  it('keeps waiting, without rejecting, when neither the hint nor the scan finds a payment', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    await submitPaymentHint(h.deps, order.id, 'c'.repeat(64));

    const result = await verifyOrderPayment(h.deps, order.id);
    expect(result.status).toBe('waiting');
    if (result.status !== 'waiting') return;
    expect(result.mismatch.kind).toBe('not_included');
    expect((await h.deps.repo.getOrder(order.id))?.state).toBe('PAYMENT_PENDING');
  });

  it('does not accept a scanned payment that fails the acceptance predicate', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    await submitPaymentHint(h.deps, order.id, 'd'.repeat(64));
    h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA + 1,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);

    const result = await verifyOrderPayment(h.deps, order.id);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.mismatch.kind).toBe('value_mismatch');
    expect(result.order.paymentTxHash).toBeNull();
  });

  it('stays unavailable when the hash lookup fails and the scan finds nothing', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    await submitPaymentHint(h.deps, order.id, 'a'.repeat(64));

    const blind = Object.create(h.deps.chain);
    blind.getTransactionByHash = async () => {
      throw new ChainUnavailableError('Transaction not found');
    };

    await expect(verifyOrderPayment({ ...h.deps, chain: blind }, order.id)).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );
    expect((await h.deps.repo.getOrder(order.id))?.state).toBe('PAYMENT_PENDING');
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

    const { expireOrderIfStale } = await import('./order-service.js');
    const expired = await expireOrderIfStale(h.deps, order.id);
    expect(expired?.state).toBe('EXPIRED');
  });

  it('does not expire a stale order whose payment is on chain, and marks it paid instead', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    const tx = h.chain.include({
      from: PAYER,
      to: order.merchantAddress,
      value: AMOUNT_LUNA,
      data: buildReference('P', order.id),
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    // The wallet reported the hash, but nothing read the chain before the order went stale.
    await submitPaymentHint(h.deps, order.id, tx.hash);
    h.clock.advance(h.deps.config.orderTtlMs + 1);

    const { expireOrderIfStale } = await import('./order-service.js');
    const result = await expireOrderIfStale(h.deps, order.id);
    expect(result?.state).toBe('PAID');
    expect((await h.deps.repo.getOrder(order.id))?.state).toBe('PAID');
  });

  it('keeps a stale order waiting while its payment is on chain but still shallow', async () => {
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
    h.clock.advance(h.deps.config.orderTtlMs + 1);

    const { expireOrderIfStale } = await import('./order-service.js');
    const result = await expireOrderIfStale(h.deps, order.id);
    expect(result?.state).toBe('PAYMENT_PENDING');
  });

  it('expires a stale order whose reported payment is nowhere on chain', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    await submitPaymentHint(h.deps, order.id, 'e'.repeat(64));
    h.clock.advance(h.deps.config.orderTtlMs + 1);

    const { expireOrderIfStale } = await import('./order-service.js');
    const result = await expireOrderIfStale(h.deps, order.id);
    expect(result?.state).toBe('EXPIRED');
  });

  it('leaves a stale order alone when the chain cannot be read', async () => {
    const h = makeHarness();
    const order = await freshOrder(h);
    await submitPaymentHint(h.deps, order.id, 'f'.repeat(64));
    h.clock.advance(h.deps.config.orderTtlMs + 1);
    const blind = Object.create(h.deps.chain);
    blind.getTransactionByHash = async () => {
      throw new ChainUnavailableError('Transaction not found');
    };

    const { expireOrderIfStale } = await import('./order-service.js');
    await expect(expireOrderIfStale({ ...h.deps, chain: blind }, order.id)).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );
    expect((await h.deps.repo.getOrder(order.id))?.state).toBe('PAYMENT_PENDING');
  });
});
