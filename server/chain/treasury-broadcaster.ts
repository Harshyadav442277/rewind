/**
 * The Demo Store treasury signer and the real broadcaster.
 *
 * This is the only code in Rewind that holds a private key, and it holds exactly one: the
 * capped demo treasury's, read from `REWIND_TREASURY_PRIVATE_KEY`. It is never logged, never
 * returned, never written to disk and never put in an error message. A buyer's key never
 * reaches the server at all — buyers sign in Nimiq Pay and the server only verifies.
 *
 * Everything below follows `spikes/server-tx/build-tx.mjs`, which was run on this machine on
 * 2026-09-13:
 *
 *   - mainnet Albatross `networkId` is 24 (23 and 25 throw "Unknown network ID", and a real
 *     mainnet transaction reports 24);
 *   - the fee is 1 Luna per SIGNED serialised byte. The signature proof is about 98 bytes, so
 *     sizing an unsigned transaction under-pays by roughly half: build, sign, measure, set the
 *     fee, re-measure until the size stops moving. The fee itself is a fixed-width u64, so the
 *     loop converges in one or two rounds;
 *   - `TransactionBuilder` does NOT enforce the 64-byte data cap. Only `verify()` does, with
 *     "Overflow". The cap is therefore checked twice here, before and after;
 *   - broadcast with `pushTransaction`, not `sendRawTransaction`: both take one raw-hex
 *     parameter and return the hash, but `pushTransaction` validates into the mempool, so a
 *     transaction the node will not relay fails loudly instead of vanishing.
 *
 * UNVERIFIED: nothing built by this class has ever been broadcast. The unit tests use an
 * ephemeral key and a fake RPC, and assert the build, the fee convergence, `verify()` and the
 * serialisation round trip. No treasury has been funded and `pushTransaction` has never been
 * called from this repository.
 */

import {
  Address,
  KeyPair,
  Policy,
  PrivateKey,
  Transaction,
  TransactionBuilder,
} from '@nimiq/core';
import { DATA_MAX_BYTES, utf8ByteLength } from '../domain/nimiq';
import { ChainUnavailableError, type PreparedRefundTx, type RefundTxBuilder, type RefundTxRequest, type TxBroadcaster } from '../domain/ports';
import { requireAddress } from '../crypto/nimiq-address';
import type { FetchLike } from './rpc-chain-reader';

/** Mainnet Albatross. Observed two independent ways in spikes/server-tx, 2026-09-13. */
export const MAINNET_NETWORK_ID = 24;

/** Luna per SIGNED serialised byte when the caller does not pin an absolute fee. */
export const DEFAULT_FEE_PER_BYTE = 1;

export interface TreasuryTxBuilderOptions {
  /** 32-byte Ed25519 private key, hex. Never logged and never leaves this object. */
  privateKeyHex: string;
  networkId?: number;
  feePerByte?: number;
}

export class TreasuryTxBuilder implements RefundTxBuilder {
  private readonly keyPair: KeyPair;
  private readonly networkId: number;
  private readonly feePerByte: number;
  /** Cached so the address is derived once, not per refund. */
  readonly address: string;

  constructor(options: TreasuryTxBuilderOptions) {
    const hex = options.privateKeyHex?.trim();
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      // Deliberately says nothing about the value it saw.
      throw new Error('treasury private key must be 64 hex characters');
    }
    this.keyPair = KeyPair.derive(PrivateKey.fromHex(hex));
    this.networkId = options.networkId ?? MAINNET_NETWORK_ID;
    this.feePerByte = options.feePerByte ?? DEFAULT_FEE_PER_BYTE;
    this.address = this.keyPair.toAddress().toUserFriendlyAddress();
  }

  /** Reads the key from the environment. The only place that variable is read. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TreasuryTxBuilder {
    const hex = env.REWIND_TREASURY_PRIVATE_KEY;
    if (!hex) throw new Error('REWIND_TREASURY_PRIVATE_KEY is not set');
    const networkId = env.REWIND_NETWORK_ID ? Number(env.REWIND_NETWORK_ID) : undefined;
    return new TreasuryTxBuilder({
      privateKeyHex: hex,
      ...(Number.isInteger(networkId) ? { networkId: networkId as number } : {}),
    });
  }

  async prepare(request: RefundTxRequest): Promise<PreparedRefundTx> {
    const recipient = Address.fromString(requireAddress(request.recipient));
    const sender = this.keyPair.toAddress();
    if (sender.equals(recipient)) {
      throw new Error('refund sender and recipient are the same address; the protocol rejects it');
    }
    if (!Number.isSafeInteger(request.valueLuna) || request.valueLuna <= 0) {
      throw new Error(`refund value must be a positive integer of Luna, got ${request.valueLuna}`);
    }
    if (utf8ByteLength(request.data) > DATA_MAX_BYTES) {
      // TransactionBuilder would accept this and verify() would then throw "Overflow".
      throw new Error(
        `refund data is ${utf8ByteLength(request.data)} bytes, over the ${DATA_MAX_BYTES} byte limit`,
      );
    }
    if (!Number.isSafeInteger(request.validityStartHeight) || request.validityStartHeight < 0) {
      throw new Error(`invalid validityStartHeight ${request.validityStartHeight}`);
    }

    const dataBytes = new TextEncoder().encode(request.data);
    const build = (fee: bigint): Transaction => {
      const tx = TransactionBuilder.newBasicWithData(
        sender,
        recipient,
        dataBytes,
        BigInt(request.valueLuna),
        fee,
        request.validityStartHeight,
        this.networkId,
      );
      tx.sign(this.keyPair, undefined);
      return tx;
    };

    const fee =
      request.feeLuna > 0 ? BigInt(request.feeLuna) : this.convergeFee(build);
    const tx = build(fee);

    // Local consensus gate. Throws on an over-long data field, sender == recipient, zero
    // value, a bad signature or an unknown network.
    tx.verify(Policy.MAX_SUPPORTED_VERSION, this.networkId);

    const prepared: PreparedRefundTx = {
      serializedTx: tx.toHex(),
      txHash: tx.hash(),
      from: sender.toUserFriendlyAddress(),
      validityStartHeight: request.validityStartHeight,
    };
    return prepared;
  }

  /**
   * Sign a probe, measure it, set the fee, re-measure. The fee is a fixed-width u64 so the
   * size does not normally move once the proof is present, but the loop re-checks rather than
   * assuming it.
   */
  private convergeFee(build: (fee: bigint) => Transaction): bigint {
    let size = build(0n).serializedSize;
    for (let i = 0; i < 4; i++) {
      const fee = BigInt(Math.ceil(size * this.feePerByte));
      const next = build(fee).serializedSize;
      if (next === size) return fee;
      size = next;
    }
    throw new Error('fee and serialised size did not converge');
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export interface RpcTxBroadcasterOptions {
  endpoint: string;
  timeoutMs?: number;
  authorization?: string | undefined;
  fetchImpl?: FetchLike;
}

/**
 * `pushTransaction` is idempotent for identical bytes: a node that already has the transaction
 * answers with the same hash rather than creating a second one. That is what makes crash
 * recovery safe — recovery re-sends the stored bytes, never rebuilds them.
 */
export class RpcTxBroadcaster implements TxBroadcaster {
  private id = 0;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: RpcTxBroadcasterOptions) {
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
  }

  async broadcast(serializedTx: string): Promise<{ hash: string }> {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(serializedTx)) {
      throw new Error('serialised transaction is not hex');
    }
    this.id += 1;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.authorization ? { authorization: this.options.authorization } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.id,
          method: 'pushTransaction',
          params: [serializedTx.toLowerCase()],
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ChainUnavailableError(`pushTransaction: http ${response.status}`);
      }
      let body: { result?: { data?: unknown }; error?: { code: number; message: string } };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new ChainUnavailableError('pushTransaction: response was not JSON');
      }
      if (body.error) {
        // A rejected transaction is not "unavailable": the node looked at it and said no.
        throw new Error(`pushTransaction rejected: [${body.error.code}] ${body.error.message}`);
      }
      const hash = body.result?.data;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new ChainUnavailableError(`pushTransaction: unexpected result ${JSON.stringify(hash)}`);
      }
      return { hash };
    } finally {
      clearTimeout(timer);
    }
  }
}
