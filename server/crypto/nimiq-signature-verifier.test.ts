/**
 * Offline. Generates a keypair with `@nimiq/core` and signs the two preimages itself, which is
 * what `spikes/sign-verify/selftest.mjs` does. No network, no wallet, no device.
 *
 * What this proves: the verifier accepts a correct Ed25519 signature over each of the two
 * prefixed SHA-256 preimages, names which one matched, derives the signer's address, and
 * refuses everything else. What it does not prove: that Nimiq Pay produces either of them.
 */

import { describe, expect, it } from 'vitest';
import { KeyPair } from '@nimiq/core';
import {
  CONNECT_CHALLENGE_PREFIX,
  NimiqSignatureVerifier,
  SIGN_MESSAGE_PREFIX,
  signedMessageDigest,
  signedMessagePreimage,
  normalizeHex,
} from './nimiq-signature-verifier';

const verifier = new NimiqSignatureVerifier();

const MESSAGE = [
  'REWIND_REFUND_V1',
  'order=abcd1234efgh',
  'paymentTx=' + 'a'.repeat(64),
  'amountLuna=1000',
  'refundTo=NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4JD',
  'nonce=' + 'b'.repeat(32),
  'expires=1789229039',
].join('\n');

function sign(kp: KeyPair, message: string, prefix: string): string {
  return kp.sign(signedMessageDigest(message, prefix)).toHex();
}

describe('signedMessagePreimage', () => {
  it('is prefix + ascii decimal BYTE length + message', () => {
    const preimage = signedMessagePreimage('hello', SIGN_MESSAGE_PREFIX);
    expect(new TextDecoder().decode(preimage)).toBe(`${SIGN_MESSAGE_PREFIX}5hello`);
  });

  it('counts bytes, not characters', () => {
    // "é" is two UTF-8 bytes. A character count would write 1 here and sign different bytes.
    const preimage = signedMessagePreimage('é', SIGN_MESSAGE_PREFIX);
    expect(new TextDecoder().decode(preimage)).toBe(`${SIGN_MESSAGE_PREFIX}2é`);
  });

  it('uses the two distinct keyguard prefixes', () => {
    expect(SIGN_MESSAGE_PREFIX).toBe('\x16Nimiq Signed Message:\n');
    expect(CONNECT_CHALLENGE_PREFIX).toBe('\x19Nimiq Connect Challenge:\n');
    expect(signedMessageDigest(MESSAGE, SIGN_MESSAGE_PREFIX)).not.toEqual(
      signedMessageDigest(MESSAGE, CONNECT_CHALLENGE_PREFIX),
    );
  });
});

describe('NimiqSignatureVerifier', () => {
  it('accepts the signed-message prefix and reports the variant and address', async () => {
    const kp = KeyPair.generate();
    const address = kp.toAddress().toUserFriendlyAddress();
    const result = await verifier.verify(
      MESSAGE,
      kp.publicKey.toHex(),
      sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX),
    );
    expect(result).toEqual({ ok: true, address, variant: 'nimiq-signed-message' });
  });

  it('accepts the connect-challenge prefix and reports that variant', async () => {
    const kp = KeyPair.generate();
    const address = kp.toAddress().toUserFriendlyAddress();
    const result = await verifier.verify(
      MESSAGE,
      kp.publicKey.toHex(),
      sign(kp, MESSAGE, CONNECT_CHALLENGE_PREFIX),
    );
    expect(result).toEqual({ ok: true, address, variant: 'nimiq-connect-challenge' });
  });

  it('derives an address in user-friendly form with valid check digits', async () => {
    const kp = KeyPair.generate();
    const result = await verifier.verify(
      MESSAGE,
      kp.publicKey.toHex(),
      sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address).toMatch(/^NQ\d{2}(?: [0-9A-HJ-NP-VXY]{4}){8}$/);
    const { isValidAddress } = await import('../domain/nimiq');
    expect(isValidAddress(result.address)).toBe(true);
  });

  it('rejects a signature over a tampered message', async () => {
    const kp = KeyPair.generate();
    const signature = sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX);
    const tampered = MESSAGE.replace('amountLuna=1000', 'amountLuna=1001');
    expect(await verifier.verify(tampered, kp.publicKey.toHex(), signature)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature checked against a different public key', async () => {
    const kp = KeyPair.generate();
    const other = KeyPair.generate();
    const signature = sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX);
    expect(await verifier.verify(MESSAGE, other.publicKey.toHex(), signature)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a raw-utf8 signature, i.e. one that skipped the prefix and the hash', async () => {
    const kp = KeyPair.generate();
    const raw = kp.sign(new TextEncoder().encode(MESSAGE)).toHex();
    expect(await verifier.verify(MESSAGE, kp.publicKey.toHex(), raw)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature over the unhashed preimage', async () => {
    const kp = KeyPair.generate();
    const raw = kp.sign(signedMessagePreimage(MESSAGE, SIGN_MESSAGE_PREFIX)).toHex();
    expect(await verifier.verify(MESSAGE, kp.publicKey.toHex(), raw)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a flipped bit in the signature', async () => {
    const kp = KeyPair.generate();
    const signature = sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX);
    const flipped = (signature.slice(0, 2) === '00' ? '11' : '00') + signature.slice(2);
    const result = await verifier.verify(MESSAGE, kp.publicKey.toHex(), flipped);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['empty public key', '', 'a'.repeat(128), 'bad_public_key'],
    ['short public key', 'ab'.repeat(16), 'a'.repeat(128), 'bad_public_key'],
    ['non-hex public key', 'zz'.repeat(32), 'a'.repeat(128), 'bad_public_key'],
    ['empty signature', 'ab'.repeat(32), '', 'malformed'],
    ['short signature', 'ab'.repeat(32), 'ab'.repeat(32), 'malformed'],
    ['non-hex signature', 'ab'.repeat(32), 'zz'.repeat(64), 'malformed'],
  ])('rejects %s', async (_label, pk, sig, reason) => {
    expect(await verifier.verify(MESSAGE, pk, sig)).toEqual({ ok: false, reason });
  });

  it('rejects a non-string message', async () => {
    const kp = KeyPair.generate();
    const result = await verifier.verify(
      undefined as unknown as string,
      kp.publicKey.toHex(),
      sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX),
    );
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts 0x-prefixed and upper-case hex', async () => {
    const kp = KeyPair.generate();
    const signature = sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX);
    const result = await verifier.verify(
      MESSAGE,
      `0x${kp.publicKey.toHex().toUpperCase()}`,
      signature.toUpperCase(),
    );
    expect(result.ok).toBe(true);
  });

  it('survives being called many times without leaking a handle failure', async () => {
    const kp = KeyPair.generate();
    const signature = sign(kp, MESSAGE, SIGN_MESSAGE_PREFIX);
    for (let i = 0; i < 50; i++) {
      expect((await verifier.verify(MESSAGE, kp.publicKey.toHex(), signature)).ok).toBe(true);
    }
  });
});

describe('normalizeHex', () => {
  it.each([
    ['0xAB', 'ab'],
    ['  abcd  ', 'abcd'],
    ['ab cd', 'abcd'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each([['abc'], [''], ['xy'], [null], [undefined], [12]])('rejects %s', (input) => {
    expect(normalizeHex(input)).toBeNull();
  });
});
