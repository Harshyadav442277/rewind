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
 * Run on mainnet from production (Vercel): this class built and `RpcTxBroadcaster` pushed the
 * Demo Store refund `0989689ee542375659559e5a73196d3f3cf0e622f03785b2de553097e5006507`
 * (block 61,603,650, 2026-09-14, 1000 Luna + 188 Luna fee, `executionResult` true). It also
 * built `ca84b355…`, which the chain included with `executionResult` false because its
 * recipient was an HTLC; that is why refunds now go to an HTLC's funder. The unit tests use an
 * ephemeral key and a fake RPC.
 */

import {
  Address,
  KeyPair,
  Policy,
  PrivateKey,
  Transaction,
  TransactionBuilder,
} from '@nimiq/core';
import { DATA_MAX_BYTES, utf8ByteLength } from '../domain/nimiq.js';
import { ChainUnavailableError, type PreparedRefundTx, type RefundTxBuilder, type RefundTxRequest, type TxBroadcaster } from '../domain/ports.js';
import { requireAddress } from '../crypto/nimiq-address.js';
import { defaultNetworkId, NETWORK_IDS } from './network.js';
import type { FetchLike } from './rpc-chain-reader.js';

/** Mainnet Albatross. Observed two independent ways in spikes/server-tx, 2026-09-13. */
export const MAINNET_NETWORK_ID = NETWORK_IDS.mainnet;

/** Luna per SIGNED serialised byte when the caller does not pin an absolute fee. */
export const DEFAULT_FEE_PER_BYTE = 1;

/**
 * The networkId a treasury signer should use when nothing pins one. `REWIND_NETWORK_ID` wins;
 * otherwise `REWIND_NETWORK` decides (`network.ts`). Signing for the wrong network produces a
 * transaction every node rejects, so this default and the domain's `networkId` must agree —
 * both derive from the same variables, and `network.test.ts` holds them together.
 */
export function treasuryNetworkIdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.REWIND_NETWORK_ID ? Number(env.REWIND_NETWORK_ID) : NaN;
  if (Number.isInteger(explicit)) return explicit;
  return defaultNetworkId(env);
}

/**
 * A serialised transaction is lowercase hex, whole bytes, or it is not a transaction. Returns
 * the normalised form so identical input always sends identical bytes, which is what makes
 * re-broadcast on recovery idempotent.
 */
export function normalizeSerializedTx(serializedTx: string): string {
  if (typeof serializedTx !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(serializedTx)) {
    throw new Error('serialised transaction is not hex');
  }
  return serializedTx.toLowerCase();
}

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
    return new TreasuryTxBuilder({
      privateKeyHex: hex,
      networkId: treasuryNetworkIdFromEnv(env),
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
    const hex = normalizeSerializedTx(serializedTx);
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
          params: [hex],
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
