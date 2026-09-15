/**
 * The real `SignatureVerifier`: Ed25519 over Nimiq's signed-message preimage.
 *
 * Scheme, proved in `spikes/sign-verify` on 2026-09-13 against `@nimiq/core@2.21.0` and
 * cross-checked live against `verifySignature` on https://rpc.nimiqwatch.com:
 *
 *     preimage = PREFIX || asciiDecimal(byteLength(utf8(message))) || utf8(message)
 *     digest   = SHA-256(preimage)
 *     Ed25519.verify(publicKey, signature, digest)
 *
 * Primary source for the construction: nimiq/core-rs-albatross
 * `wallet/src/wallet_account.rs` — `NIMIQ_SIGN_MESSAGE_PREFIX = b"\x16Nimiq Signed Message:\n"`,
 * `prepare_message_for_signature`, `sign_message`. The keyguard
 * (`client/src/SignMessagePrefix.ts`) carries a second prefix,
 * `"\x19Nimiq Connect Challenge:\n"`, so both are tried and the caller is told which matched.
 *
 * Observed on a device: Nimiq Pay's `sign(message)` on Android uses the "Nimiq Signed Message"
 * prefix (the spike page's signature verified as that variant only, 2026-09-13), and this class
 * then verified the refund signature on mainnet order `a002870307c998de` in production
 * (2026-09-14). The connect-challenge prefix is still accepted; it widens nothing, because the
 * message bytes are still the exact challenge text. iOS has not been observed.
 *
 * The spike's Windows/undici teardown workaround is deliberately NOT here. It reaches into an
 * undocumented undici symbol and belongs only in short-lived test helpers.
 */

import { Hash, PublicKey, Signature } from '@nimiq/core';
import type {
  SignatureVerification,
  SignatureVerifier,
  SignedMessageVariant,
} from '../domain/ports.js';

export const SIGN_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n';
export const CONNECT_CHALLENGE_PREFIX = '\x19Nimiq Connect Challenge:\n';

const PREFIXES: ReadonlyArray<{ variant: SignedMessageVariant; prefix: string }> = [
  { variant: 'nimiq-signed-message', prefix: SIGN_MESSAGE_PREFIX },
  { variant: 'nimiq-connect-challenge', prefix: CONNECT_CHALLENGE_PREFIX },
];

const encoder = new TextEncoder();

const PUBLIC_KEY_HEX_LENGTH = 64; // 32 bytes
const SIGNATURE_HEX_LENGTH = 128; // 64 bytes

/** Lowercases, strips `0x` and whitespace. Returns null when the result is not hex. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase();
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return null;
  return /^[0-9a-f]+$/.test(cleaned) ? cleaned : null;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The exact bytes `prepare_message_for_signature` hashes. The length is the BYTE length of the
 * message rendered as ASCII decimal, not the character count — a challenge containing a
 * multi-byte character would sign differently under the two readings.
 */
export function signedMessagePreimage(message: string, prefix: string): Uint8Array {
  const body = encoder.encode(message);
  return concat(encoder.encode(prefix), encoder.encode(String(body.length)), body);
}

/** SHA-256 of the preimage: the 32 bytes Ed25519 actually signs. */
export function signedMessageDigest(message: string, prefix: string): Uint8Array {
  return Hash.computeSha256(signedMessagePreimage(message, prefix));
}

export class NimiqSignatureVerifier implements SignatureVerifier {
  async verify(
    message: string,
    publicKeyHex: string,
    signatureHex: string,
  ): Promise<SignatureVerification> {
    if (typeof message !== 'string') return { ok: false, reason: 'malformed' };

    const pkHex = normalizeHex(publicKeyHex);
    if (pkHex === null || pkHex.length !== PUBLIC_KEY_HEX_LENGTH) {
      return { ok: false, reason: 'bad_public_key' };
    }
    const sigHex = normalizeHex(signatureHex);
    if (sigHex === null || sigHex.length !== SIGNATURE_HEX_LENGTH) {
      return { ok: false, reason: 'malformed' };
    }

    let publicKey: PublicKey;
    try {
      publicKey = PublicKey.fromHex(pkHex);
    } catch {
      return { ok: false, reason: 'bad_public_key' };
    }

    let signature: Signature;
    try {
      signature = Signature.fromHex(sigHex);
    } catch {
      free(publicKey);
      return { ok: false, reason: 'malformed' };
    }

    try {
      let address: string;
      try {
        address = publicKey.toAddress().toUserFriendlyAddress();
      } catch {
        return { ok: false, reason: 'bad_public_key' };
      }

      for (const { variant, prefix } of PREFIXES) {
        let matched = false;
        try {
          matched = publicKey.verify(signature, signedMessageDigest(message, prefix));
        } catch {
          matched = false;
        }
        // The address is the point: the caller compares it with the refund destination.
        if (matched) return { ok: true, address, variant };
      }
      return { ok: false, reason: 'bad_signature' };
    } finally {
      // WASM-backed handles. Leaving many of them to the finaliser has been observed to abort
      // the process at teardown on Windows (spikes/sign-verify/README.md).
      free(publicKey);
      free(signature);
    }
  }
}

function free(handle: { free?: () => void }): void {
  try {
    handle.free?.();
  } catch {
    /* already freed */
  }
}
