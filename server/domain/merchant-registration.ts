/**
 * Any wallet can become a merchant and get a payment link.
 *
 * The wallet signs a short text naming its shop. The merchant's address is the address that
 * signature recovers, never a field the client sends, and the merchant id is derived from that
 * address. So a registration can only ever create or rename the signer's own merchant; it can
 * never point an existing merchant at a different wallet.
 *
 * Replaying a captured registration inside its freshness window re-applies the same name to
 * the same wallet, which changes nothing.
 */

import type { DomainDeps } from './deps.js';
import { normalizeAddress } from './nimiq.js';
import type { Merchant } from './types.js';

export const REGISTRATION_HEADER = 'REWIND_MERCHANT_REGISTER_V1';
export const MAX_MERCHANT_NAME_LENGTH = 40;
/** How old a signed registration may be. */
export const REGISTRATION_MAX_AGE_SEC = 300;
/** Tolerated clock skew for a registration issued "in the future". */
export const REGISTRATION_MAX_SKEW_SEC = 60;

export function buildRegistrationMessage(input: { name: string; issuedAtSec: number }): string {
  return [REGISTRATION_HEADER, `name=${input.name}`, `issued=${input.issuedAtSec}`].join('\n');
}

export type ParsedRegistration = { ok: true; name: string; issuedAtSec: number } | { ok: false; detail: string };

export function parseRegistrationMessage(message: string): ParsedRegistration {
  const lines = message.split('\n');
  if (lines.length !== 3 || lines[0] !== REGISTRATION_HEADER) {
    return { ok: false, detail: 'not a registration message' };
  }
  const nameLine = lines[1] ?? '';
  const issuedLine = lines[2] ?? '';
  if (!nameLine.startsWith('name=') || !issuedLine.startsWith('issued=')) {
    return { ok: false, detail: 'fields out of order' };
  }
  const name = nameLine.slice('name='.length);
  const nameProblem = checkMerchantName(name);
  if (nameProblem) return { ok: false, detail: nameProblem };
  const issuedText = issuedLine.slice('issued='.length);
  if (!/^(?:0|[1-9][0-9]*)$/.test(issuedText)) return { ok: false, detail: 'issued is not a number' };
  return { ok: true, name, issuedAtSec: Number(issuedText) };
}

/** Returns a reason the name is unusable, or null. */
export function checkMerchantName(name: string): string | null {
  if (name !== name.trim()) return 'name has leading or trailing spaces';
  if (name.length === 0) return 'name is empty';
  if (name.length > MAX_MERCHANT_NAME_LENGTH) return `name is longer than ${MAX_MERCHANT_NAME_LENGTH} characters`;
  // Printable characters only. A control character could forge an extra line in a signed text.
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return 'name contains a control character';
  return null;
}

/**
 * `w-` followed by the address without spaces, lower-cased: 38 characters, readable, one per
 * wallet, and inside the merchant id pattern the merchant challenge enforces.
 */
export function merchantIdForAddress(address: string): string | null {
  const normalized = normalizeAddress(address);
  if (normalized === null) return null;
  return `w-${normalized.replace(/\s+/g, '').toLowerCase()}`;
}

export interface SignedRegistration {
  message: string;
  publicKey: string;
  signature: string;
}

export type RegisterMerchantResult =
  | { ok: true; merchant: Merchant }
  | { ok: false; reason: 'malformed' | 'stale' | 'bad_signature'; detail: string; message: string };

export async function registerMerchant(
  deps: DomainDeps,
  request: SignedRegistration,
): Promise<RegisterMerchantResult> {
  const parsed = parseRegistrationMessage(request.message);
  if (!parsed.ok) {
    return { ok: false, reason: 'malformed', detail: parsed.detail, message: 'That shop name cannot be used.' };
  }
  const nowSec = Math.floor(deps.clock.nowMs() / 1000);
  if (parsed.issuedAtSec < nowSec - REGISTRATION_MAX_AGE_SEC || parsed.issuedAtSec > nowSec + REGISTRATION_MAX_SKEW_SEC) {
    return {
      ok: false,
      reason: 'stale',
      detail: `issued ${parsed.issuedAtSec}, now ${nowSec}`,
      message: 'That signature is too old. Sign again.',
    };
  }

  const verification = await deps.signatureVerifier.verify(request.message, request.publicKey, request.signature);
  if (!verification.ok) {
    return {
      ok: false,
      reason: 'bad_signature',
      detail: verification.reason,
      message: 'That signature could not be verified.',
    };
  }
  const address = normalizeAddress(verification.address);
  const id = address === null ? null : merchantIdForAddress(address);
  if (address === null || id === null) {
    return {
      ok: false,
      reason: 'bad_signature',
      detail: `unreadable signer ${verification.address}`,
      message: 'That signature could not be verified.',
    };
  }

  const merchant = await deps.repo.upsertMerchant({
    id,
    name: parsed.name,
    address,
    allowTreasuryRefund: false,
  });
  return { ok: true, merchant };
}
