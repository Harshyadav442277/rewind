import { describe, expect, it } from 'vitest';
import { buildReference, utf8ToHex, type RpcTransaction } from './nimiq.js';
import { verifyPayment, verifyRefund, type TransferExpectation } from './verify.js';
import { OTHER, PAYER, TREASURY } from './test-helpers.js';

const ORDER_ID = 'order123456';

const expectation: TransferExpectation = {
  orderId: ORDER_ID,
  recipient: TREASURY,
  amountLuna: 1_000,
  networkId: 24,
  minConfirmations: 2,
};

function tx(overrides: Partial<RpcTransaction> = {}): RpcTransaction {
  return {
    hash: 'b'.repeat(64),
    blockNumber: 61_420_752,
    timestamp: 1_789_229_039_990,
    confirmations: 30,
    from: PAYER,
    to: TREASURY,
    value: 1_000,
    fee: 0,
    recipientData: utf8ToHex(buildReference('P', ORDER_ID)),
    validityStartHeight: 61_420_752,
    executionResult: true,
    networkId: 24,
    ...overrides,
  };
}

describe('verifyPayment', () => {
  it('accepts a transaction that matches on every field', () => {
    const result = verifyPayment(expectation, tx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted.from).toBe(PAYER);
    expect(result.accepted.valueLuna).toBe(1_000);
    expect(result.accepted.blockNumber).toBe(61_420_752);
  });

  it.each<[string, Partial<RpcTransaction>, string]>([
    ['a wrong recipient', { to: OTHER }, 'recipient_mismatch'],
    ['an underpayment', { value: 999 }, 'value_mismatch'],
    ['an overpayment', { value: 1_001 }, 'value_mismatch'],
    ['no data field', { recipientData: undefined }, 'data_missing'],
    ['a reference for another order', { recipientData: utf8ToHex('RW1:P:otherorder1') }, 'data_mismatch'],
    ['a refund reference on a payment', { recipientData: utf8ToHex(`RW1:R:${ORDER_ID}`) }, 'data_mismatch'],
    ['junk in the data field', { recipientData: utf8ToHex('hello') }, 'data_mismatch'],
    ['a failed execution', { executionResult: false }, 'execution_failed'],
    ['the wrong network', { networkId: 5 }, 'network_mismatch'],
    ['no block', { blockNumber: null }, 'not_included'],
    ['too few confirmations', { confirmations: 1 }, 'insufficient_confirmations'],
    ['sender equal to recipient', { from: TREASURY }, 'sender_equals_recipient'],
  ])('rejects %s with the right reason', (_name, overrides, kind) => {
    const result = verifyPayment(expectation, tx(overrides));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.kind).toBe(kind);
  });

  it('reports the expected and the observed value on an amount mismatch', () => {
    const result = verifyPayment(expectation, tx({ value: 999 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.expected).toBe('1000');
    expect(result.mismatch.got).toBe('999');
  });

  it('treats an address written without spaces as the same address', () => {
    const result = verifyPayment(expectation, tx({ to: TREASURY.replace(/ /g, '') }));
    expect(result.ok).toBe(true);
  });

  it('binds the sender when one is expected', () => {
    const bound = { ...expectation, expectedSender: OTHER };
    const result = verifyPayment(bound, tx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.kind).toBe('sender_mismatch');
  });
});

describe('verifyRefund', () => {
  const refundExpectation = {
    orderId: ORDER_ID,
    recipient: PAYER,
    amountLuna: 1_000,
    networkId: 24,
    minConfirmations: 2,
    expectedSender: TREASURY,
  };

  const refundTx = (overrides: Partial<RpcTransaction> = {}): RpcTransaction =>
    tx({
      from: TREASURY,
      to: PAYER,
      recipientData: utf8ToHex(buildReference('R', ORDER_ID)),
      ...overrides,
    });

  it('accepts a matching refund', () => {
    expect(verifyRefund(refundExpectation, refundTx()).ok).toBe(true);
  });

  it('rejects a refund sent to somebody other than the payer', () => {
    const result = verifyRefund(refundExpectation, refundTx({ to: OTHER }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.kind).toBe('recipient_mismatch');
  });

  it('rejects a refund sent from an unexpected wallet', () => {
    const result = verifyRefund(refundExpectation, refundTx({ from: OTHER }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.kind).toBe('sender_mismatch');
  });

  it('rejects a partial refund', () => {
    const result = verifyRefund(refundExpectation, refundTx({ value: 500 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.kind).toBe('value_mismatch');
  });

  it('rejects a payment reference where a refund reference is required', () => {
    const result = verifyRefund(
      refundExpectation,
      refundTx({ recipientData: utf8ToHex(buildReference('P', ORDER_ID)) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatch.kind).toBe('data_mismatch');
  });
});
