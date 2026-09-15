/**
 * Chain-level primitives for Rewind. Framework free, dependency free, offline.
 *
 * Facts this file encodes, and where they come from:
 *  - 1 NIM = 100_000 Luna.                                    (Nimiq unit definition)
 *  - A transaction data field is at most 64 bytes.            (Nimiq protocol)
 *  - Sender must differ from recipient.                       (Nimiq protocol)
 *  - The public RPC returns a transaction with the fields in `RpcTransaction`.
 *    Observed on mainnet 2026-09-12 (`Hackathons/Nimiq hackathon/docs/evidence/E0-chain-access-2026-09-12.md`)
 *    and in production since 2026-09-14. The node also returns fields Rewind does not read,
 *    among them `fromType` and `toType` (0 basic, 2 HTLC), observed 2026-09-15.
 *
 * This file is pure: no I/O. `server/chain/rpc-chain-reader.ts` is what talks to the node.
 */

export const LUNA_PER_NIM = 100_000;

/** Nimiq transaction data field limit, in bytes. */
export const DATA_MAX_BYTES = 64;

/** Reference protocol version tag written into the data field. */
export const REF_VERSION = 'RW1';

export type RefKind = 'P' | 'R';

/**
 * A transaction record as returned by the public Nimiq RPC, unwrapped from the
 * `{ result: { data, metadata } }` envelope by the ChainReader adapter.
 *
 * Field names are taken verbatim from the E0 evidence document. `networkId` was
 * recorded as "present" without its concrete type, so both are accepted and it is
 * compared as a string. That looseness is deliberate and is a known gap.
 */
export interface RpcTransaction {
  hash: string;
  blockNumber: number | null;
  timestamp: number | null;
  confirmations: number | null;
  from: string;
  to: string;
  /** Luna. */
  value: number;
  /** Luna. */
  fee: number;
  /** Hex encoded data field. May be absent or empty for a bare transfer. */
  recipientData?: string;
  validityStartHeight: number;
  executionResult: boolean;
  networkId: number | string;
}

/**
 * An account record as returned by `getAccountByAddress`. Only the fields Rewind reads are
 * declared; the node returns more (an HTLC also carries `recipient`, `hashRoot`, `hashCount`,
 * `timeout`, `totalAmount`). `balance` is Luna.
 *
 * Observed live on `rpc.nimiqwatch.com` (2026-09-14, re-read 2026-09-15): a basic account is
 * `{"address","balance","type":"basic"}`, and a never-used address answers the same with
 * balance 0. `RpcChainReader.getAccountByAddress` still validates `balance` and treats anything
 * else as ChainUnavailableError rather than trusting the envelope.
 */
export interface RpcAccount {
  address: string;
  /** Luna. */
  balance: number;
  type?: string | number;
  /**
   * HTLC accounts only: the address that funded the contract. Observed live 2026-09-14 on
   * `rpc.nimiqwatch.com` as `{"type":"htlc","sender":"NQ87 …","recipient":…}` for the address
   * Nimiq Pay pays from.
   */
  sender?: string;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Formats Luna as NIM for display. Never used for comparison. */
export function formatLuna(luna: number): string {
  const sign = luna < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(luna));
  const whole = Math.floor(abs / LUNA_PER_NIM);
  const frac = String(abs % LUNA_PER_NIM).padStart(5, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''} NIM`;
}

// ---------------------------------------------------------------------------
// Hex / utf-8
// ---------------------------------------------------------------------------

const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

export function isHex(value: string): boolean {
  return HEX_RE.test(value);
}

export function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Returns null when the input is not valid hex or not valid utf-8. */
export function hexToUtf8(hex: string): string | null {
  if (!isHex(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Nimiq user friendly address: `NQ` + two check digits + 32 base32 characters,
 * written in nine space separated groups of four.
 *
 * The two check digits ARE verified, with the IBAN mod-97 routine Nimiq uses. Gap A1 in
 * README-DEV.md is closed: the routine was cross-checked on 2026-09-13 against two known-good
 * mainnet addresses and against `Address.fromString` in `@nimiq/core@2.21.0`
 * (`server/crypto/nimiq-address.test.ts`), and it rejects a transposed pair of characters.
 *
 * This function stays pure so the domain keeps no dependency on `@nimiq/core`. The crypto
 * adapter is the belt-and-braces check at the API boundary.
 */
const ADDRESS_SHAPE_RE = /^NQ\d{2}(?: [0-9A-HJ-NP-VXY]{4}){8}$/;

/**
 * IBAN mod-97 over `<base32 body> + NQ<check digits>`, letters mapped A=10 .. Z=35. The
 * remainder is carried digit by digit so nothing ever approaches Number.MAX_SAFE_INTEGER.
 * A correct address gives 1.
 */
function ibanMod97(input: string): number {
  let remainder = 0;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const mapped = code >= 48 && code <= 57 ? ch : String(code - 55);
    for (let i = 0; i < mapped.length; i++) {
      remainder = (remainder * 10 + (mapped.charCodeAt(i) - 48)) % 97;
    }
  }
  return remainder;
}

/** True when the two check digits of an already shape-valid grouped address are correct. */
export function hasValidCheckDigits(grouped: string): boolean {
  const compact = grouped.replace(/ /g, '');
  const body = compact.slice(4);
  const check = compact.slice(2, 4);
  return ibanMod97(`${body}NQ${check}`) === 1;
}

export function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_SHAPE_RE.test(value) && hasValidCheckDigits(value);
}

/** Uppercases and regroups an address. Returns null if the result is not well formed. */
export function normalizeAddress(value: string): string | null {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (compact.length !== 36) return null;
  const groups: string[] = [];
  for (let i = 0; i < 36; i += 4) groups.push(compact.slice(i, i + 4));
  const grouped = groups.join(' ');
  return isValidAddress(grouped) ? grouped : null;
}

/** Address equality after normalisation. Unparseable input is never equal to anything. */
export function addressEquals(a: string, b: string): boolean {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  return na !== null && nb !== null && na === nb;
}

// ---------------------------------------------------------------------------
// Transaction hashes
// ---------------------------------------------------------------------------

const TX_HASH_RE = /^[0-9a-f]{64}$/;

/** Blake2b-256 transaction hash, lowercase hex, as the RPC returns it. */
export function isValidTxHash(value: unknown): value is string {
  return typeof value === 'string' && TX_HASH_RE.test(value);
}

export function normalizeTxHash(value: string): string | null {
  const lower = value.trim().toLowerCase();
  return TX_HASH_RE.test(lower) ? lower : null;
}

// ---------------------------------------------------------------------------
// Order ids and the data-field reference
// ---------------------------------------------------------------------------

const ORDER_ID_RE = /^[0-9A-Za-z_-]{8,40}$/;

export function isValidOrderId(value: unknown): value is string {
  return typeof value === 'string' && ORDER_ID_RE.test(value);
}

/**
 * Builds the compact reference written into the transaction data field:
 *   payment `RW1:P:<orderId>`, refund `RW1:R:<orderId>`.
 * Throws if the result would not fit the 64 byte data field, so an over-long order id
 * can never reach a wallet call.
 */
export function buildReference(kind: RefKind, orderId: string): string {
  if (!isValidOrderId(orderId)) throw new Error(`invalid order id: ${String(orderId)}`);
  const ref = `${REF_VERSION}:${kind}:${orderId}`;
  const bytes = utf8ByteLength(ref);
  if (bytes > DATA_MAX_BYTES) {
    throw new Error(`reference is ${bytes} bytes, over the ${DATA_MAX_BYTES} byte data limit`);
  }
  return ref;
}

export interface ParsedReference {
  version: string;
  kind: RefKind;
  orderId: string;
}

/** Strict parse. Anything that is not exactly `RW1:P:<id>` or `RW1:R:<id>` returns null. */
export function parseReference(text: string): ParsedReference | null {
  const parts = text.split(':');
  if (parts.length !== 3) return null;
  const [version, kind, orderId] = parts as [string, string, string];
  if (version !== REF_VERSION) return null;
  if (kind !== 'P' && kind !== 'R') return null;
  if (!isValidOrderId(orderId)) return null;
  return { version, kind, orderId };
}

/** Decodes a `recipientData` hex field into a reference, or null. */
export function parseReferenceFromHex(hexData: string | undefined | null): ParsedReference | null {
  if (!hexData) return null;
  const text = hexToUtf8(hexData);
  if (text === null) return null;
  return parseReference(text);
}
