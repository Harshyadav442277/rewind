/**
 * The one-time refund challenge.
 *
 * The buyer signs this exact text inside Nimiq Pay with `window.nimiq.sign()`. The server
 * then checks three separate things, and all three must hold:
 *   1. the text parses as a canonical challenge and matches a stored, unconsumed nonce,
 *   2. the signature verifies over that exact text,
 *   3. the address recovered from the signature equals `refundTo`, the refund destination
 *      resolved from the chain when the challenge was issued (the payer, or the wallet that
 *      funded the payer's HTLC; `resolveRefundDestination`).
 *
 * Canonical form, seven lines, `\n` separated, no trailing newline:
 *
 *   REWIND_REFUND_V1
 *   order=<id>
 *   paymentTx=<hash>
 *   amountLuna=<n>
 *   refundTo=<address>
 *   nonce=<random>
 *   expires=<unix seconds>
 *
 * The text is canonical on purpose: what the wallet displays, what the buyer signs and what
 * the server checks are the same bytes. Anything that is not byte-exact is refused rather
 * than normalised, because normalising a signed message is how signature checks get bypassed.
 */

import {
  isValidAddress,
  isValidOrderId,
  isValidTxHash,
  normalizeAddress,
} from './nimiq.js';
import type { Order } from './types.js';

export const CHALLENGE_HEADER = 'REWIND_REFUND_V1';
export const DEFAULT_CHALLENGE_TTL_SEC = 300;
export const MAX_CHALLENGE_TTL_SEC = 900;

const NONCE_RE = /^[0-9a-f]{32}$/;
/** Canonical unsigned decimal: no sign, no leading zero, no separators. */
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;

export interface ParsedChallenge {
  orderId: string;
  paymentTxHash: string;
  amountLuna: number;
  refundTo: string;
  nonce: string;
  expiresAtSec: number;
}

export type ChallengeParseFailure =
  | 'not_a_string'
  | 'wrong_line_count'
  | 'bad_header'
  | 'bad_field_order'
  | 'bad_order_id'
  | 'bad_payment_tx'
  | 'bad_amount'
  | 'bad_refund_to'
  | 'bad_nonce'
  | 'bad_expires';

export type ChallengeParseResult =
  | { ok: true; value: ParsedChallenge }
  | { ok: false; reason: ChallengeParseFailure; detail: string };

const FIELD_ORDER = ['order', 'paymentTx', 'amountLuna', 'refundTo', 'nonce', 'expires'] as const;

export interface BuildChallengeInput {
  orderId: string;
  paymentTxHash: string;
  amountLuna: number;
  refundTo: string;
  nonce: string;
  expiresAtSec: number;
}

/**
 * Builds the canonical text. Throws on invalid input rather than emitting something the
 * validator would later refuse, so a malformed challenge can never be shown to a buyer.
 */
export function buildChallenge(input: BuildChallengeInput): string {
  const refundTo = normalizeAddress(input.refundTo);
  if (refundTo === null) throw new Error(`buildChallenge: invalid refundTo ${input.refundTo}`);
  if (!isValidOrderId(input.orderId)) throw new Error('buildChallenge: invalid orderId');
  if (!isValidTxHash(input.paymentTxHash)) throw new Error('buildChallenge: invalid paymentTxHash');
  if (!Number.isSafeInteger(input.amountLuna) || input.amountLuna <= 0) {
    throw new Error('buildChallenge: amountLuna must be a positive integer');
  }
  if (!NONCE_RE.test(input.nonce)) throw new Error('buildChallenge: nonce must be 32 lowercase hex');
  if (!Number.isSafeInteger(input.expiresAtSec) || input.expiresAtSec <= 0) {
    throw new Error('buildChallenge: expiresAtSec must be a positive integer');
  }

  return [
    CHALLENGE_HEADER,
    `order=${input.orderId}`,
    `paymentTx=${input.paymentTxHash}`,
    `amountLuna=${input.amountLuna}`,
    `refundTo=${refundTo}`,
    `nonce=${input.nonce}`,
    `expires=${input.expiresAtSec}`,
  ].join('\n');
}

/** Strict parser. Never repairs, never trims, never reorders. */
export function parseChallenge(message: unknown): ChallengeParseResult {
  if (typeof message !== 'string') {
    return { ok: false, reason: 'not_a_string', detail: typeof message };
  }
  const lines = message.split('\n');
  if (lines.length !== 7) {
    return { ok: false, reason: 'wrong_line_count', detail: `${lines.length} lines, expected 7` };
  }
  if (lines[0] !== CHALLENGE_HEADER) {
    return { ok: false, reason: 'bad_header', detail: String(lines[0]) };
  }

  const values: Record<string, string> = {};
  for (let i = 0; i < FIELD_ORDER.length; i++) {
    const expectedKey = FIELD_ORDER[i] as string;
    const line = lines[i + 1] as string;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq) !== expectedKey) {
      return { ok: false, reason: 'bad_field_order', detail: `line ${i + 2}: expected ${expectedKey}=` };
    }
    values[expectedKey] = line.slice(eq + 1);
  }

  const orderId = values.order as string;
  if (!isValidOrderId(orderId)) return { ok: false, reason: 'bad_order_id', detail: orderId };

  const paymentTxHash = values.paymentTx as string;
  if (!isValidTxHash(paymentTxHash)) {
    return { ok: false, reason: 'bad_payment_tx', detail: paymentTxHash };
  }

  const amountRaw = values.amountLuna as string;
  if (!DECIMAL_RE.test(amountRaw)) return { ok: false, reason: 'bad_amount', detail: amountRaw };
  const amountLuna = Number(amountRaw);
  if (!Number.isSafeInteger(amountLuna) || amountLuna <= 0) {
    return { ok: false, reason: 'bad_amount', detail: amountRaw };
  }

  const refundTo = values.refundTo as string;
  // Must already be canonical: the signature covers these bytes, so we do not normalise.
  if (!isValidAddress(refundTo)) return { ok: false, reason: 'bad_refund_to', detail: refundTo };

  const nonce = values.nonce as string;
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: 'bad_nonce', detail: nonce };

  const expiresRaw = values.expires as string;
  if (!DECIMAL_RE.test(expiresRaw)) return { ok: false, reason: 'bad_expires', detail: expiresRaw };
  const expiresAtSec = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtSec) || expiresAtSec <= 0) {
    return { ok: false, reason: 'bad_expires', detail: expiresRaw };
  }

  return {
    ok: true,
    value: { orderId, paymentTxHash, amountLuna, refundTo, nonce, expiresAtSec },
  };
}

export type ChallengeCheckFailure =
  | 'expired'
  | 'order_mismatch'
  | 'payment_tx_mismatch'
  | 'amount_mismatch'
  | 'refund_to_mismatch'
  | 'order_not_paid'
  | 'ttl_too_long';

export type ChallengeCheckResult =
  | { ok: true }
  | { ok: false; reason: ChallengeCheckFailure; detail: string };

/**
 * Checks a parsed challenge against the order it claims to be for and against the clock.
 * Nonce replay is NOT checked here — that is a repository uniqueness question and lives in
 * the reservation service, because only the database can settle it under concurrency.
 */
export function checkChallengeAgainstOrder(
  parsed: ParsedChallenge,
  order: Order,
  nowSec: number,
  /**
   * The refund destination resolved from the chain when the challenge was issued: the payer,
   * or the wallet that funded the payer's HTLC. Defaults to the payer.
   */
  expectedRefundTo: string | null = order.payerAddress,
): ChallengeCheckResult {
  if (parsed.orderId !== order.id) {
    return { ok: false, reason: 'order_mismatch', detail: `${parsed.orderId} != ${order.id}` };
  }
  if (order.paymentTxHash === null || order.payerAddress === null) {
    return { ok: false, reason: 'order_not_paid', detail: order.state };
  }
  if (parsed.paymentTxHash !== order.paymentTxHash) {
    return {
      ok: false,
      reason: 'payment_tx_mismatch',
      detail: `${parsed.paymentTxHash} != ${order.paymentTxHash}`,
    };
  }
  if (parsed.amountLuna !== order.amountLuna) {
    return {
      ok: false,
      reason: 'amount_mismatch',
      detail: `${parsed.amountLuna} != ${order.amountLuna}`,
    };
  }
  // Full refunds only, and only ever to the destination resolved from the verified payment.
  if (expectedRefundTo === null || normalizeAddress(parsed.refundTo) !== normalizeAddress(expectedRefundTo)) {
    return {
      ok: false,
      reason: 'refund_to_mismatch',
      detail: `${parsed.refundTo} != ${expectedRefundTo ?? 'none'}`,
    };
  }
  if (parsed.expiresAtSec <= nowSec) {
    return {
      ok: false,
      reason: 'expired',
      detail: `expired ${nowSec - parsed.expiresAtSec}s ago`,
    };
  }
  if (parsed.expiresAtSec - nowSec > MAX_CHALLENGE_TTL_SEC) {
    return {
      ok: false,
      reason: 'ttl_too_long',
      detail: `${parsed.expiresAtSec - nowSec}s > ${MAX_CHALLENGE_TTL_SEC}s`,
    };
  }
  return { ok: true };
}
