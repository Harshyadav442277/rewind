import { describe, expect, it } from 'vitest';
import {
  buildChallenge,
  checkChallengeAgainstOrder,
  parseChallenge,
  CHALLENGE_HEADER,
} from './challenge.js';
import type { Order } from './types.js';
import { PAYER, TREASURY } from './test-helpers.js';

const PAYMENT_TX = 'a'.repeat(64);
const NONCE = '0123456789abcdef0123456789abcdef';

const VALID = buildChallenge({
  orderId: 'order123456',
  paymentTxHash: PAYMENT_TX,
  amountLuna: 1_000,
  refundTo: PAYER,
  nonce: NONCE,
  expiresAtSec: 1_700_000_300,
});

function paidOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order123456',
    state: 'PAID',
    merchantId: 'demo-store',
    merchantAddress: TREASURY,
    itemLabel: 'Refund Test — 0.01 NIM',
    amountLuna: 1_000,
    networkId: 24,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    paymentTxHash: PAYMENT_TX,
    payerAddress: PAYER,
    paidAt: 0,
    paymentBlockNumber: 1,
    claimedPaymentTxHash: PAYMENT_TX,
    refundSource: 'DEMO_TREASURY',
    refunderAddress: TREASURY,
    lastError: null,
    ...overrides,
  };
}

describe('canonical challenge', () => {
  it('builds exactly seven lines with no trailing newline', () => {
    const lines = VALID.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe(CHALLENGE_HEADER);
    expect(VALID.endsWith('\n')).toBe(false);
    expect(VALID).toContain(`refundTo=${PAYER}`);
  });

  it('round-trips through the parser', () => {
    const parsed = parseChallenge(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.orderId).toBe('order123456');
    expect(parsed.value.amountLuna).toBe(1_000);
    expect(parsed.value.nonce).toBe(NONCE);
    expect(parsed.value.refundTo).toBe(PAYER);
  });

  it.each([
    ['a trailing newline', `${VALID}\n`, 'wrong_line_count'],
    ['a wrong header', VALID.replace(CHALLENGE_HEADER, 'REWIND_REFUND_V2'), 'bad_header'],
    ['reordered fields', reorder(VALID), 'bad_field_order'],
    ['a padded amount', VALID.replace('amountLuna=1000', 'amountLuna=01000'), 'bad_amount'],
    ['a negative amount', VALID.replace('amountLuna=1000', 'amountLuna=-1000'), 'bad_amount'],
    ['a short nonce', VALID.replace(NONCE, 'abc'), 'bad_nonce'],
    ['a lowercase address', VALID.replace(PAYER, PAYER.toLowerCase()), 'bad_refund_to'],
    ['an unspaced address', VALID.replace(PAYER, PAYER.replace(/ /g, '')), 'bad_refund_to'],
    ['a truncated hash', VALID.replace(PAYMENT_TX, 'a'.repeat(63)), 'bad_payment_tx'],
  ])('refuses %s', (_name, text, reason) => {
    const parsed = parseChallenge(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe(reason);
  });

  it('refuses anything that is not a string', () => {
    expect(parseChallenge(undefined).ok).toBe(false);
    expect(parseChallenge({ message: VALID }).ok).toBe(false);
  });
});

describe('challenge against the order', () => {
  const parsed = parseChallenge(VALID);
  if (!parsed.ok) throw new Error('fixture is not parseable');

  it('accepts a matching, unexpired challenge', () => {
    expect(checkChallengeAgainstOrder(parsed.value, paidOrder(), 1_700_000_000)).toEqual({ ok: true });
  });

  it('rejects an expired challenge', () => {
    const result = checkChallengeAgainstOrder(parsed.value, paidOrder(), 1_700_000_301);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('expired');
  });

  it('rejects a challenge whose refundTo is not the verified payer', () => {
    const result = checkChallengeAgainstOrder(
      parsed.value,
      paidOrder({ payerAddress: TREASURY }),
      1_700_000_000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('refund_to_mismatch');
  });

  it('rejects a challenge for an order with no verified payment', () => {
    const result = checkChallengeAgainstOrder(
      parsed.value,
      paidOrder({ paymentTxHash: null, payerAddress: null, state: 'CREATED' }),
      1_700_000_000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('order_not_paid');
  });

  it('rejects an amount that does not match the order', () => {
    const result = checkChallengeAgainstOrder(
      parsed.value,
      paidOrder({ amountLuna: 999 }),
      1_700_000_000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('amount_mismatch');
  });
});

function reorder(text: string): string {
  const lines = text.split('\n');
  const a = lines[2] as string;
  const b = lines[3] as string;
  lines[2] = b;
  lines[3] = a;
  return lines.join('\n');
}
