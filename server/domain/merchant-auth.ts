/**
 * Merchant authentication: a wallet signature over a short-lived, action-bound challenge.
 *
 * The problem it closes is gap S1 — `api/merchant/refunds.ts` had no authentication at all, so
 * anyone who could reach it could approve a refund out of the capped treasury.
 *
 * Canonical form, seven lines, `\n` separated, no trailing newline, exactly like the buyer's
 * refund challenge in `challenge.ts` and for the same reason: what the wallet displays, what
 * the merchant signs and what the server checks are the same bytes.
 *
 *   REWIND_MERCHANT_V1
 *   merchant=<merchantId>
 *   address=<merchant address, canonical user-friendly form>
 *   action=<approve|reject|record-tx>
 *   order=<orderId>
 *   issued=<unix seconds>
 *   expires=<unix seconds>
 *
 * The challenge text itself is stateless — it binds one action to one order and expires in
 * `MAX_MERCHANT_CHALLENGE_TTL_SEC` — but it is no longer only that. Gap S3 is closed one
 * layer out, in `api/_lib/merchant-auth.ts` and the `merchant_nonces` table: the server
 * records a challenge when it issues it and consumes the row when it accepts the signature,
 * keyed by the SHA-256 of these exact bytes. A replay inside the window finds a consumed row
 * and is refused. The text is deliberately unchanged, because it is what a wallet displays.
 *
 * A `list` challenge is the exception: it is a read, it changes nothing, and it is NOT
 * consumed, so one signature can back the merchant board's polling for its whole window.
 */

import { isValidAddress, isValidOrderId, normalizeAddress } from './nimiq.js';

export const MERCHANT_CHALLENGE_HEADER = 'REWIND_MERCHANT_V1';
export const DEFAULT_MERCHANT_CHALLENGE_TTL_SEC = 120;
export const MAX_MERCHANT_CHALLENGE_TTL_SEC = 300;

/**
 * `list` is a read: it authenticates `GET /api/merchant/refunds` and scopes the answer to the
 * merchant bound in the text. It is bound to no order, so it uses `LIST_ORDER_SENTINEL`,
 * which is shape-valid (the parser is unchanged) and which a generated order id will not be.
 */
export const MERCHANT_ACTIONS = ['approve', 'reject', 'record-tx', 'list'] as const;
export type MerchantAction = (typeof MERCHANT_ACTIONS)[number];

/** The `order=` value of a challenge that is not bound to one order. */
export const LIST_ORDER_SENTINEL = '0000000000000000';

/** Actions that change state. These consume their nonce; `list` does not. */
export function isStateChangingAction(action: MerchantAction): boolean {
  return action !== 'list';
}

const MERCHANT_ID_RE = /^[0-9a-z][0-9a-z-]{1,38}[0-9a-z]$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;

const FIELD_ORDER = ['merchant', 'address', 'action', 'order', 'issued', 'expires'] as const;

export interface MerchantChallenge {
  merchantId: string;
  address: string;
  action: MerchantAction;
  orderId: string;
  issuedAtSec: number;
  expiresAtSec: number;
}

export type MerchantChallengeParseFailure =
  | 'not_a_string'
  | 'wrong_line_count'
  | 'bad_header'
  | 'bad_field_order'
  | 'bad_merchant'
  | 'bad_address'
  | 'bad_action'
  | 'bad_order_id'
  | 'bad_issued'
  | 'bad_expires';

export type MerchantChallengeParseResult =
  | { ok: true; value: MerchantChallenge }
  | { ok: false; reason: MerchantChallengeParseFailure; detail: string };

export function isMerchantAction(value: unknown): value is MerchantAction {
  return typeof value === 'string' && (MERCHANT_ACTIONS as readonly string[]).includes(value);
}

/** Throws rather than emitting text the validator would refuse. */
export function buildMerchantChallenge(input: MerchantChallenge): string {
  const address = normalizeAddress(input.address);
  if (address === null) throw new Error(`buildMerchantChallenge: invalid address ${input.address}`);
  if (!MERCHANT_ID_RE.test(input.merchantId)) {
    throw new Error('buildMerchantChallenge: invalid merchantId');
  }
  if (!isMerchantAction(input.action)) throw new Error('buildMerchantChallenge: invalid action');
  if (!isValidOrderId(input.orderId)) throw new Error('buildMerchantChallenge: invalid orderId');
  if (!Number.isSafeInteger(input.issuedAtSec) || input.issuedAtSec <= 0) {
    throw new Error('buildMerchantChallenge: issuedAtSec must be a positive integer');
  }
  if (!Number.isSafeInteger(input.expiresAtSec) || input.expiresAtSec <= input.issuedAtSec) {
    throw new Error('buildMerchantChallenge: expiresAtSec must be after issuedAtSec');
  }
  return [
    MERCHANT_CHALLENGE_HEADER,
    `merchant=${input.merchantId}`,
    `address=${address}`,
    `action=${input.action}`,
    `order=${input.orderId}`,
    `issued=${input.issuedAtSec}`,
    `expires=${input.expiresAtSec}`,
  ].join('\n');
}

/** Strict parser. Never repairs, never trims, never reorders. */
export function parseMerchantChallenge(message: unknown): MerchantChallengeParseResult {
  if (typeof message !== 'string') {
    return { ok: false, reason: 'not_a_string', detail: typeof message };
  }
  const lines = message.split('\n');
  if (lines.length !== 7) {
    return { ok: false, reason: 'wrong_line_count', detail: `${lines.length} lines, expected 7` };
  }
  if (lines[0] !== MERCHANT_CHALLENGE_HEADER) {
    return { ok: false, reason: 'bad_header', detail: String(lines[0]) };
  }

  const values: Record<string, string> = {};
  for (let i = 0; i < FIELD_ORDER.length; i++) {
    const expectedKey = FIELD_ORDER[i] as string;
    const line = lines[i + 1] as string;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq) !== expectedKey) {
      return {
        ok: false,
        reason: 'bad_field_order',
        detail: `line ${i + 2}: expected ${expectedKey}=`,
      };
    }
    values[expectedKey] = line.slice(eq + 1);
  }

  const merchantId = values.merchant as string;
  if (!MERCHANT_ID_RE.test(merchantId)) {
    return { ok: false, reason: 'bad_merchant', detail: merchantId };
  }
  const address = values.address as string;
  // Must already be canonical: the signature covers these bytes, so we do not normalise.
  if (!isValidAddress(address)) return { ok: false, reason: 'bad_address', detail: address };

  const action = values.action as string;
  if (!isMerchantAction(action)) return { ok: false, reason: 'bad_action', detail: action };

  const orderId = values.order as string;
  if (!isValidOrderId(orderId)) return { ok: false, reason: 'bad_order_id', detail: orderId };

  const issuedRaw = values.issued as string;
  if (!DECIMAL_RE.test(issuedRaw)) return { ok: false, reason: 'bad_issued', detail: issuedRaw };
  const issuedAtSec = Number(issuedRaw);
  if (!Number.isSafeInteger(issuedAtSec) || issuedAtSec <= 0) {
    return { ok: false, reason: 'bad_issued', detail: issuedRaw };
  }

  const expiresRaw = values.expires as string;
  if (!DECIMAL_RE.test(expiresRaw)) return { ok: false, reason: 'bad_expires', detail: expiresRaw };
  const expiresAtSec = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtSec) || expiresAtSec <= 0) {
    return { ok: false, reason: 'bad_expires', detail: expiresRaw };
  }

  return { ok: true, value: { merchantId, address, action, orderId, issuedAtSec, expiresAtSec } };
}

export type MerchantAuthFailure =
  | MerchantChallengeParseFailure
  | 'unknown_merchant'
  | 'address_mismatch'
  | 'action_mismatch'
  | 'order_mismatch'
  | 'expired'
  | 'ttl_too_long'
  | 'issued_in_future'
  | 'bad_signature'
  | 'not_the_merchant_wallet'
  /** The server has no record of ever issuing this text. */
  | 'unknown_nonce'
  /** The text was issued, signed and already used. Gap S3's replay case. */
  | 'nonce_already_used';

export type MerchantAuthResult =
  | { ok: true; challenge: MerchantChallenge; signerAddress: string }
  | { ok: false; reason: MerchantAuthFailure; detail: string };

export interface MerchantAuthExpectation {
  merchantId: string;
  /** The merchant's address as the server knows it, not as the message claims. */
  merchantAddress: string;
  action: MerchantAction;
  orderId: string;
  nowSec: number;
}

/**
 * Checks a parsed challenge against what the request actually asks for and against the clock.
 * The signature itself is checked by the caller, which owns the `SignatureVerifier`; this
 * function then compares the recovered address.
 */
export function checkMerchantChallenge(
  parsed: MerchantChallenge,
  expected: MerchantAuthExpectation,
): { ok: true } | { ok: false; reason: MerchantAuthFailure; detail: string } {
  if (parsed.merchantId !== expected.merchantId) {
    return {
      ok: false,
      reason: 'unknown_merchant',
      detail: `${parsed.merchantId} != ${expected.merchantId}`,
    };
  }
  if (normalizeAddress(parsed.address) !== normalizeAddress(expected.merchantAddress)) {
    return {
      ok: false,
      reason: 'address_mismatch',
      detail: `${parsed.address} != ${expected.merchantAddress}`,
    };
  }
  if (parsed.action !== expected.action) {
    return { ok: false, reason: 'action_mismatch', detail: `${parsed.action} != ${expected.action}` };
  }
  if (parsed.orderId !== expected.orderId) {
    return { ok: false, reason: 'order_mismatch', detail: `${parsed.orderId} != ${expected.orderId}` };
  }
  if (parsed.expiresAtSec <= expected.nowSec) {
    return {
      ok: false,
      reason: 'expired',
      detail: `expired ${expected.nowSec - parsed.expiresAtSec}s ago`,
    };
  }
  if (parsed.expiresAtSec - expected.nowSec > MAX_MERCHANT_CHALLENGE_TTL_SEC) {
    // A merchant who could choose the expiry could mint a permanent credential.
    return {
      ok: false,
      reason: 'ttl_too_long',
      detail: `${parsed.expiresAtSec - expected.nowSec}s > ${MAX_MERCHANT_CHALLENGE_TTL_SEC}s`,
    };
  }
  if (parsed.issuedAtSec > expected.nowSec + 60) {
    return {
      ok: false,
      reason: 'issued_in_future',
      detail: `${parsed.issuedAtSec - expected.nowSec}s ahead`,
    };
  }
  return { ok: true };
}
