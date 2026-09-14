/**
 * What this device remembers, and nothing else: the orders it created, the merchant it
 * registered, and which refunds it already handed to the wallet.
 *
 * None of it is evidence. The server and the chain are the record; this is a convenience so a
 * buyer can find an order again and a merchant does not re-register on every visit. Storage
 * can be missing, full or blocked (private tabs, some WebViews), and `window.localStorage`
 * itself can throw on access, so every read and write is wrapped and a failure reads as
 * "nothing remembered".
 */

import type { RegisteredMerchant } from './api';

export const ORDERS_KEY = 'rewind.orders';
export const MERCHANT_KEY = 'rewind.merchant';
export const SENT_REFUNDS_KEY = 'rewind.sentRefunds';
export const MAX_REMEMBERED_ORDERS = 20;

export interface RememberedOrder {
  id: string;
  label: string;
  amountLuna: number;
  createdAtMs: number;
}

function readJson(key: string): unknown {
  try {
    const text = window.localStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered. Nothing depends on it.
  }
}

function isRememberedOrder(value: unknown): value is RememberedOrder {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.amountLuna === 'number' &&
    typeof v.createdAtMs === 'number'
  );
}

/** Newest first. Anything malformed is dropped rather than rendered. */
export function readOrders(): RememberedOrder[] {
  const stored = readJson(ORDERS_KEY);
  return Array.isArray(stored) ? stored.filter(isRememberedOrder) : [];
}

export function rememberOrder(order: RememberedOrder): void {
  const rest = readOrders().filter((o) => o.id !== order.id);
  writeJson(ORDERS_KEY, [order, ...rest].slice(0, MAX_REMEMBERED_ORDERS));
}

export function readSavedMerchant(): RegisteredMerchant | null {
  const stored = readJson(MERCHANT_KEY);
  if (typeof stored !== 'object' || stored === null) return null;
  const v = stored as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.address === 'string'
    ? { id: v.id, name: v.name, address: v.address }
    : null;
}

export function saveMerchant(merchant: RegisteredMerchant | null): void {
  writeJson(
    MERCHANT_KEY,
    merchant === null ? null : { id: merchant.id, name: merchant.name, address: merchant.address },
  );
}

/** Order id to when this device handed its refund to the wallet, in ms. */
export function readSentRefunds(): Record<string, number> {
  const stored = readJson(SENT_REFUNDS_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

export function rememberSentRefund(orderId: string, atMs: number): void {
  // Oldest dropped first, so the map cannot grow without bound.
  const entries = Object.entries({ ...readSentRefunds(), [orderId]: atMs })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);
  writeJson(SENT_REFUNDS_KEY, Object.fromEntries(entries));
}
