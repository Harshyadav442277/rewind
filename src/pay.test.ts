/**
 * The payment link, end to end on paper: the amount a merchant types, the URL built from it,
 * and the route the buyer's app parses back out of that URL. Offline and wallet-free.
 */

import { describe, expect, it } from 'vitest';
import { hashFor, parseHash } from './App';
import { clampLabel, formatNim, isPayableLuna, nimToLuna, paymentLinkFor } from './pay';

describe('nimToLuna', () => {
  it.each([
    ['0.01', 1_000],
    ['1', 100_000],
    ['0.29', 29_000],
    ['0,5', 50_000],
    ['.5', 50_000],
    ['5.', 500_000],
    ['0.00001', 1],
    [' 0.02 ', 2_000],
  ])('%s NIM is %i Luna', (text, luna) => {
    expect(nimToLuna(text)).toBe(luna);
  });

  it.each(['', '.', 'abc', '-1', '0.000001', '1e3', '1.2.3'])('refuses %j', (text) => {
    expect(nimToLuna(text)).toBeNull();
  });
});

describe('amount helpers', () => {
  it('formats Luna as NIM without float noise', () => {
    expect(formatNim(1_000)).toBe('0.01 NIM');
    expect(formatNim(100_000)).toBe('1 NIM');
    expect(formatNim(29_000)).toBe('0.29 NIM');
    expect(formatNim(1)).toBe('0.00001 NIM');
  });

  it('accepts only whole Luna from 1 to 1 NIM', () => {
    expect(isPayableLuna(1)).toBe(true);
    expect(isPayableLuna(100_000)).toBe(true);
    expect(isPayableLuna(0)).toBe(false);
    expect(isPayableLuna(100_001)).toBe(false);
    expect(isPayableLuna(1.5)).toBe(false);
    expect(isPayableLuna(null)).toBe(false);
  });

  it('cuts a label to 40 UTF-16 units without splitting a character', () => {
    expect(clampLabel('  Table 4  ')).toBe('Table 4');
    expect(clampLabel('x'.repeat(50))).toHaveLength(40);
    const emoji = String.fromCodePoint(0x1f375);
    const clamped = clampLabel(`${'x'.repeat(39)}${emoji}`);
    expect(clamped).toBe('x'.repeat(39));
  });
});

describe('payment link route', () => {
  const ID = 'w-nq12shop0000000000000000000000000001';

  it('parses the link the merchant screen builds back into the same amount and label', () => {
    const label = 'Table 4 & a flat white / 50% off?';
    const link = paymentLinkFor('https://rewind.example', ID, 1_000, label);
    const hash = link.slice(link.indexOf('#'));
    expect(parseHash(hash)).toEqual({ name: 'pay', merchantId: ID, amountLuna: 1_000, label });
  });

  it('carries a missing or non-integer amount as null, for the Pay screen to refuse', () => {
    expect(parseHash(`#/pay/${ID}`)).toEqual({ name: 'pay', merchantId: ID, amountLuna: null, label: null });
    expect(parseHash(`#/pay/${ID}?amount=1.5`)).toMatchObject({ amountLuna: null });
    expect(parseHash(`#/pay/${ID}?amount=-3`)).toMatchObject({ amountLuna: null });
    expect(parseHash(`#/pay/${ID}?amount=`)).toMatchObject({ amountLuna: null });
    // Out of range is still a number; the screen decides it is not payable.
    expect(parseHash(`#/pay/${ID}?amount=100001`)).toMatchObject({ amountLuna: 100_001 });
  });

  it('treats a blank label as no label', () => {
    expect(parseHash(`#/pay/${ID}?amount=1000&label=%20%20`)).toMatchObject({ label: null });
  });

  it('keeps the other routes as they were', () => {
    expect(parseHash('#/order/abc')).toEqual({ name: 'order', id: 'abc' });
    expect(parseHash('#/merchant')).toEqual({ name: 'merchant' });
    expect(parseHash('#/pay')).toEqual({ name: 'store' });
    expect(parseHash('')).toEqual({ name: 'store' });
  });

  it('round-trips a pay route through hashFor', () => {
    const route = { name: 'pay' as const, merchantId: ID, amountLuna: 2_500, label: 'Table 4' };
    expect(parseHash(hashFor(route))).toEqual(route);
  });
});
