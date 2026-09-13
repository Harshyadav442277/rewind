/**
 * The real adapter's result mapping, against a stubbed `window.nimiq`.
 *
 * What this proves: that every shape the SDK typings allow — a resolved value, a resolved
 * ErrorResponse, a rejection carrying an Error, a rejection carrying a bare ErrorResponse
 * object — lands on exactly one of `ok` / `cancelled` / `error`, and that a cancel is never
 * mistaken for a failure or the other way round.
 *
 * What it does NOT prove: anything about Nimiq Pay. No wallet has run this code. The stub is
 * built from `@nimiq/mini-app-sdk@0.1.0`'s `dist/provider.d.ts`, which is a type declaration,
 * not an observation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySendResult,
  FakeWallet,
  FAKE_PAYER_ADDRESS,
  getWallet,
  isFakeWallet,
  looksLikeTxHash,
  NimiqPayWallet,
  outcomeFromThrown,
  resetWallet,
  shortAddress,
} from './wallet';

const HASH = 'a'.repeat(64);
const SERIALIZED = '0100' + 'bc'.repeat(80); // long, hex, and not 64 characters

type Stub = Record<string, unknown>;

function installProvider(stub: Stub): void {
  (window as unknown as { nimiq?: unknown }).nimiq = stub;
}

afterEach(() => {
  delete (window as unknown as { nimiq?: unknown }).nimiq;
  resetWallet();
  vi.unstubAllGlobals();
});

describe('classifying what a send returns', () => {
  it('takes 64 hex characters as a usable hash hint', () => {
    expect(looksLikeTxHash(HASH)).toBe(true);
    expect(classifySendResult(HASH)).toEqual({ raw: HASH, kind: 'hash', txHash: HASH });
  });

  it('lowercases and trims a hash before using it', () => {
    const shouty = `  ${'AB'.repeat(32)}  `;
    expect(classifySendResult(shouty).txHash).toBe('ab'.repeat(32));
  });

  it('treats a serialised transaction as no hint at all, not as a bad hash', () => {
    const result = classifySendResult(SERIALIZED);
    expect(result.kind).toBe('serialized');
    expect(result.txHash).toBeNull();
    expect(result.raw).toBe(SERIALIZED);
  });

  it.each(['', 'not hex', 'a'.repeat(63), 'a'.repeat(65), `${HASH}00`])(
    'does not mistake %s for a hash',
    (value) => {
      expect(looksLikeTxHash(value)).toBe(false);
    },
  );
});

describe('NimiqPayWallet result mapping', () => {
  it('returns ok with the accounts the wallet lists', async () => {
    installProvider({ listAccounts: async () => [FAKE_PAYER_ADDRESS, 'NQ11 ABCD'] });
    await expect(new NimiqPayWallet().listAccounts()).resolves.toEqual({
      status: 'ok',
      value: [FAKE_PAYER_ADDRESS, 'NQ11 ABCD'],
    });
  });

  it('maps a RESOLVED ErrorResponse that reads like a cancel to cancelled', async () => {
    installProvider({
      sign: async () => ({ error: { type: 'USER_CANCELED', message: 'User canceled the request' } }),
    });
    await expect(new NimiqPayWallet().sign('hello')).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('maps a REJECTION that reads like a cancel to cancelled', async () => {
    installProvider({
      sign: async () => {
        throw new Error('The user rejected the signature request');
      },
    });
    await expect(new NimiqPayWallet().sign('hello')).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('maps a rejection carrying a bare ErrorResponse object to cancelled', async () => {
    installProvider({
      sign: async () => Promise.reject({ error: { type: 'ABORTED', message: '' } }),
    });
    await expect(new NimiqPayWallet().sign('hello')).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('keeps a genuine failure as an error, not a cancel', async () => {
    installProvider({
      sign: async () => ({ error: { type: 'INTERNAL', message: 'consensus not established' } }),
    });
    await expect(new NimiqPayWallet().sign('hello')).resolves.toEqual({
      status: 'error',
      message: 'consensus not established',
      detail: 'INTERNAL',
    });
  });

  it('returns the signature untouched when the wallet signs', async () => {
    installProvider({ sign: async () => ({ publicKey: 'aa', signature: 'bb' }) });
    await expect(new NimiqPayWallet().sign('hello')).resolves.toEqual({
      status: 'ok',
      value: { publicKey: 'aa', signature: 'bb' },
    });
  });

  it('passes only the fields the provider was given, and reports a hash hint', async () => {
    const calls: unknown[] = [];
    installProvider({
      sendBasicTransactionWithData: async (tx: unknown) => {
        calls.push(tx);
        return HASH;
      },
    });
    const result = await new NimiqPayWallet().sendPayment({
      recipient: 'NQ11 ABCD',
      value: 1_000,
      data: 'RW1:P:abc',
    });
    expect(result).toEqual({
      status: 'ok',
      value: { raw: HASH, kind: 'hash', txHash: HASH },
    });
    // No sender parameter exists, and optional fields left out must not be sent as undefined.
    expect(calls[0]).toEqual({ recipient: 'NQ11 ABCD', value: 1_000, data: 'RW1:P:abc' });
  });

  it('forwards fee and validityStartHeight only when they were given', async () => {
    const calls: unknown[] = [];
    installProvider({
      sendBasicTransactionWithData: async (tx: unknown) => {
        calls.push(tx);
        return HASH;
      },
    });
    await new NimiqPayWallet().sendPayment({
      recipient: 'NQ11 ABCD',
      value: 1,
      data: 'x',
      fee: 5,
      validityStartHeight: 99,
    });
    expect(calls[0]).toMatchObject({ fee: 5, validityStartHeight: 99 });
  });

  it('reports a serialised transaction as ok with no hash, so the server scans', async () => {
    installProvider({ sendBasicTransactionWithData: async () => SERIALIZED });
    await expect(
      new NimiqPayWallet().sendPayment({ recipient: 'NQ11', value: 1, data: 'x' }),
    ).resolves.toEqual({
      status: 'ok',
      value: { raw: SERIALIZED, kind: 'serialized', txHash: null },
    });
  });

  it('treats an empty answer as sent-but-unknown rather than as a failure', async () => {
    installProvider({ sendBasicTransactionWithData: async () => '' });
    await expect(
      new NimiqPayWallet().sendPayment({ recipient: 'NQ11', value: 1, data: 'x' }),
    ).resolves.toEqual({ status: 'ok', value: { raw: '', kind: 'serialized', txHash: null } });
  });

  it('reports a cancelled send as cancelled, which means nothing was sent', async () => {
    installProvider({
      sendBasicTransactionWithData: async () => ({
        error: { type: 'REQUEST_DENIED', message: 'Denied in wallet' },
      }),
    });
    await expect(
      new NimiqPayWallet().sendPayment({ recipient: 'NQ11', value: 1, data: 'x' }),
    ).resolves.toMatchObject({ status: 'cancelled', message: 'Denied in wallet' });
  });

  it('reports an error, not a crash, when there is no provider at all', async () => {
    await expect(new NimiqPayWallet().listAccounts()).resolves.toMatchObject({ status: 'error' });
  });
});

describe('outcomeFromThrown', () => {
  it.each([
    ['user cancelled', 'cancelled'],
    ['Request was rejected', 'cancelled'],
    ['User declined', 'cancelled'],
    ['network unreachable', 'error'],
    ['', 'error'],
  ])('maps %s to %s', (message, status) => {
    expect(outcomeFromThrown(new Error(message)).status).toBe(status);
  });

  it('handles a non-Error rejection', () => {
    expect(outcomeFromThrown('boom')).toEqual({ status: 'error', message: 'boom' });
  });
});

describe('FakeWallet parity', () => {
  it('has the same three outcomes and can be told to cancel', async () => {
    const wallet = new FakeWallet();
    await expect(wallet.listAccounts()).resolves.toEqual({
      status: 'ok',
      value: [FAKE_PAYER_ADDRESS],
    });
    wallet.cancelNext();
    await expect(wallet.sign('x')).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('turns a fake-chain refusal into an error outcome, not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          ok: false,
          json: async () => ({ error: { message: 'fake chain is disabled' } }),
        }) as unknown as Response,
    );
    await expect(new FakeWallet().sign('x')).resolves.toEqual({
      status: 'error',
      message: 'fake chain is disabled',
    });
  });

  it('classifies what the fake chain returns exactly as the real adapter would', async () => {
    vi.stubGlobal(
      'fetch',
      async () => ({ ok: true, json: async () => ({ hash: HASH }) }) as unknown as Response,
    );
    await expect(
      new FakeWallet().sendPayment({ recipient: 'NQ11', value: 1, data: 'x' }),
    ).resolves.toEqual({ status: 'ok', value: { raw: HASH, kind: 'hash', txHash: HASH } });
  });
});

describe('wallet selection', () => {
  it('uses the fake wallet when no provider is present, and says so', () => {
    expect(isFakeWallet()).toBe(true);
    expect(getWallet()).toBeInstanceOf(FakeWallet);
  });

  it('uses the real adapter as soon as a provider exists', () => {
    installProvider({ listAccounts: async () => [] });
    expect(isFakeWallet()).toBe(false);
    expect(getWallet()).toBeInstanceOf(NimiqPayWallet);
  });
});

describe('shortAddress', () => {
  it('keeps enough of an address to tell two apart', () => {
    expect(shortAddress(FAKE_PAYER_ADDRESS)).toBe('NQ64P4…0001');
  });

  it('leaves a short string alone', () => {
    expect(shortAddress('NQ11 AB')).toBe('NQ11 AB');
  });
});
