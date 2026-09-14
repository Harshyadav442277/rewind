/**
 * Offline. Covers gap S1: only the wallet that owns the merchant address may approve or reject.
 *
 * Runs twice over the same rules — once with the fake verifier, once with the real Ed25519 one
 * and a generated keypair — so the binding logic and the cryptography are both exercised.
 */

import { describe, expect, it } from 'vitest';
import { KeyPair } from '@nimiq/core';
import {
  authenticateMerchant,
  issueAndRecordMerchantChallenge,
  issueMerchantChallenge,
  merchantAuthRequired,
  merchantNonceOf,
  type MerchantAuthEnv,
} from './merchant-auth.js';
import { NimiqSignatureVerifier, signedMessageDigest, SIGN_MESSAGE_PREFIX } from '../../server/crypto/nimiq-signature-verifier.js';
import {
  buildMerchantChallenge,
  checkMerchantChallenge,
  LIST_ORDER_SENTINEL,
  MAX_MERCHANT_CHALLENGE_TTL_SEC,
  parseMerchantChallenge,
} from '../../server/domain/merchant-auth.js';
import { fakeKeyFor, fakeSign } from '../../server/domain/fakes.js';
import { DEMO_MERCHANT, makeHarness, TREASURY } from '../../server/domain/test-helpers.js';
import type { DomainDeps } from '../../server/domain/deps.js';
import type { Merchant } from '../../server/domain/types.js';

/**
 * Gap S3: authenticateMerchant now requires the text to be one this server issued and
 * recorded. A test that hand-builds the text has to record it too, exactly as the challenge
 * endpoint does.
 */
async function record(
  deps: DomainDeps,
  merchant: Merchant,
  message: string,
  action: string,
  orderId: string,
): Promise<void> {
  await deps.repo.createMerchantNonce({
    nonce: merchantNonceOf(message),
    merchantId: merchant.id,
    merchantAddress: merchant.address,
    action,
    orderId,
    message,
    createdAt: deps.clock.nowMs(),
    expiresAtSec: Math.floor(deps.clock.nowMs() / 1000) + 120,
    consumedAt: null,
    signerAddress: null,
  });
}

const ORDER_ID = 'order1234abcd';

const NOW_SEC = Math.floor(1_700_000_000_000 / 1000);

function challengeText(over: Partial<Parameters<typeof buildMerchantChallenge>[0]> = {}): string {
  return buildMerchantChallenge({
    merchantId: DEMO_MERCHANT.id,
    address: TREASURY,
    action: 'approve',
    orderId: ORDER_ID,
    issuedAtSec: NOW_SEC,
    expiresAtSec: NOW_SEC + 120,
    ...over,
  });
}

describe('merchantAuthRequired', () => {
  const env = (e: MerchantAuthEnv) => () => merchantAuthRequired(e);

  it('is off in the fake-chain developer loop only when asked', () => {
    expect(merchantAuthRequired({})).toBe(false);
    expect(merchantAuthRequired({ REWIND_MERCHANT_AUTH: 'off' })).toBe(false);
    expect(merchantAuthRequired({ REWIND_MERCHANT_AUTH: 'required' })).toBe(true);
  });

  it('is on in production and with the real chain, without being asked', () => {
    expect(merchantAuthRequired({ VERCEL_ENV: 'production' })).toBe(true);
    expect(merchantAuthRequired({ NODE_ENV: 'production' })).toBe(true);
    expect(merchantAuthRequired({ REWIND_CHAIN: 'rpc' })).toBe(true);
  });

  it('refuses to be switched off in production or against the real chain', () => {
    expect(env({ REWIND_MERCHANT_AUTH: 'off', VERCEL_ENV: 'production' })).toThrow(/refused/);
    expect(env({ REWIND_MERCHANT_AUTH: 'off', NODE_ENV: 'production' })).toThrow(/refused/);
    expect(env({ REWIND_MERCHANT_AUTH: 'off', REWIND_CHAIN: 'rpc' })).toThrow(/refused/);
  });
});

describe('the merchant challenge text', () => {
  it('round-trips through the strict parser', () => {
    const parsed = parseMerchantChallenge(challengeText());
    expect(parsed).toEqual({
      ok: true,
      value: {
        merchantId: DEMO_MERCHANT.id,
        address: TREASURY,
        action: 'approve',
        orderId: ORDER_ID,
        issuedAtSec: NOW_SEC,
        expiresAtSec: NOW_SEC + 120,
      },
    });
  });

  it('is exactly seven lines with no trailing newline', () => {
    const text = challengeText();
    expect(text.split('\n')).toHaveLength(7);
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')[0]).toBe('REWIND_MERCHANT_V1');
  });

  it.each([
    ['a trailing newline', (t: string) => `${t}\n`],
    ['a reordered field', (t: string) => t.split('\n').reverse().join('\n')],
    ['a changed header', (t: string) => t.replace('REWIND_MERCHANT_V1', 'REWIND_MERCHANT_V2')],
    ['a missing line', (t: string) => t.split('\n').slice(0, 6).join('\n')],
    ['leading whitespace', (t: string) => ` ${t}`],
    ['an unknown action', (t: string) => t.replace('action=approve', 'action=drain')],
    ['a corrupted address', (t: string) => t.replace(TREASURY.slice(-4), 'ZZZZ')],
  ])('refuses %s rather than repairing it', (_label, mangle) => {
    expect(parseMerchantChallenge(mangle(challengeText())).ok).toBe(false);
  });

  it('refuses to build text the parser would refuse', () => {
    expect(() => buildMerchantChallenge({
      merchantId: DEMO_MERCHANT.id,
      address: 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4DJ', // bad check digits
      action: 'approve',
      orderId: ORDER_ID,
      issuedAtSec: NOW_SEC,
      expiresAtSec: NOW_SEC + 120,
    })).toThrow(/invalid address/);
  });

  it('issues a challenge the parser accepts, with the server clock', () => {
    const issued = issueMerchantChallenge({
      merchant: DEMO_MERCHANT,
      action: 'reject',
      orderId: ORDER_ID,
      nowMs: 1_700_000_000_000,
    });
    expect(issued.expiresAtSec).toBe(NOW_SEC + 120);
    const parsed = parseMerchantChallenge(issued.message);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.action).toBe('reject');
  });
});

describe('checkMerchantChallenge binding', () => {
  const parsed = () => {
    const r = parseMerchantChallenge(challengeText());
    if (!r.ok) throw new Error('fixture broken');
    return r.value;
  };
  const expectation = {
    merchantId: DEMO_MERCHANT.id,
    merchantAddress: TREASURY,
    action: 'approve' as const,
    orderId: ORDER_ID,
    nowSec: NOW_SEC,
  };

  it('accepts a challenge that matches the request', () => {
    expect(checkMerchantChallenge(parsed(), expectation)).toEqual({ ok: true });
  });

  it('refuses a challenge for a different action', () => {
    const result = checkMerchantChallenge(parsed(), { ...expectation, action: 'reject' });
    expect(result).toMatchObject({ ok: false, reason: 'action_mismatch' });
  });

  it('refuses a challenge for a different order', () => {
    const result = checkMerchantChallenge(parsed(), { ...expectation, orderId: 'other12345' });
    expect(result).toMatchObject({ ok: false, reason: 'order_mismatch' });
  });

  it('refuses a challenge for a different merchant', () => {
    const result = checkMerchantChallenge(parsed(), { ...expectation, merchantId: 'shop' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_merchant' });
  });

  it('refuses a challenge whose address is not the merchant address the server knows', () => {
    const result = checkMerchantChallenge(parsed(), {
      ...expectation,
      merchantAddress: 'NQ64 5H0P 0000 0000 0000 0000 0000 0000 0004',
    });
    expect(result).toMatchObject({ ok: false, reason: 'address_mismatch' });
  });

  it('refuses an expired challenge', () => {
    const result = checkMerchantChallenge(parsed(), { ...expectation, nowSec: NOW_SEC + 121 });
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a self-minted long-lived credential', () => {
    const long = parseMerchantChallenge(
      challengeText({ expiresAtSec: NOW_SEC + MAX_MERCHANT_CHALLENGE_TTL_SEC + 1 }),
    );
    if (!long.ok) throw new Error('fixture broken');
    expect(checkMerchantChallenge(long.value, expectation)).toMatchObject({
      ok: false,
      reason: 'ttl_too_long',
    });
  });

  it('refuses a challenge issued in the future', () => {
    const future = parseMerchantChallenge(
      challengeText({ issuedAtSec: NOW_SEC + 120, expiresAtSec: NOW_SEC + 200 }),
    );
    if (!future.ok) throw new Error('fixture broken');
    expect(checkMerchantChallenge(future.value, expectation)).toMatchObject({
      ok: false,
      reason: 'issued_in_future',
    });
  });
});

describe('authenticateMerchant with the fake verifier', () => {
  function setup() {
    const h = makeHarness();
    const key = h.verifier.register(fakeKeyFor(TREASURY));
    return { h, key };
  }

  it('accepts a correctly signed approval from the merchant wallet', async () => {
    const { h, key } = setup();
    const message = challengeText();
    await record(h.deps, DEMO_MERCHANT, message, 'approve', ORDER_ID);
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'approve', ORDER_ID, {
      message,
      publicKey: key.publicKey,
      signature: fakeSign(key, message),
    });
    expect(result).toMatchObject({ ok: true, signerAddress: TREASURY });
  });

  it('refuses a signature from a wallet that is not the merchant', async () => {
    const { h } = setup();
    const stranger = h.verifier.register(fakeKeyFor('NQ64 5H0P 0000 0000 0000 0000 0000 0000 0004'));
    const message = challengeText();
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'approve', ORDER_ID, {
      message,
      publicKey: stranger.publicKey,
      signature: fakeSign(stranger, message),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_the_merchant_wallet' });
  });

  it('refuses an approval signature reused for a rejection', async () => {
    const { h, key } = setup();
    const message = challengeText({ action: 'approve' });
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'reject', ORDER_ID, {
      message,
      publicKey: key.publicKey,
      signature: fakeSign(key, message),
    });
    expect(result).toMatchObject({ ok: false, reason: 'action_mismatch' });
  });

  it('refuses a signature reused for a different order', async () => {
    const { h, key } = setup();
    const message = challengeText({ orderId: 'someother123' });
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'approve', ORDER_ID, {
      message,
      publicKey: key.publicKey,
      signature: fakeSign(key, message),
    });
    expect(result).toMatchObject({ ok: false, reason: 'order_mismatch' });
  });

  it('refuses a valid signature over text that was tampered with afterwards', async () => {
    const { h, key } = setup();
    const message = challengeText();
    const signature = fakeSign(key, message);
    const tampered = message.replace(`order=${ORDER_ID}`, 'order=someother123');
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'approve', 'someother123', {
      message: tampered,
      publicKey: key.publicKey,
      signature,
    });
    expect(result).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['missing', undefined],
    ['not a string', 42],
    ['garbage', 'hello'],
  ])('refuses a %s message', async (_label, message) => {
    const { h, key } = setup();
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'approve', ORDER_ID, {
      message,
      publicKey: key.publicKey,
      signature: 'x',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a missing signature', async () => {
    const { h, key } = setup();
    const result = await authenticateMerchant(h.deps, DEMO_MERCHANT, 'approve', ORDER_ID, {
      message: challengeText(),
      publicKey: key.publicKey,
      signature: undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
});

describe('authenticateMerchant with the real Ed25519 verifier', () => {
  function realDeps(merchantAddress: string) {
    const h = makeHarness();
    const merchant: Merchant = { ...DEMO_MERCHANT, address: merchantAddress };
    return {
      deps: { ...h.deps, signatureVerifier: new NimiqSignatureVerifier() },
      merchant,
    };
  }

  it('accepts a real signature from the merchant key and refuses another key', async () => {
    const merchantKey = KeyPair.generate();
    const address = merchantKey.toAddress().toUserFriendlyAddress();
    const { deps, merchant } = realDeps(address);

    const recorded = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'approve',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    });
    if (!recorded.ok) throw new Error('fixture broken');
    const issued = recorded.issued;
    const sign = (kp: KeyPair) =>
      kp.sign(signedMessageDigest(issued.message, SIGN_MESSAGE_PREFIX)).toHex();

    await expect(
      authenticateMerchant(deps, merchant, 'approve', ORDER_ID, {
        message: issued.message,
        publicKey: merchantKey.publicKey.toHex(),
        signature: sign(merchantKey),
      }),
    ).resolves.toMatchObject({ ok: true, signerAddress: address });

    // A fresh challenge: the one above has been consumed, and a consumed nonce is refused
    // before the signer is looked at at all.
    (deps.clock as unknown as { advance(ms: number): void }).advance(1_000);
    const second = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'approve',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    });
    if (!second.ok) throw new Error('fixture broken');
    const impostor = KeyPair.generate();
    await expect(
      authenticateMerchant(deps, merchant, 'approve', ORDER_ID, {
        message: second.issued.message,
        publicKey: impostor.publicKey.toHex(),
        signature: impostor
          .sign(signedMessageDigest(second.issued.message, SIGN_MESSAGE_PREFIX))
          .toHex(),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_the_merchant_wallet' });
  });

  it('refuses the same signed approval a second time (gap S3)', async () => {
    const merchantKey = KeyPair.generate();
    const address = merchantKey.toAddress().toUserFriendlyAddress();
    const { deps, merchant } = realDeps(address);

    const recorded = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'approve',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    });
    if (!recorded.ok) throw new Error('fixture broken');
    const attempt = {
      message: recorded.issued.message,
      publicKey: merchantKey.publicKey.toHex(),
      signature: merchantKey
        .sign(signedMessageDigest(recorded.issued.message, SIGN_MESSAGE_PREFIX))
        .toHex(),
    };

    await expect(
      authenticateMerchant(deps, merchant, 'approve', ORDER_ID, attempt),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authenticateMerchant(deps, merchant, 'approve', ORDER_ID, attempt),
    ).resolves.toMatchObject({ ok: false, reason: 'nonce_already_used' });
  });

  it('refuses a perfectly signed challenge this server never issued', async () => {
    const merchantKey = KeyPair.generate();
    const address = merchantKey.toAddress().toUserFriendlyAddress();
    const { deps, merchant } = realDeps(address);

    // Correct text, correct key, correct everything, but nothing recorded it.
    const message = issueMerchantChallenge({
      merchant,
      action: 'approve',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    }).message;

    await expect(
      authenticateMerchant(deps, merchant, 'approve', ORDER_ID, {
        message,
        publicKey: merchantKey.publicKey.toHex(),
        signature: merchantKey.sign(signedMessageDigest(message, SIGN_MESSAGE_PREFIX)).toHex(),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'unknown_nonce' });
  });

  it('does not consume a list challenge, so a board can poll with one signature', async () => {
    const merchantKey = KeyPair.generate();
    const address = merchantKey.toAddress().toUserFriendlyAddress();
    const { deps, merchant } = realDeps(address);

    const recorded = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'list',
      orderId: LIST_ORDER_SENTINEL,
      nowMs: deps.clock.nowMs(),
    });
    if (!recorded.ok) throw new Error('fixture broken');
    const attempt = {
      message: recorded.issued.message,
      publicKey: merchantKey.publicKey.toHex(),
      signature: merchantKey
        .sign(signedMessageDigest(recorded.issued.message, SIGN_MESSAGE_PREFIX))
        .toHex(),
    };

    for (let i = 0; i < 3; i++) {
      await expect(
        authenticateMerchant(deps, merchant, 'list', LIST_ORDER_SENTINEL, attempt),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it('re-issues identical text rather than failing, and refuses it once used', async () => {
    const merchantKey = KeyPair.generate();
    const address = merchantKey.toAddress().toUserFriendlyAddress();
    const { deps, merchant } = realDeps(address);

    const first = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'reject',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    });
    const again = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'reject',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    });
    if (!first.ok || !again.ok) throw new Error('fixture broken');
    expect(again.issued.message).toBe(first.issued.message);
    expect(again.issued.reissued).toBe(true);

    await authenticateMerchant(deps, merchant, 'reject', ORDER_ID, {
      message: first.issued.message,
      publicKey: merchantKey.publicKey.toHex(),
      signature: merchantKey
        .sign(signedMessageDigest(first.issued.message, SIGN_MESSAGE_PREFIX))
        .toHex(),
    });

    const third = await issueAndRecordMerchantChallenge(deps, {
      merchant,
      action: 'reject',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
    });
    expect(third).toMatchObject({ ok: false, reason: 'already_used' });
  });

  it('refuses a real signature over an expired challenge', async () => {
    const merchantKey = KeyPair.generate();
    const address = merchantKey.toAddress().toUserFriendlyAddress();
    const { deps, merchant } = realDeps(address);

    const issued = issueMerchantChallenge({
      merchant,
      action: 'approve',
      orderId: ORDER_ID,
      nowMs: deps.clock.nowMs(),
      ttlSec: 60,
    });
    const signature = merchantKey
      .sign(signedMessageDigest(issued.message, SIGN_MESSAGE_PREFIX))
      .toHex();

    (deps.clock as unknown as { advance(ms: number): void }).advance(61_000);

    await expect(
      authenticateMerchant(deps, merchant, 'approve', ORDER_ID, {
        message: issued.message,
        publicKey: merchantKey.publicKey.toHex(),
        signature,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'expired' });
  });
});
