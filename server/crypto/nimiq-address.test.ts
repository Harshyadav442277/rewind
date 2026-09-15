/**
 * Offline. The two known-valid mainnet addresses are the only real ones in this repository;
 * everything else is a fixture. They are what makes the IBAN mod-97 routine in
 * `server/domain/nimiq.ts` testable at all, which is why gap A1 stayed open until now.
 */

import { describe, expect, it } from 'vitest';
import { Address, KeyPair } from '@nimiq/core';
import { parseAddress, requireAddress } from './nimiq-address.js';
import {
  addressFromHex,
  addressToHex,
  hasValidCheckDigits,
  htlcSenderFromCreationData,
  isValidAddress,
  normalizeAddress,
} from '../domain/nimiq.js';

const KNOWN_A = 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4JD';
const KNOWN_B = 'NQ87 T28S MDL1 TUC7 7L8L 5BED J4HC KBM7 MUXR';

/** KNOWN_A with two characters of the body transposed. Same shape, same alphabet, wrong. */
const CORRUPTED = 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4DJ';

describe('parseAddress', () => {
  it.each([KNOWN_A, KNOWN_B])('accepts the known-valid address %s', (address) => {
    expect(parseAddress(address)).toEqual({ ok: true, address });
  });

  it('accepts an unspaced spelling and returns the grouped canonical form', () => {
    expect(parseAddress(KNOWN_A.replace(/ /g, ''))).toEqual({ ok: true, address: KNOWN_A });
  });

  it('accepts a lower-case spelling', () => {
    expect(parseAddress(KNOWN_A.toLowerCase())).toEqual({ ok: true, address: KNOWN_A });
  });

  it('rejects a transposed pair of characters', () => {
    const result = parseAddress(CORRUPTED);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('check_digits');
  });

  it.each([
    ['empty', ''],
    ['too short', 'NQ14 E6Y2'],
    ['too long', `${KNOWN_A} 0000`],
    ['wrong country prefix', KNOWN_A.replace('NQ', 'DE')],
    ['letter outside the base32 alphabet', 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4JI'],
  ])('rejects %s', (_label, value) => {
    expect(parseAddress(value).ok).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}]])('rejects the non-string %s', (value) => {
    const result = parseAddress(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_a_string');
  });

  it('requireAddress throws on a corrupted address and returns the canonical form otherwise', () => {
    expect(requireAddress(KNOWN_A.toLowerCase().replace(/ /g, ''))).toBe(KNOWN_A);
    expect(() => requireAddress(CORRUPTED)).toThrow(/check_digits/);
  });
});

describe('the pure validator agrees with @nimiq/core', () => {
  it.each([KNOWN_A, KNOWN_B])('accepts %s both ways', (address) => {
    expect(isValidAddress(address)).toBe(true);
    expect(hasValidCheckDigits(address)).toBe(true);
    expect(Address.fromString(address).toUserFriendlyAddress()).toBe(address);
  });

  it('rejects the corrupted variant both ways', () => {
    expect(isValidAddress(CORRUPTED)).toBe(false);
    expect(hasValidCheckDigits(CORRUPTED)).toBe(false);
    expect(() => Address.fromString(CORRUPTED)).toThrow();
  });

  it('agrees on 200 freshly generated addresses', () => {
    for (let i = 0; i < 200; i++) {
      const address = KeyPair.generate().toAddress().toUserFriendlyAddress();
      expect(isValidAddress(address)).toBe(true);
      expect(normalizeAddress(address.toLowerCase().replace(/ /g, ''))).toBe(address);
    }
  });

  it('agrees on every single-check-digit corruption of a known address', () => {
    const digits = KNOWN_A.slice(2, 4);
    let checked = 0;
    for (let d = 0; d < 100; d++) {
      const candidate = `NQ${String(d).padStart(2, '0')}${KNOWN_A.slice(4)}`;
      if (candidate.slice(2, 4) === digits) continue;
      checked++;
      expect(isValidAddress(candidate)).toBe(false);
      expect(() => Address.fromString(candidate)).toThrow();
    }
    expect(checked).toBe(99);
  });
});

describe('addresses as bytes, and an HTLC creation', () => {
  // The recipientData of mainnet tx 9bf66ef2fbc3dc6ca72383374e7fc2e769af4bd4f03d4e404173e2e40240c219,
  // which created HTLC NQ66 DL0K CXPR 0ACP 0D7T 06G4 67KT SQ6P 7M05. Read from rpc.nimiqwatch.com on 2026-09-15.
  const CREATION_DATA =
    'd891aab681df1873d1142adcd9122c9aea7af3d9a70b9e44a448b5183ac4e186cd749d3d889fff8401' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '01000001a0e3ed27b3';

  it('decodes the mainnet creation data to its sender and recipient', () => {
    expect(CREATION_DATA.length).toBe(164);
    expect(htlcSenderFromCreationData(CREATION_DATA)).toBe(KNOWN_B);
    expect(addressFromHex(CREATION_DATA.slice(40, 80))).toBe('NQ14 LU5R UH54 92SH GEN4 U63C SV4V 7N49 YYU4');
  });

  it('refuses creation data of the wrong length or with an unknown hash algorithm', () => {
    expect(htlcSenderFromCreationData(CREATION_DATA.slice(0, 162))).toBeNull();
    expect(htlcSenderFromCreationData(CREATION_DATA + '00')).toBeNull();
    expect(htlcSenderFromCreationData(CREATION_DATA.slice(0, 80) + '02' + CREATION_DATA.slice(82))).toBeNull();
    expect(htlcSenderFromCreationData('')).toBeNull();
    expect(htlcSenderFromCreationData(undefined)).toBeNull();
    expect(htlcSenderFromCreationData('zz'.repeat(82))).toBeNull();
  });

  it('agrees with @nimiq/core in both directions on 200 generated addresses', () => {
    for (let i = 0; i < 200; i++) {
      const address = KeyPair.generate().toAddress();
      expect(addressFromHex(address.toHex())).toBe(address.toUserFriendlyAddress());
      expect(addressToHex(address.toUserFriendlyAddress())).toBe(address.toHex());
    }
    expect(Address.fromString(KNOWN_B).toHex()).toBe(CREATION_DATA.slice(0, 40));
    expect(addressFromHex('00'.repeat(19))).toBeNull();
    expect(addressToHex(CORRUPTED)).toBeNull();
  });
});
