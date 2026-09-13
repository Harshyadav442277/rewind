/**
 * Offline. An ephemeral key that has never held value, and a fake RPC. NOTHING IS BROADCAST.
 *
 * What this proves: the transaction builds, signs, passes `verify()` against mainnet rules,
 * round-trips through serialisation with an identical hash, converges on a 1 Luna/signed-byte
 * fee, and refuses the inputs that would produce an invalid or dangerous transfer. What it
 * does not prove: that a mainnet node accepts it. `pushTransaction` has never been called.
 */

import { describe, expect, it, vi } from 'vitest';
import { KeyPair, Policy, Transaction } from '@nimiq/core';
import {
  MAINNET_NETWORK_ID,
  RpcTxBroadcaster,
  TreasuryTxBuilder,
} from './treasury-broadcaster';
import type { FetchLike } from './rpc-chain-reader';
import { ChainUnavailableError } from '../domain/ports';
import { buildReference } from '../domain/nimiq';

/** In-memory only. Never persisted, never funded, never used twice. */
function ephemeralKeyHex(): string {
  return KeyPair.generate().privateKey.toHex();
}

const RECIPIENT = 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4JD';
const OTHER_RECIPIENT = 'NQ87 T28S MDL1 TUC7 7L8L 5BED J4HC KBM7 MUXR';

function builder(overrides: Partial<ConstructorParameters<typeof TreasuryTxBuilder>[0]> = {}) {
  return new TreasuryTxBuilder({ privateKeyHex: ephemeralKeyHex(), ...overrides });
}

const request = (over: Partial<Parameters<TreasuryTxBuilder['prepare']>[0]> = {}) => ({
  recipient: RECIPIENT,
  valueLuna: 1_000,
  data: buildReference('R', 'order1234'),
  feeLuna: 0,
  validityStartHeight: 61_480_000,
  ...over,
});

describe('TreasuryTxBuilder construction', () => {
  it('derives its own address from the key', () => {
    const b = builder();
    expect(b.address).toMatch(/^NQ\d{2}(?: [0-9A-HJ-NP-VXY]{4}){8}$/);
  });

  it.each([['', 'empty'], ['abc', 'short'], ['z'.repeat(64), 'non-hex']])(
    'refuses a %s key without echoing it',
    (key) => {
      let message = '';
      try {
        new TreasuryTxBuilder({ privateKeyHex: key });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe('treasury private key must be 64 hex characters');
      expect(message).not.toContain(key || 'NOTHING');
    },
  );

  it('reads the key from REWIND_TREASURY_PRIVATE_KEY and nowhere else', () => {
    const hex = ephemeralKeyHex();
    const b = TreasuryTxBuilder.fromEnv({ REWIND_TREASURY_PRIVATE_KEY: hex } as NodeJS.ProcessEnv);
    expect(b.address).toBe(new TreasuryTxBuilder({ privateKeyHex: hex }).address);
    expect(() => TreasuryTxBuilder.fromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /REWIND_TREASURY_PRIVATE_KEY is not set/,
    );
  });
});

describe('TreasuryTxBuilder.prepare', () => {
  it('builds a signed mainnet transaction that passes verify()', async () => {
    const b = builder();
    const prepared = await b.prepare(request());

    expect(prepared.from).toBe(b.address);
    expect(prepared.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.serializedTx).toMatch(/^[0-9a-f]+$/);
    expect(prepared.validityStartHeight).toBe(61_480_000);

    const tx = Transaction.fromAny(prepared.serializedTx);
    expect(() => tx.verify(Policy.MAX_SUPPORTED_VERSION, MAINNET_NETWORK_ID)).not.toThrow();
    expect(tx.networkId).toBe(MAINNET_NETWORK_ID);
    expect(tx.toPlain().network).toBe('mainalbatross');
  });

  it('round-trips through serialisation with identical fields and hash', async () => {
    const prepared = await builder().prepare(request());
    const tx = Transaction.fromAny(prepared.serializedTx);

    expect(tx.hash()).toBe(prepared.txHash);
    expect(tx.sender.toUserFriendlyAddress()).toBe(prepared.from);
    expect(tx.recipient.toUserFriendlyAddress()).toBe(RECIPIENT);
    expect(tx.value).toBe(1_000n);
    expect(tx.validityStartHeight).toBe(61_480_000);
    expect(new TextDecoder().decode(tx.data)).toBe('RW1:R:order1234');
    expect(Transaction.deserialize(tx.serialize()).toHex()).toBe(prepared.serializedTx);
  });

  it('sets the fee to 1 Luna per SIGNED byte, measured after the proof is attached', async () => {
    const prepared = await builder().prepare(request());
    const tx = Transaction.fromAny(prepared.serializedTx);
    // The point of the probe loop: fee == size of the SIGNED transaction, not the unsigned one.
    expect(Number(tx.fee)).toBe(tx.serializedSize);
    expect(tx.serializedSize).toBeGreaterThan(150); // the ~98-byte signature proof is included
    expect(tx.feePerByte).toBe(1);
  });

  it('honours an explicit feeLuna instead of the per-byte model', async () => {
    const prepared = await builder().prepare(request({ feeLuna: 7 }));
    expect(Number(Transaction.fromAny(prepared.serializedTx).fee)).toBe(7);
  });

  it('scales the fee with a larger data field', async () => {
    const small = await builder({ privateKeyHex: ephemeralKeyHex() }).prepare(request({ data: '' }));
    const large = await builder({ privateKeyHex: ephemeralKeyHex() }).prepare(
      request({ data: 'x'.repeat(64) }),
    );
    const smallTx = Transaction.fromAny(small.serializedTx);
    const largeTx = Transaction.fromAny(large.serializedTx);
    expect(Number(largeTx.fee)).toBeGreaterThan(Number(smallTx.fee));
    expect(Number(largeTx.fee)).toBe(largeTx.serializedSize);
  });

  it('is deterministic: the same inputs and key give the same bytes and the same hash', async () => {
    const hex = ephemeralKeyHex();
    const a = await new TreasuryTxBuilder({ privateKeyHex: hex }).prepare(request());
    const b = await new TreasuryTxBuilder({ privateKeyHex: hex }).prepare(request());
    // Re-preparing after a crash must never produce a second, different transaction.
    expect(b.serializedTx).toBe(a.serializedTx);
    expect(b.txHash).toBe(a.txHash);
  });

  it('produces different bytes for a different validity start height', async () => {
    const hex = ephemeralKeyHex();
    const a = await new TreasuryTxBuilder({ privateKeyHex: hex }).prepare(request());
    const b = await new TreasuryTxBuilder({ privateKeyHex: hex }).prepare(
      request({ validityStartHeight: 61_480_001 }),
    );
    // Which is exactly why prepareRefundExecution is a compare-and-set: two preparers a block
    // apart would otherwise commit two different transactions, i.e. two refunds.
    expect(b.txHash).not.toBe(a.txHash);
  });

  it('refuses a data field over 64 bytes, which TransactionBuilder itself would accept', async () => {
    await expect(builder().prepare(request({ data: 'x'.repeat(65) }))).rejects.toThrow(
      /65 bytes, over the 64 byte limit/,
    );
  });

  it('refuses a self-transfer', async () => {
    const b = builder();
    await expect(b.prepare(request({ recipient: b.address }))).rejects.toThrow(
      /sender and recipient are the same/,
    );
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('refuses the value %s', async (valueLuna) => {
    await expect(builder().prepare(request({ valueLuna }))).rejects.toThrow(/positive integer/);
  });

  it('refuses a recipient with bad check digits', async () => {
    const corrupted = 'NQ14 E6Y2 Y9CC 8GVY 1163 VBMJ YP54 QACN V4DJ';
    await expect(builder().prepare(request({ recipient: corrupted }))).rejects.toThrow(
      /invalid Nimiq address/,
    );
  });

  it('refuses a negative validity start height', async () => {
    await expect(builder().prepare(request({ validityStartHeight: -1 }))).rejects.toThrow(
      /invalid validityStartHeight/,
    );
  });

  it('signs for the other recipient differently', async () => {
    const hex = ephemeralKeyHex();
    const a = await new TreasuryTxBuilder({ privateKeyHex: hex }).prepare(request());
    const b = await new TreasuryTxBuilder({ privateKeyHex: hex }).prepare(
      request({ recipient: OTHER_RECIPIENT }),
    );
    expect(b.txHash).not.toBe(a.txHash);
    expect(Transaction.fromAny(b.serializedTx).recipient.toUserFriendlyAddress()).toBe(
      OTHER_RECIPIENT,
    );
  });
});

describe('RpcTxBroadcaster (fake RPC — nothing leaves the machine)', () => {
  function fakeRpc(response: { status?: number; body: unknown }) {
    const sent: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      const status = response.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () =>
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
      };
    };
    return { sent, fetchImpl };
  }

  const HASH = 'a'.repeat(64);

  it('calls pushTransaction with one raw-hex parameter and returns the hash', async () => {
    const { sent, fetchImpl } = fakeRpc({
      body: { jsonrpc: '2.0', result: { data: HASH, metadata: null }, id: 1 },
    });
    const broadcaster = new RpcTxBroadcaster({ endpoint: 'https://rpc.invalid', fetchImpl });
    expect(await broadcaster.broadcast('DEADBEEF')).toEqual({ hash: HASH });
    // pushTransaction, not sendRawTransaction: it validates into the mempool.
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'pushTransaction',
      params: ['deadbeef'],
    });
  });

  it('surfaces a node rejection as a plain error, not as unavailability', async () => {
    const { fetchImpl } = fakeRpc({
      body: { jsonrpc: '2.0', error: { code: -32603, message: 'Rejected: Invalid transaction' }, id: 1 },
    });
    const broadcaster = new RpcTxBroadcaster({ endpoint: 'https://rpc.invalid', fetchImpl });
    const promise = broadcaster.broadcast('deadbeef');
    await expect(promise).rejects.toThrow(/pushTransaction rejected/);
    await expect(promise).rejects.not.toBeInstanceOf(ChainUnavailableError);
  });

  it('reports a 503 as unavailable', async () => {
    const { fetchImpl } = fakeRpc({ status: 503, body: 'down' });
    const broadcaster = new RpcTxBroadcaster({ endpoint: 'https://rpc.invalid', fetchImpl });
    await expect(broadcaster.broadcast('deadbeef')).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('refuses a result that is not a transaction hash', async () => {
    const { fetchImpl } = fakeRpc({ body: { jsonrpc: '2.0', result: { data: true }, id: 1 } });
    const broadcaster = new RpcTxBroadcaster({ endpoint: 'https://rpc.invalid', fetchImpl });
    await expect(broadcaster.broadcast('deadbeef')).rejects.toThrow(/unexpected result/);
  });

  it('refuses to send anything that is not hex', async () => {
    const fetchImpl = vi.fn();
    const broadcaster = new RpcTxBroadcaster({
      endpoint: 'https://rpc.invalid',
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    await expect(broadcaster.broadcast('not-a-transaction')).rejects.toThrow(/not hex/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a built transaction reaches the broadcaster as the exact bytes that were prepared', async () => {
    const prepared = await builder().prepare(request());
    const { sent, fetchImpl } = fakeRpc({
      body: { jsonrpc: '2.0', result: { data: prepared.txHash }, id: 1 },
    });
    const broadcaster = new RpcTxBroadcaster({ endpoint: 'https://rpc.invalid', fetchImpl });
    const result = await broadcaster.broadcast(prepared.serializedTx);
    expect(result.hash).toBe(prepared.txHash);
    expect((sent[0] as { params: string[] }).params[0]).toBe(prepared.serializedTx);
  });
});
