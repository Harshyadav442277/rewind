/**
 * Address validation at the API boundary, using `@nimiq/core`'s own parser.
 *
 * `server/domain/nimiq.ts` validates shape, alphabet and IBAN mod-97 check digits with no
 * dependencies, which is what the framework-free domain uses. This module is the second,
 * independent check: `Address.fromString` is the same code the node runs, and it throws
 * "Unknown format" on a bad address (observed in `spikes/server-tx`, 2026-09-13). Anything
 * that reaches a transaction builder or a signature comparison goes through here first, so a
 * disagreement between the two implementations is a rejection rather than a bad transfer.
 *
 * Both are run on purpose. If the pure routine were ever wrong, the addresses it wrongly
 * accepted would still be caught here, and the tests assert the two agree.
 */

import { Address } from '@nimiq/core';
import { isValidAddress, normalizeAddress } from '../domain/nimiq.js';

export type AddressParse =
  | { ok: true; address: string }
  | { ok: false; reason: 'not_a_string' | 'malformed' | 'check_digits'; detail: string };

/**
 * Parses any accepted spelling (spaced, unspaced, lower case) and returns the canonical
 * user-friendly form: `NQxx XXXX ...`, nine groups of four, upper case.
 */
export function parseAddress(value: unknown): AddressParse {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'not_a_string', detail: typeof value };
  }
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (compact.length !== 36 || !compact.startsWith('NQ')) {
    return { ok: false, reason: 'malformed', detail: `${compact.length} characters` };
  }

  const grouped = normalizeAddress(value);
  if (grouped === null) {
    // Shape and alphabet were fine but the pure check digits failed, or vice versa. Report the
    // more useful of the two.
    const shaped = (compact.match(/.{1,4}/g) ?? []).join(' ');
    const reason = /^NQ\d{2}(?: [0-9A-HJ-NP-VXY]{4}){8}$/.test(shaped) ? 'check_digits' : 'malformed';
    return { ok: false, reason, detail: 'rejected by the pure validator' };
  }

  let canonical: string;
  try {
    canonical = Address.fromString(grouped).toUserFriendlyAddress();
  } catch (err) {
    return {
      ok: false,
      reason: 'check_digits',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (canonical !== grouped || !isValidAddress(canonical)) {
    // The two implementations disagreed. Refuse rather than pick a winner.
    return { ok: false, reason: 'malformed', detail: 'validators disagreed' };
  }
  return { ok: true, address: canonical };
}

/** Throwing form, for call sites that have already handled the error path above them. */
export function requireAddress(value: unknown): string {
  const parsed = parseAddress(value);
  if (!parsed.ok) throw new Error(`invalid Nimiq address (${parsed.reason}): ${parsed.detail}`);
  return parsed.address;
}
