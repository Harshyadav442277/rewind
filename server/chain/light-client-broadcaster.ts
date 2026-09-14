/**
 * `TxBroadcaster` over the `@nimiq/core` light client. Dev-only, for the testnet rehearsal.
 *
 * The transaction itself is still built and signed by `TreasuryTxBuilder` in
 * `treasury-broadcaster.ts` — the fee convergence on the SIGNED size, the 64-byte data cap
 * checked twice, and the local `verify()` gate are that class's, not copied here. This file is
 * only the transport: where `RpcTxBroadcaster` POSTs `pushTransaction` to a node,
 * `LightClientTxBroadcaster` hands the same bytes to the client's own libp2p connection.
 *
 * Two behaviours differ from the RPC broadcaster and both come from the spike
 * (`spikes/light-client/README.md` §5, observed on testnet 2026-09-13):
 *
 *  1. `client.sendTransaction` BLOCKS until inclusion. It returned after 5.8 s already
 *     carrying `state: "included"`, `blockHeight` and `executionResult: true`. It is not
 *     fire-and-forget, so a refund broadcast holds its request open for the better part of a
 *     block. `pushTransaction` returns as soon as the node accepts into its mempool.
 *  2. There is no node between this process and the network to reject a malformed or
 *     wrong-network transaction, so the bytes are re-verified locally against the configured
 *     networkId before they are sent — `verifySerializedTx`, the same gate the builder ran.
 *
 * Idempotence, which is what crash recovery depends on: re-sending identical bytes is the same
 * transaction with the same hash. The hash is computed from the bytes here and compared with
 * whatever the client reports, so a mismatch is an error rather than a second transaction
 * quietly becoming the one of record.
 *
 * UNVERIFIED as of writing: nothing in the mainnet path uses this class, and it must not.
 * `REWIND_CHAIN=lightclient` is refused in production (`api/_lib/deps.ts`).
 */

import type { TxBroadcaster } from '../domain/ports.js';
import { ChainUnavailableError } from '../domain/ports.js';
import {
  getSharedLightClient,
  type LightClient,
  type NetworkName,
} from './light-client-chain-reader.js';
import { normalizeSerializedTx, verifySerializedTx } from './treasury-broadcaster.js';

export interface LightClientTxBroadcasterOptions {
  /** Compared against the transaction's own network before sending. */
  networkId: number;
  /** Supplied in tests. In the app this resolves the per-process singleton. */
  client?: LightClient | (() => Promise<LightClient>);
  network?: NetworkName;
}

export class LightClientTxBroadcaster implements TxBroadcaster {
  private readonly resolveClient: () => Promise<LightClient>;

  constructor(private readonly options: LightClientTxBroadcasterOptions) {
    const supplied = options.client;
    this.resolveClient =
      typeof supplied === 'function'
        ? supplied
        : supplied
          ? async () => supplied
          : () => getSharedLightClient(options.network ? { network: options.network } : {});
  }

  async broadcast(serializedTx: string): Promise<{ hash: string }> {
    const hex = normalizeSerializedTx(serializedTx);
    // Throws for a bad signature, an over-long data field, sender == recipient, or the wrong
    // network. A rejection here is a refusal to send, not a chain outage.
    const { hash: expectedHash } = verifySerializedTx(hex, this.options.networkId);

    let client: LightClient;
    try {
      client = await this.resolveClient();
    } catch (err) {
      throw new ChainUnavailableError(`light client is not ready: ${describe(err)}`, err);
    }

    let details: { transactionHash?: string; state?: string; blockHeight?: number | null };
    try {
      details = await client.sendTransaction(hex);
    } catch (err) {
      // "We could not send it" is not "the network rejected it", and the two must not be
      // conflated: an unavailable answer leaves the stored bytes to be re-sent unchanged,
      // which is exactly what recovery does.
      throw new ChainUnavailableError(`light client sendTransaction: ${describe(err)}`, err);
    }

    const reported = details?.transactionHash;
    if (typeof reported === 'string' && reported.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(
        `light client returned hash ${reported}, expected ${expectedHash} for the bytes it was given`,
      );
    }
    return { hash: expectedHash };
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
