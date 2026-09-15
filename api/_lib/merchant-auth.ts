/**
 * The merchant-side half of gap S1: `api/merchant/*` now requires a wallet signature over a
 * short-lived, action-bound challenge, so only the wallet that owns the merchant address can
 * approve or reject a refund.
 *
 * The domain owns the text and the rules (`server/domain/merchant-auth.ts`). This module joins
 * them to the request and to the signature verifier.
 *
 * The switch: authentication is REQUIRED unless `REWIND_MERCHANT_AUTH=off`, and `off` is
 * refused in production and whenever the real chain is configured. Local development with the
 * fake wallet defaults to `off` so `npm run dev` still walks the flow in a browser; that
 * default is inverted the moment anything real is wired up.
 */

import { createHash } from 'node:crypto';
import { UniqueViolationError } from '../../server/db/repository.js';
import type { DomainDeps } from '../../server/domain/deps.js';
import {
  buildMerchantChallenge,
  checkMerchantChallenge,
  DEFAULT_MERCHANT_CHALLENGE_TTL_SEC,
  isStateChangingAction,
  parseMerchantChallenge,
  type MerchantAction,
  type MerchantAuthResult,
} from '../../server/domain/merchant-auth.js';
import { addressEquals } from '../../server/domain/nimiq.js';
import type { Merchant, MerchantNonce } from '../../server/domain/types.js';

export interface MerchantAuthEnv {
  REWIND_MERCHANT_AUTH?: string | undefined;
  REWIND_CHAIN?: string | undefined;
  VERCEL_ENV?: string | undefined;
  NODE_ENV?: string | undefined;
}

/** True when a signature is required. Fails closed: only an explicit dev `off` disables it. */
export function merchantAuthRequired(env: MerchantAuthEnv = process.env): boolean {
  const isProduction = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
  const isRealChain = env.REWIND_CHAIN === 'rpc';
  if (env.REWIND_MERCHANT_AUTH === 'off') {
    // An "off" switch that survives into production is not a switch, it is a hole.
    if (isProduction || isRealChain) {
      throw new Error('REWIND_MERCHANT_AUTH=off is refused with a real chain (rpc) or in production.');
    }
    return false;
  }
  if (env.REWIND_MERCHANT_AUTH === 'required') return true;
  // Default: required everywhere except the fake-chain developer loop.
  return isProduction || isRealChain;
}

/**
 * The stored nonce for a challenge: the SHA-256 of the exact bytes the merchant is asked to
 * sign. Deriving the key from the text means the canonical format never had to change, and
 * the verifier can compute it from what the caller hands back without trusting the caller.
 */
export function merchantNonceOf(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

export interface MerchantChallengeRequest {
  merchant: Merchant;
  action: MerchantAction;
  orderId: string;
  nowMs: number;
  ttlSec?: number;
}

/** The exact text the merchant's wallet must sign. Issued by the server so it owns the clock. */
export function issueMerchantChallenge(request: MerchantChallengeRequest): {
  message: string;
  expiresAtSec: number;
} {
  const issuedAtSec = Math.floor(request.nowMs / 1000);
  const expiresAtSec = issuedAtSec + (request.ttlSec ?? DEFAULT_MERCHANT_CHALLENGE_TTL_SEC);
  return {
    message: buildMerchantChallenge({
      merchantId: request.merchant.id,
      address: request.merchant.address,
      action: request.action,
      orderId: request.orderId,
      issuedAtSec,
      expiresAtSec,
    }),
    expiresAtSec,
  };
}

export type IssuedMerchantChallenge = {
  message: string;
  expiresAtSec: number;
  nonce: string;
  /** True when this exact text was already issued and is being handed out again. */
  reissued: boolean;
};

/**
 * Issues a challenge AND records it, which is what closes gap S3.
 *
 * Two challenges for the same merchant, action and order inside the same second produce
 * byte-identical text and therefore the same nonce. That is a re-issue, not an error: the
 * stored row is unchanged and the same text is returned. If the stored row has already been
 * consumed the caller cannot be given it again — the signature would be refused as a replay —
 * so it is refused here, and one second later the text differs and it succeeds.
 */
export async function issueAndRecordMerchantChallenge(
  deps: DomainDeps,
  request: MerchantChallengeRequest,
): Promise<
  { ok: true; issued: IssuedMerchantChallenge } | { ok: false; reason: 'already_used'; detail: string }
> {
  const issued = issueMerchantChallenge(request);
  const nonce = merchantNonceOf(issued.message);
  const row: MerchantNonce = {
    nonce,
    merchantId: request.merchant.id,
    merchantAddress: request.merchant.address,
    action: request.action,
    orderId: request.orderId,
    message: issued.message,
    createdAt: request.nowMs,
    expiresAtSec: issued.expiresAtSec,
    consumedAt: null,
    signerAddress: null,
  };
  try {
    await deps.repo.createMerchantNonce(row);
    return { ok: true, issued: { ...issued, nonce, reissued: false } };
  } catch (err) {
    if (!(err instanceof UniqueViolationError)) throw err;
    const existing = await deps.repo.getMerchantNonce(nonce);
    if (!existing || existing.consumedAt !== null) {
      return {
        ok: false,
        reason: 'already_used',
        detail: 'that exact challenge has already been signed and used; try again in a second',
      };
    }
    return { ok: true, issued: { ...issued, nonce, reissued: true } };
  }
}

export interface MerchantAuthAttempt {
  message: unknown;
  publicKey: unknown;
  signature: unknown;
}

/**
 * Full check, in the order that leaks the least: shape, then binding to this request, then the
 * signature, then the address. A caller who guesses the text still has to hold the key, and a
 * caller who holds a key still has to hold the merchant's.
 */
export async function authenticateMerchant(
  deps: DomainDeps,
  merchant: Merchant,
  action: MerchantAction,
  orderId: string,
  attempt: MerchantAuthAttempt,
): Promise<MerchantAuthResult> {
  const parsed = parseMerchantChallenge(attempt.message);
  if (!parsed.ok) return parsed;

  const nowSec = Math.floor(deps.clock.nowMs() / 1000);
  const bound = checkMerchantChallenge(parsed.value, {
    merchantId: merchant.id,
    merchantAddress: merchant.address,
    action,
    orderId,
    nowSec,
  });
  if (!bound.ok) return bound;

  if (typeof attempt.publicKey !== 'string' || typeof attempt.signature !== 'string') {
    return { ok: false, reason: 'bad_signature', detail: 'publicKey and signature must be strings' };
  }

  const verified = await deps.signatureVerifier.verify(
    attempt.message as string,
    attempt.publicKey,
    attempt.signature,
  );
  if (!verified.ok) return { ok: false, reason: 'bad_signature', detail: verified.reason };

  // The address recovered from the signature, not the one written in the text.
  if (!addressEquals(verified.address, merchant.address)) {
    return {
      ok: false,
      reason: 'not_the_merchant_wallet',
      detail: `${verified.address} does not own ${merchant.id}`,
    };
  }

  // Gap S3. The text must be one this server issued, and — for anything that changes state —
  // one that has not been used. `list` is a read, so it is checked but not consumed: a
  // merchant board polls with one signature for the life of the challenge.
  const nonce = merchantNonceOf(attempt.message as string);
  const issued = await deps.repo.getMerchantNonce(nonce);
  if (!issued) {
    return { ok: false, reason: 'unknown_nonce', detail: 'this challenge was never issued' };
  }
  if (isStateChangingAction(action)) {
    const consumed = await deps.repo.consumeMerchantNonce(nonce, {
      consumedAt: deps.clock.nowMs(),
      signerAddress: verified.address,
    });
    if (!consumed) {
      return { ok: false, reason: 'nonce_already_used', detail: 'this challenge was already used' };
    }
  } else if (issued.consumedAt !== null) {
    return { ok: false, reason: 'nonce_already_used', detail: 'this challenge was already used' };
  }

  return { ok: true, challenge: parsed.value, signerAddress: verified.address };
}
