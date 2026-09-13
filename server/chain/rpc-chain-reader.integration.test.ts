/**
 * LIVE. Reads the public Nimiq mainnet node. Skipped unless RUN_RPC_TESTS=1.
 *
 *   RUN_RPC_TESTS=1 npx vitest run server/chain/rpc-chain-reader.integration.test.ts
 *
 * Read-only: getBlockNumber, getTransactionByHash, getTransactionsByAddress. Nothing is signed
 * and nothing is sent. The public node allows roughly 20 tokens per 10 s per IP, so this file
 * makes a handful of calls with a delay between them and must stay that way.
 *
 * The sampled transaction is the one recorded in the E0 evidence document on 2026-09-12. It is
 * a real, long-confirmed mainnet transaction, so its immutable fields (hash, block, from, to,
 * value, fee, networkId, validityStartHeight) are fixtures; `confirmations` is not, and is only
 * asserted to be growing.
 */

import { describe, expect, it } from 'vitest';
import { RpcChainReader } from './rpc-chain-reader';
import { systemClock } from '../domain/fakes';
import { isValidAddress } from '../domain/nimiq';

const RUN = process.env.RUN_RPC_TESTS === '1';
const ENDPOINT = process.env.NIMIQ_RPC_URL ?? 'https://rpc.nimiqwatch.com';

/** From docs/evidence/E0-chain-access-2026-09-12.md. A staking-contract transfer. */
const KNOWN_HASH = '90fca75b3a3bc3e35c0d8e74144df323e12c80914b497c51aa78f2fb1ede7616';
const KNOWN_BLOCK = 61420752;

const pause = (ms = 1_500) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.runIf(RUN)('RpcChainReader against mainnet', () => {
  const reader = new RpcChainReader({ endpoint: ENDPOINT, clock: systemClock, timeoutMs: 15_000 });

  it('reads a plausible mainnet block height', async () => {
    const read = await reader.getBlockNumber();
    // eslint-disable-next-line no-console
    console.log(`[live] getBlockNumber -> ${read.data} at ${new Date(read.fetchedAtMs).toISOString()}`);
    expect(read.source).toBe('network');
    // Mainnet was at 61,420,705 on 2026-09-12. Testnet was ~11 million: the gap is the check.
    expect(read.data).toBeGreaterThan(61_000_000);
    await pause();
  });

  it('reads the known transaction by hash and parses every field the predicate needs', async () => {
    const read = await reader.getTransactionByHash(KNOWN_HASH);
    // eslint-disable-next-line no-console
    console.log(`[live] getTransactionByHash ->\n${JSON.stringify(read.data, null, 2)}`);
    const tx = read.data;
    expect(tx).not.toBeNull();
    if (!tx) return;

    expect(tx.hash).toBe(KNOWN_HASH);
    expect(tx.blockNumber).toBe(KNOWN_BLOCK);
    expect(tx.validityStartHeight).toBe(KNOWN_BLOCK);
    expect(tx.value).toBe(1565);
    expect(tx.fee).toBe(0);
    expect(tx.executionResult).toBe(true);
    expect(String(tx.networkId)).toBe('24'); // mainnet Albatross
    expect(tx.timestamp).toBe(1789229039990);
    expect(isValidAddress(tx.from)).toBe(true);
    expect(isValidAddress(tx.to)).toBe(true);
    // Confirmations only grow.
    expect(tx.confirmations).toBeGreaterThan(30);
    await pause();
  });

  it('reports an unknown hash as pending (null), not as an error', async () => {
    // A random 32-byte value. The node answers -32603 "Transaction not found".
    const random = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const read = await reader.getTransactionByHash(random);
    // eslint-disable-next-line no-console
    console.log(`[live] getTransactionByHash(${random.slice(0, 16)}...) -> ${JSON.stringify(read.data)}`);
    expect(read.data).toBeNull();
    expect(read.source).toBe('network');
    await pause();
  });

  it('pages an address with three parameters and every row carries the expected fields', async () => {
    // The staking contract, the busy address sampled in the E0 evidence document.
    const address = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001';
    const page = await reader.getTransactionsByAddress(address, 3, null);
    // eslint-disable-next-line no-console
    console.log(
      `[live] getTransactionsByAddress -> ${page.data.length} rows: ` +
        JSON.stringify(
          page.data.map((t) => ({
            hash: t.hash,
            blockNumber: t.blockNumber,
            value: t.value,
            recipientData: t.recipientData,
          })),
          null,
          2,
        ),
    );
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length).toBeGreaterThan(0);
    for (const tx of page.data) {
      expect(tx.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(isValidAddress(tx.from)).toBe(true);
      expect(isValidAddress(tx.to)).toBe(true);
      expect(String(tx.networkId)).toBe('24');
      expect(typeof tx.executionResult).toBe('boolean');
      // recipientData is hex when present. The domain decodes it looking for RW1:P:<orderId>.
      if (tx.recipientData) expect(tx.recipientData).toMatch(/^(?:[0-9a-f]{2})*$/);
    }
  });
});

describe.runIf(!RUN)('RpcChainReader against mainnet', () => {
  it('is skipped without RUN_RPC_TESTS=1', () => {
    expect(RUN).toBe(false);
  });
});
