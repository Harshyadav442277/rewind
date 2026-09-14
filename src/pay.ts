/**
 * Paying for an order, and the small amount of arithmetic a payment link needs.
 *
 * `useOrderPayment` is the one pay flow, shared by the Demo Store and by payment links:
 * create the order, remember it on this device, hand the transfer to the wallet, then tell the
 * server the payment exists. The wallet's three outcomes stay distinct — `cancelled` means
 * nothing was sent, and is never shown as an error.
 */

import { useCallback, useState } from 'react';
import { api, type CreateOrderInput } from './api';
import { navigate } from './App';
import { rememberOrder } from './storage';
import { getWallet } from './wallet';

export const LUNA_PER_NIM = 100_000;
/** The server's cap on a merchant order (`api/orders.ts`): 1 NIM. */
export const MAX_LINK_LUNA = 100_000;
/** The server's cap on an order reference, which a link label becomes. */
export const MAX_LABEL_LENGTH = 40;

export function isPayableLuna(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINK_LUNA;
}

/**
 * "0.01" to 1000. Exact: the text is split at the decimal point rather than multiplied as a
 * float, because 0.29 * 100000 is 28999.999999999996. More than five decimals is not a Luna
 * amount and returns null. A comma is accepted as the decimal point, as phone keyboards in
 * many locales only offer that.
 */
export function nimToLuna(text: string): number | null {
  const match = /^([0-9]*)(?:[.,]([0-9]{0,5}))?$/.exec(text.trim());
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return null;
  const whole = Number(match[1] || '0');
  const fraction = Number((match[2] ?? '').padEnd(5, '0'));
  const luna = whole * LUNA_PER_NIM + fraction;
  return Number.isSafeInteger(luna) ? luna : null;
}

/** 1000 to "0.01 NIM". */
export function formatNim(luna: number): string {
  const whole = Math.floor(luna / LUNA_PER_NIM);
  const fraction = String(luna % LUNA_PER_NIM).padStart(5, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} NIM`;
}

/**
 * Trimmed, then cut to the server's 40 UTF-16 units without splitting a character in half,
 * which would otherwise leave a lone surrogate in the stored reference.
 */
export function clampLabel(text: string): string {
  let out = '';
  for (const char of text.trim()) {
    if (out.length + char.length > MAX_LABEL_LENGTH) break;
    out += char;
  }
  return out.trim();
}

/** The link a merchant shares. The query sits inside the hash; see `parseHash`. */
export function paymentLinkFor(
  origin: string,
  merchantId: string,
  amountLuna: number,
  label: string | null,
): string {
  const base = `${origin}/#/pay/${merchantId}?amount=${amountLuna}`;
  return label ? `${base}&label=${encodeURIComponent(label)}` : base;
}

export type PayPhase = 'idle' | 'working' | 'cancelled' | 'error';

export function useOrderPayment() {
  const [phase, setPhase] = useState<PayPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  /** An order that exists but was never paid, because the wallet dialog was cancelled. */
  const [unpaidOrderId, setUnpaidOrderId] = useState<string | null>(null);

  /** Left out, `input` creates the single Demo Store item. */
  const pay = useCallback(async (input?: CreateOrderInput) => {
    setPhase('working');
    setError(null);
    setUnpaidOrderId(null);
    try {
      setStep('Creating the order…');
      const { order } = await api.createOrder(input);
      setUnpaidOrderId(order.id);
      rememberOrder({
        id: order.id,
        label: order.itemLabel,
        amountLuna: order.amountLuna,
        createdAtMs: Date.now(),
      });

      setStep('Waiting for your wallet…');
      // The reference is what ties this transfer to this order on chain. 64 byte limit.
      const sent = await getWallet().sendPayment({
        recipient: order.merchantAddress,
        value: order.amountLuna,
        data: order.paymentReference,
      });

      if (sent.status === 'cancelled') {
        setPhase('cancelled');
        setStep(null);
        return;
      }
      if (sent.status === 'error') {
        setError(sent.message);
        setPhase('error');
        setStep(null);
        return;
      }

      setStep('Checking the chain…');
      // Only a real hash is a usable pointer. A serialised transaction is not, and the
      // server then finds the payment by scanning the merchant address for the reference.
      await api.submitPayment(order.id, sent.value.txHash);
      navigate({ name: 'order', id: order.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      setStep(null);
      setPhase((current) => (current === 'working' ? 'idle' : current));
    }
  }, []);

  return { phase, error, step, unpaidOrderId, busy: phase === 'working', pay };
}
