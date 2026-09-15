/**
 * Readable text out of anything a `catch` can receive.
 *
 * Tapping Reject inside Nimiq Pay on Android (2026-09-15, on the payment and on the refund
 * signature) rendered "[object Object]": the wallet rejected with a value that was neither an
 * `Error` nor the SDK's documented `{ error: { type, message } }`, and the app called
 * `String()` on it. The exact shape was not captured, so none is assumed here: strings are
 * gathered from the usual keys, nested or not.
 */

/** Longest raw value shown on screen, so a phone screenshot can still carry it whole. */
const RAW_LIMIT = 200;

/** Strings that say nothing: `String()` of a plain object, a bare class name, empty. */
const GENERIC_TEXTS = new Set(['', '[object Object]', 'Error', 'undefined', 'null']);

/** An all-caps code such as `USER_CANCELED`: useful for matching, not as a sentence on screen. */
export const CODE_RE = /^[A-Z0-9_]+$/;

/** Every readable string in `value`, in key order, without duplicates. */
export function textsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return GENERIC_TEXTS.has(value.trim()) ? [] : [value.trim()];
  if (typeof value === 'number') return [String(value)];
  if (typeof value !== 'object' || value === null || depth > 3) return [];
  const record = value as Record<string, unknown>;
  const texts: string[] = [];
  for (const key of ['type', 'code', 'name', 'message', 'reason', 'error', 'data', 'cause']) {
    if (key in record) texts.push(...textsOf(record[key], depth + 1));
  }
  return [...new Set(texts)];
}

/** `value` as short text for the screen, for when it carries no readable string. */
export function rawOf(value: unknown): string {
  let raw: string;
  try {
    raw =
      value instanceof Error
        ? GENERIC_TEXTS.has(value.message.trim())
          ? `an ${value.name} with no readable message`
          : `${value.name}: ${value.message}`
        : (JSON.stringify(value) ?? String(value));
  } catch {
    raw = Object.prototype.toString.call(value);
  }
  return raw.length > RAW_LIMIT ? `${raw.slice(0, RAW_LIMIT)}…` : raw;
}

/** Screen text for any caught value: an `Error`'s own message, never "[object Object]". */
export function messageOf(err: unknown): string {
  if (err instanceof Error && !GENERIC_TEXTS.has(err.message.trim())) return err.message;
  const texts = textsOf(err).filter((text) => !CODE_RE.test(text));
  if (texts.length > 0) return texts.join(' — ');
  return `Something went wrong (${rawOf(err)}).`;
}
