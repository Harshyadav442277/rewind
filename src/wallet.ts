/**
 * The only place the app talks to a wallet.
 *
 * Inside Nimiq Pay the provider is injected as `window.nimiq`; the type of that global comes
 * from `@nimiq/mini-app-sdk` itself, so it is not re-declared here. Outside Nimiq Pay in a
 * development build — a laptop browser running `npm run dev` — there is no provider, so
 * `FakeWallet` stands in and drives the server's development fake chain, and `isFakeWallet()`
 * lets the UI say so. A production build never uses the fake: without a provider every wallet
 * call answers "open this in Nimiq Pay", because the deployed server has no fake chain to drive.
 *
 * Facts read directly from the installed SDK typings (`@nimiq/mini-app-sdk@0.1.0`,
 * `dist/provider.d.ts`), which differ from the design notes in two ways worth knowing:
 *
 *   1. Every wallet call resolves to `Result | ErrorResponse`. A rejected native dialog can
 *      therefore come back as a RESOLVED promise carrying `{ error: { type, message } }`,
 *      not as a throw. Both are collapsed into one outcome here.
 *
 *   2. `sendBasicTransactionWithData` is documented as "@returns The serialized transaction",
 *      while nimiq.dev describes a hash. Both are handled: 64 hex characters are taken as a
 *      hash hint, anything else is reported as `serialized` and the client sends NO hint, so
 *      the server finds the payment by scanning the merchant address for `RW1:P:<orderId>`.
 *
 *      The hash is deliberately NOT derived client side from a serialised transaction. Doing
 *      it correctly means Blake2b over the Nimiq transaction's content, which means pulling
 *      `@nimiq/core`'s WASM into the phone bundle for a hint the server does not need. The
 *      scan already works and costs one RPC read.
 *
 * Why outcomes rather than exceptions: cancelling is the single most likely thing a user does
 * at a wallet dialog, and it is not an error. It gets its own status so no screen has to
 * pattern-match an error message to find out whether money moved. `error` means the wallet
 * refused or broke; `cancelled` means the user said no and NOTHING was sent.
 *
 * Observed inside Nimiq Pay on Android (2026-09-13 and 2026-09-14): `sign` and
 * `sendBasicTransactionWithData` ran against production and a local server, and the payments
 * and signatures they produced were verified on chain and server-side. The raw string a send
 * returns was not logged. Tapping Reject (2026-09-15) produced a value the first mapping could
 * not read and showed as "[object Object]"; its exact shape was not captured either, so the
 * mapping below reads any shape (`errors.ts`) and is proven only against a stubbed
 * `window.nimiq` (`wallet.test.ts`) until a device shows the cancelled screen.
 */

import type { ErrorResponse, SignatureResult } from '@nimiq/mini-app-sdk';
import { CODE_RE, rawOf, textsOf } from './errors';

export interface SendPaymentRequest {
  recipient: string;
  /** Luna. */
  value: number;
  /** Required by the provider; this app always sends the `RW1:P:<orderId>` reference. */
  data: string;
  fee?: number;
  validityStartHeight?: number;
}

/** What the provider handed back for a send, and what it turned out to be. */
export interface SentPayment {
  /** Exactly what the provider returned, untouched. */
  raw: string;
  /** Whether that string is usable as a pointer to the transaction. */
  kind: 'hash' | 'serialized';
  /** Lowercase 64-hex when `kind` is `hash`, otherwise null. A hint, never evidence. */
  txHash: string | null;
}

/**
 * Three outcomes, and the UI has to render all three. `cancelled` is not an error and never
 * means a payment may have gone out: the wallet refused before signing.
 */
export type WalletOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'cancelled'; message: string }
  | { status: 'error'; message: string; detail?: string };

/**
 * No `listAccounts`: Nimiq Pay pays out of a payment contract rather than from the first listed
 * account, so a listed account is not "the wallet that pays", and the refund destination comes
 * from the chain instead.
 */
export interface WalletAdapter {
  sign(message: string): Promise<WalletOutcome<SignatureResult>>;
  sendPayment(request: SendPaymentRequest): Promise<WalletOutcome<SentPayment>>;
}

const TX_HASH_RE = /^[0-9a-f]{64}$/;

/** True when the provider gave us something that is actually a transaction hash. */
export function looksLikeTxHash(value: string): boolean {
  return TX_HASH_RE.test(value.trim().toLowerCase());
}

export function classifySendResult(raw: string): SentPayment {
  const trimmed = raw.trim();
  return looksLikeTxHash(trimmed)
    ? { raw, kind: 'hash', txHash: trimmed.toLowerCase() }
    : { raw, kind: 'serialized', txHash: null };
}

/**
 * Words a wallet uses when the person said no. Matched against every readable string in what
 * the wallet returned, because the shape Nimiq Pay actually produces has not been captured.
 */
const CANCEL_RE = /cancel|reject|denied|declin|abort|dismiss|refus|user closed/i;

export function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (typeof error === 'object' && error !== null) || typeof error === 'string';
}

/**
 * One mapping for everything short of success, resolved or thrown. A cancel word anywhere
 * means cancelled. Anything else is an error carrying the wallet's own words, or the raw value
 * when it has none — never "[object Object]", and never "nothing was sent", because an
 * unrecognised answer to a send does not prove that.
 */
function outcomeFromFailure<T>(value: unknown): WalletOutcome<T> {
  // Kept so the real shape can be read from a remote-debugged WebView.
  console.warn('Rewind: wallet call did not succeed', value);
  const texts = textsOf(value);
  const words = texts.filter((text) => !CODE_RE.test(text));
  if (CANCEL_RE.test(texts.join(' '))) {
    const said = words.find((text) => CANCEL_RE.test(text));
    return { status: 'cancelled', message: said ?? 'You cancelled the wallet dialog.' };
  }
  const codes = texts.filter((text) => CODE_RE.test(text));
  if (words.length > 0) {
    return {
      status: 'error',
      message: words.join(' — '),
      ...(codes.length > 0 ? { detail: codes.join(' ') } : {}),
    };
  }
  if (codes.length > 0) return { status: 'error', message: codes.join(' ') };
  return {
    status: 'error',
    message: `The wallet did not complete that and gave no reason (it returned ${rawOf(value)}).`,
  };
}

/** An ErrorResponse the provider RESOLVED with. */
export function outcomeFromErrorResponse<T>(value: ErrorResponse): WalletOutcome<T> {
  return outcomeFromFailure<T>(value);
}

/** Anything the provider THREW, including a rejection carrying an ErrorResponse shape. */
export function outcomeFromThrown<T>(err: unknown): WalletOutcome<T> {
  return outcomeFromFailure<T>(err);
}

/** Collapses "resolved with an error object", "threw", and "resolved with a value". */
async function attempt<T>(run: () => Promise<T | ErrorResponse>): Promise<WalletOutcome<T>> {
  try {
    const result = await run();
    if (isErrorResponse(result)) return outcomeFromErrorResponse<T>(result);
    return { status: 'ok', value: result as T };
  } catch (err) {
    return outcomeFromThrown<T>(err);
  }
}

/** The address the FakeWallet pays from. Shape-valid, and not a wallet anyone holds. */
const FAKE_PAYER_ADDRESS = 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001';

async function devCall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch('/api/dev/fake-chain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = json.error as { message?: string } | undefined;
    throw new Error(error?.message ?? 'The development fake chain refused that.');
  }
  return json;
}

/**
 * Development stand-in, with the same three outcomes as the real adapter so no screen can be
 * written against a shape only the fake produces. It talks to `/api/dev/fake-chain`, which
 * only answers while the server is running the fake chain, so it cannot fabricate a payment.
 *
 * `cancelNext()` makes the next call come back cancelled, which is how the cancelled screens
 * are exercised without a phone.
 */
export class FakeWallet implements WalletAdapter {
  private cancelNextCall = false;

  cancelNext(): void {
    this.cancelNextCall = true;
  }

  private takeCancel(): boolean {
    const cancelling = this.cancelNextCall;
    this.cancelNextCall = false;
    return cancelling;
  }

  async sign(message: string): Promise<WalletOutcome<SignatureResult>> {
    if (this.takeCancel()) {
      return { status: 'cancelled', message: 'You cancelled the wallet dialog.' };
    }
    return attempt(async () => {
      const result = await devCall({ action: 'sign', address: FAKE_PAYER_ADDRESS, message });
      return { publicKey: String(result.publicKey), signature: String(result.signature) };
    });
  }

  async sendPayment(request: SendPaymentRequest): Promise<WalletOutcome<SentPayment>> {
    if (this.takeCancel()) {
      return { status: 'cancelled', message: 'You cancelled the wallet dialog.' };
    }
    return attempt(async () => {
      const result = await devCall({
        action: 'send',
        from: FAKE_PAYER_ADDRESS,
        to: request.recipient,
        valueLuna: request.value,
        data: request.data,
      });
      return classifySendResult(String(result.hash));
    });
  }
}

export class NimiqPayWallet implements WalletAdapter {
  async sign(message: string): Promise<WalletOutcome<SignatureResult>> {
    const provider = getProvider();
    if (!provider) return noProvider();
    return attempt(() => provider.sign(message));
  }

  async sendPayment(request: SendPaymentRequest): Promise<WalletOutcome<SentPayment>> {
    const provider = getProvider();
    if (!provider) return noProvider();
    // No sender parameter exists: the wallet chooses the account and shows a native
    // confirmation, which the user can cancel.
    const sent = await attempt<string>(() =>
      provider.sendBasicTransactionWithData({
        recipient: request.recipient,
        value: request.value,
        data: request.data,
        ...(request.fee === undefined ? {} : { fee: request.fee }),
        ...(request.validityStartHeight === undefined
          ? {}
          : { validityStartHeight: request.validityStartHeight }),
      }),
    );
    if (sent.status !== 'ok') return sent;
    if (typeof sent.value !== 'string' || sent.value.trim() === '') {
      // The wallet said yes but told us nothing. The payment may well be on its way, so this
      // is NOT reported as a failure to send — the server scans for the reference instead.
      return { status: 'ok', value: { raw: '', kind: 'serialized', txHash: null } };
    }
    return { status: 'ok', value: classifySendResult(sent.value) };
  }
}

type Provider = NonNullable<typeof window.nimiq>;

function getProvider(): Provider | undefined {
  return typeof window === 'undefined' ? undefined : window.nimiq;
}

export const NO_WALLET_MESSAGE =
  'There is no Nimiq wallet in this browser. Open Rewind inside the Nimiq Pay app to pay, sign or refund.';

function noProvider<T>(): WalletOutcome<T> {
  return { status: 'error', message: NO_WALLET_MESSAGE };
}

let fake: FakeWallet | null = null;
let real: NimiqPayWallet | null = null;

/** True when Nimiq Pay has injected its provider into this page. */
export function hasNimiqPay(): boolean {
  return getProvider() !== undefined;
}

/**
 * True only in a development build with no provider, where the fake wallet drives the dev
 * server's fake chain. A production build answers false, so it never pretends to have a wallet.
 */
export function isFakeWallet(): boolean {
  return !hasNimiqPay() && import.meta.env.DEV;
}

export function getWallet(): WalletAdapter {
  if (isFakeWallet()) {
    fake ??= new FakeWallet();
    return fake;
  }
  real ??= new NimiqPayWallet();
  return real;
}

/** Test aid, and the only way to clear the memoised adapters. */
export function resetWallet(): void {
  fake = null;
  real = null;
}
