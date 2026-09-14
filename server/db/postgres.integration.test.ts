/**
 * `PostgresRepository` and `schema.sql`, executed against a real Postgres engine.
 *
 * The engine is PGlite: Postgres compiled to WebAssembly, running inside this Node process.
 * No Docker, no service, no install beyond one dev dependency, and no socket — the suite
 * stays offline. If the package is missing or cannot start, every test here skips with a
 * message rather than failing, because `npm test` must run on a machine with no database.
 *
 * What this file is for: the in-memory repository proves the money rules against a JavaScript
 * Map. Production runs on Neon. Every guarantee the domain relies on — one refund reservation
 * per order, compare-and-set of the intended transaction bytes, single-use challenge and
 * merchant nonces, one treasury ledger row per order — is re-proved here through the SQL that
 * will actually run, statement for statement.
 *
 * What it does NOT prove is recorded at the top of `postgres.ts` and in README-DEV.md: the
 * Neon driver itself, and multi-session contention.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresRepository } from './postgres.js';
import { pgliteExecutor, type EmbeddedPostgres } from './pglite-executor.js';
import { CONSTRAINTS, NotFoundError, UniqueViolationError } from './repository.js';
import type { Repository } from './repository.js';
import type { MerchantNonce, Order, RefundChallenge, RefundExecution } from '../domain/types.js';
import type { DomainDeps } from '../domain/deps.js';
import type { ChainReader } from '../domain/ports.js';
import { DEFAULT_TREASURY_CAPS } from '../domain/demo-treasury.js';
import {
  executeTreasuryRefund,
  reserveRefund,
  rejectRefund,
  resumeUnsettledRefunds,
  settleRefund,
  submitSignedRefundRequest,
} from '../domain/refund-reservation.js';
import {
  AMOUNT_LUNA,
  DEMO_MERCHANT,
  OTHER,
  PAYER,
  PLAIN_MERCHANT,
  TREASURY,
  createPaidOrder,
  makeHarnessOver,
  orderAwaitingApproval,
  signRefundRequest,
  type HarnessOver,
} from '../domain/test-helpers.js';

const embedded: EmbeddedPostgres | null = await pgliteExecutor();

if (!embedded) {
  console.warn(
    '[postgres.integration] SKIPPED: no embedded Postgres engine available. ' +
      'Install the dev dependency with `npm install` (@electric-sql/pglite) and re-run ' +
      '`npm run test:db`. The Postgres repository is UNTESTED without it.',
  );
}

const NOW = 1_700_000_000_000;

function orderRow(over: Partial<Order> = {}): Order {
  return {
    id: 'ord_fixture_1',
    state: 'CREATED',
    merchantId: DEMO_MERCHANT.id,
    merchantAddress: TREASURY,
    itemLabel: 'Refund Test — 0.01 NIM',
    amountLuna: AMOUNT_LUNA,
    networkId: '24',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 15 * 60 * 1000,
    paymentTxHash: null,
    payerAddress: null,
    paidAt: null,
    paymentBlockNumber: null,
    claimedPaymentTxHash: null,
    refundSource: 'DEMO_TREASURY',
    refunderAddress: TREASURY,
    lastError: null,
    ...over,
  };
}

function challengeRow(over: Partial<RefundChallenge> = {}): RefundChallenge {
  return {
    nonce: 'n'.repeat(32),
    orderId: 'ord_fixture_1',
    message: 'Rewind refund request\nnonce=…',
    refundTo: PAYER,
    amountLuna: AMOUNT_LUNA,
    paymentTxHash: 'a'.repeat(64),
    expiresAtSec: Math.floor(NOW / 1000) + 300,
    createdAt: NOW,
    consumedAt: null,
    signaturePublicKey: null,
    signatureHex: null,
    signerAddress: null,
    ...over,
  };
}

function executionRow(over: Partial<RefundExecution> = {}): RefundExecution {
  return {
    id: 'rex_fixture_1',
    orderId: 'ord_fixture_1',
    challengeNonce: 'n'.repeat(32),
    refundTo: PAYER,
    amountLuna: AMOUNT_LUNA,
    refunderAddress: TREASURY,
    source: 'DEMO_TREASURY',
    intendedTxHash: null,
    serializedTx: null,
    validityStartHeight: null,
    preparedAt: null,
    broadcastAt: null,
    refundTxHash: null,
    confirmedAt: null,
    refundBlockNumber: null,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function merchantNonceRow(over: Partial<MerchantNonce> = {}): MerchantNonce {
  return {
    nonce: 'm'.repeat(64),
    merchantId: DEMO_MERCHANT.id,
    merchantAddress: TREASURY,
    action: 'approve',
    orderId: 'ord_fixture_1',
    message: 'Rewind merchant approval\n…',
    createdAt: NOW,
    expiresAtSec: Math.floor(NOW / 1000) + 120,
    consumedAt: null,
    signerAddress: null,
    ...over,
  };
}

describe.skipIf(!embedded)('PostgresRepository against a real Postgres engine', () => {
  const db = embedded as EmbeddedPostgres;
  let repo: Repository;

  beforeAll(async () => {
    await db.applySchema();
    console.info(`[postgres.integration] engine: ${db.engine}`);
    repo = new PostgresRepository(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.truncateAll();
    for (const m of [DEMO_MERCHANT, PLAIN_MERCHANT]) {
      await db.query(
        'INSERT INTO merchants (id, name, address, allow_treasury_refund) VALUES ($1, $2, $3, $4)',
        [m.id, m.name, m.address, m.allowTreasuryRefund],
      );
    }
  });

  // -------------------------------------------------------------------------
  // The schema itself
  // -------------------------------------------------------------------------

  describe('schema.sql', () => {
    it('creates every table the repository writes to', async () => {
      const rows = await db.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
        [],
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'demo_refunds',
        'merchant_nonces',
        'merchants',
        'orders',
        'refund_challenges',
        'refund_executions',
      ]);
    });

    it('is re-runnable: applying it twice changes nothing and raises nothing', async () => {
      await db.applySchema();
      const rows = await db.query('SELECT count(*)::int AS n FROM merchants', []);
      expect(rows[0]?.n).toBe(2);
    });

    it('names the unique indexes the application catches by name', async () => {
      const rows = await db.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
        [],
      );
      const names = new Set(rows.map((r) => String(r.indexname)));
      for (const constraint of Object.values(CONSTRAINTS)) {
        expect(names.has(constraint), `missing index ${constraint}`).toBe(true);
      }
    });

    it('refuses a self-refund and a zero amount at the database, not just in code', async () => {
      await repo.createOrder(orderRow());
      await expect(repo.createOrder(orderRow({ id: 'ord_zero', amountLuna: 0 }))).rejects.toThrow(
        /amount_luna/,
      );
      await expect(
        repo.createOrder(orderRow({ id: 'ord_self', payerAddress: TREASURY, paymentTxHash: 'b'.repeat(64) })),
      ).rejects.toThrow(/orders_payer_not_refunder/);
    });
  });

  // -------------------------------------------------------------------------
  // BIGINT and TIMESTAMPTZ — the two coercions flagged as most likely wrong
  // -------------------------------------------------------------------------

  describe('type round-tripping', () => {
    it('round-trips a Luna amount at the top of the exactly-representable range', async () => {
      const big = Number.MAX_SAFE_INTEGER; // 9007199254740991
      await repo.createOrder(orderRow({ id: 'ord_big', amountLuna: big }));
      const read = await repo.getOrder('ord_big');
      expect(read?.amountLuna).toBe(big);

      // And the database really is holding the same integer, digit for digit.
      const raw = await db.query('SELECT amount_luna::text AS a FROM orders WHERE id = $1', [
        'ord_big',
      ]);
      expect(raw[0]?.a).toBe('9007199254740991');
    });

    it('refuses, rather than rounds, a BIGINT too large for a JS number', async () => {
      // Written past the repository on purpose: nothing in the app can produce this, but a
      // migration, a manual fix or another writer could. Rounding it would move money.
      await db.query(
        `INSERT INTO orders (id, state, merchant_id, merchant_address, item_label, amount_luna,
           network_id, created_at, updated_at, expires_at, refund_source, refunder_address)
         VALUES ('ord_huge', 'CREATED', $1, $2, 'x', 9007199254740993, '24',
           now(), now(), now(), 'DEMO_TREASURY', $2)`,
        [DEMO_MERCHANT.id, TREASURY],
      );
      await expect(repo.getOrder('ord_huge')).rejects.toThrow(/cannot be represented exactly/);
    });

    it('round-trips every timestamp to the millisecond', async () => {
      const created = NOW + 123;
      const paid = NOW + 456;
      await repo.createOrder(
        orderRow({
          id: 'ord_ts',
          createdAt: created,
          updatedAt: created,
          expiresAt: created + 900_000,
          state: 'PAID',
          paymentTxHash: 'c'.repeat(64),
          payerAddress: PAYER,
          paidAt: paid,
          paymentBlockNumber: 61_480_679,
        }),
      );
      const read = await repo.getOrder('ord_ts');
      expect(read?.createdAt).toBe(created);
      expect(read?.expiresAt).toBe(created + 900_000);
      expect(read?.paidAt).toBe(paid);
      expect(read?.paymentBlockNumber).toBe(61_480_679);
    });

    it('keeps null as null, never as zero or empty string', async () => {
      await repo.createOrder(orderRow({ id: 'ord_nulls' }));
      const read = await repo.getOrder('ord_nulls');
      expect(read?.paymentTxHash).toBeNull();
      expect(read?.payerAddress).toBeNull();
      expect(read?.paidAt).toBeNull();
      expect(read?.paymentBlockNumber).toBeNull();
      expect(read?.claimedPaymentTxHash).toBeNull();
      expect(read?.lastError).toBeNull();
    });

    it('reads back a boolean as a boolean', async () => {
      expect((await repo.getMerchant(DEMO_MERCHANT.id))?.allowTreasuryRefund).toBe(true);
      expect((await repo.getMerchant(PLAIN_MERCHANT.id))?.allowTreasuryRefund).toBe(false);
      expect(await repo.getMerchant('nobody')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Unique violations must arrive as the domain's own error, by constraint name
  // -------------------------------------------------------------------------

  describe('unique violations surface as UniqueViolationError', () => {
    it('names the constraint for a duplicate order id', async () => {
      await repo.createOrder(orderRow());
      await expect(repo.createOrder(orderRow())).rejects.toMatchObject({
        name: 'UniqueViolationError',
        constraint: CONSTRAINTS.orderId,
      });
    });

    it('names the constraint when two orders claim the same payment', async () => {
      const hash = 'd'.repeat(64);
      await repo.createOrder(
        orderRow({ id: 'ord_a', state: 'PAID', paymentTxHash: hash, payerAddress: PAYER }),
      );
      await expect(
        repo.createOrder(
          orderRow({ id: 'ord_b', state: 'PAID', paymentTxHash: hash, payerAddress: PAYER }),
        ),
      ).rejects.toMatchObject({ constraint: CONSTRAINTS.orderPaymentTx });
    });

    it('names the constraint for a second refund obligation on one order', async () => {
      await repo.createOrder(orderRow());
      await repo.createChallenge(challengeRow());
      await repo.createRefundExecution(executionRow());
      await expect(
        repo.createRefundExecution(executionRow({ id: 'rex_fixture_2' })),
      ).rejects.toMatchObject({ constraint: CONSTRAINTS.executionOrder });
    });

    it('names the constraint for a re-issued merchant nonce', async () => {
      await repo.createOrder(orderRow());
      await repo.createMerchantNonce(merchantNonceRow());
      await expect(repo.createMerchantNonce(merchantNonceRow())).rejects.toMatchObject({
        constraint: CONSTRAINTS.merchantNonce,
      });
    });

    it('names the constraint for a second ledger row on one order', async () => {
      await repo.createOrder(orderRow());
      const row = {
        id: 'dled_1',
        orderId: 'ord_fixture_1',
        walletAddress: PAYER,
        amountLuna: AMOUNT_LUNA,
        createdAt: NOW,
      };
      await repo.appendDemoRefund(row);
      await expect(repo.appendDemoRefund({ ...row, id: 'dled_2' })).rejects.toMatchObject({
        constraint: CONSTRAINTS.demoLedgerOrder,
      });
    });

    it('names the constraint when one refund transaction would settle two orders', async () => {
      const hash = 'e'.repeat(64);
      await repo.createOrder(orderRow());
      await repo.createChallenge(challengeRow());
      await repo.createRefundExecution(executionRow());
      await repo.createOrder(orderRow({ id: 'ord_2' }));
      await repo.createChallenge(challengeRow({ nonce: 'p'.repeat(32), orderId: 'ord_2' }));
      await repo.createRefundExecution(
        executionRow({ id: 'rex_2', orderId: 'ord_2', challengeNonce: 'p'.repeat(32) }),
      );

      await repo.updateRefundExecution('rex_fixture_1', {
        refundTxHash: hash,
        confirmedAt: NOW,
        refundBlockNumber: 1,
        updatedAt: NOW,
      });
      await expect(
        repo.updateRefundExecution('rex_2', { refundTxHash: hash, updatedAt: NOW }),
      ).rejects.toMatchObject({ constraint: CONSTRAINTS.executionRefundTx });
    });
  });

  // -------------------------------------------------------------------------
  // Compare-and-set, including genuine parallel attempts
  // -------------------------------------------------------------------------

  describe('compare-and-set', () => {
    it('returns null, and changes nothing, when the order already moved', async () => {
      await repo.createOrder(orderRow());
      const moved = await repo.updateOrder('ord_fixture_1', 'CREATED', {
        state: 'PAYMENT_PENDING',
        updatedAt: NOW + 1,
      });
      expect(moved?.state).toBe('PAYMENT_PENDING');

      const loser = await repo.updateOrder('ord_fixture_1', 'CREATED', {
        state: 'EXPIRED',
        updatedAt: NOW + 2,
      });
      expect(loser).toBeNull();
      expect((await repo.getOrder('ord_fixture_1'))?.state).toBe('PAYMENT_PENDING');
    });

    it('distinguishes "already moved" from "no such order"', async () => {
      await expect(repo.updateOrder('nope', 'CREATED', { state: 'EXPIRED' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('clears claimed_payment_tx_hash and last_error when the patch says null', async () => {
      await repo.createOrder(orderRow({ claimedPaymentTxHash: 'f'.repeat(64), lastError: 'boom' }));
      const cleared = await repo.updateOrder('ord_fixture_1', 'CREATED', {
        claimedPaymentTxHash: null,
        lastError: null,
        updatedAt: NOW + 1,
      });
      expect(cleared?.claimedPaymentTxHash).toBeNull();
      expect(cleared?.lastError).toBeNull();
    });

    it('leaves untouched columns alone on a partial patch', async () => {
      await repo.createOrder(orderRow({ claimedPaymentTxHash: 'f'.repeat(64) }));
      const patched = await repo.updateOrder('ord_fixture_1', 'CREATED', {
        state: 'PAYMENT_PENDING',
        updatedAt: NOW + 1,
      });
      expect(patched?.claimedPaymentTxHash).toBe('f'.repeat(64));
      expect(patched?.itemLabel).toBe('Refund Test — 0.01 NIM');
      expect(patched?.amountLuna).toBe(AMOUNT_LUNA);
    });

    it('gives exactly one winner when eight callers reserve the same order at once', async () => {
      await repo.createOrder(orderRow());
      await repo.createChallenge(challengeRow());

      const attempts = Array.from({ length: 8 }, (_unused, i) =>
        repo
          .createRefundExecution(executionRow({ id: `rex_race_${i}` }))
          .then(() => 'won' as const)
          .catch((err: unknown) =>
            err instanceof UniqueViolationError ? (`lost:${err.constraint}` as const) : Promise.reject(err),
          ),
      );
      const outcomes = await Promise.all(attempts);

      expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
      expect(outcomes.filter((o) => o === `lost:${CONSTRAINTS.executionOrder}`)).toHaveLength(7);
      const stored = await db.query('SELECT count(*)::int AS n FROM refund_executions', []);
      expect(stored[0]?.n).toBe(1);
    });

    it('gives exactly one winner when eight callers prepare the same execution at once', async () => {
      await repo.createOrder(orderRow());
      await repo.createChallenge(challengeRow());
      await repo.createRefundExecution(executionRow());

      const attempts = Array.from({ length: 8 }, (_unused, i) =>
        repo.prepareRefundExecution('rex_fixture_1', {
          serializedTx: `bytes-${i}`,
          intendedTxHash: `${i}`.repeat(64),
          validityStartHeight: 1_000 + i,
          preparedAt: NOW,
          updatedAt: NOW,
        }),
      );
      const results = await Promise.all(attempts);
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      const stored = await repo.getRefundExecution('rex_fixture_1');
      expect(stored?.serializedTx).toBe(winners[0]?.serializedTx);
      expect(stored?.intendedTxHash).toBe(winners[0]?.intendedTxHash);
      expect(stored?.validityStartHeight).toBe(winners[0]?.validityStartHeight);
    });

    it('tells a preparer for a missing execution apart from a preparer that lost', async () => {
      await expect(
        repo.prepareRefundExecution('rex_missing', { serializedTx: 'x', updatedAt: NOW }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('consumes a challenge nonce exactly once under eight parallel replays', async () => {
      await repo.createOrder(orderRow());
      await repo.createChallenge(challengeRow());

      const attempts = Array.from({ length: 8 }, () =>
        repo.consumeChallenge('n'.repeat(32), {
          consumedAt: NOW,
          signaturePublicKey: '11'.repeat(32),
          signatureHex: '22'.repeat(64),
          signerAddress: PAYER,
        }),
      );
      const results = await Promise.all(attempts);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect((await repo.getChallenge('n'.repeat(32)))?.consumedAt).toBe(NOW);
    });

    it('returns null for a challenge nonce that was never issued', async () => {
      expect(
        await repo.consumeChallenge('z'.repeat(32), {
          consumedAt: NOW,
          signaturePublicKey: 'a',
          signatureHex: 'b',
          signerAddress: PAYER,
        }),
      ).toBeNull();
    });

    it('consumes a merchant nonce exactly once under eight parallel replays', async () => {
      await repo.createOrder(orderRow());
      await repo.createMerchantNonce(merchantNonceRow());

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.consumeMerchantNonce('m'.repeat(64), { consumedAt: NOW, signerAddress: TREASURY }),
        ),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect((await repo.getMerchantNonce('m'.repeat(64)))?.signerAddress).toBe(TREASURY);
    });

    it('returns null for a merchant nonce this server never issued', async () => {
      expect(
        await repo.consumeMerchantNonce('q'.repeat(64), {
          consumedAt: NOW,
          signerAddress: TREASURY,
        }),
      ).toBeNull();
    });

    it('purges only expired merchant nonces and reports how many went', async () => {
      await repo.createOrder(orderRow());
      const nowSec = Math.floor(NOW / 1000);
      await repo.createMerchantNonce(merchantNonceRow({ nonce: 'a'.repeat(64), expiresAtSec: nowSec - 1 }));
      await repo.createMerchantNonce(merchantNonceRow({ nonce: 'b'.repeat(64), expiresAtSec: nowSec - 2 }));
      await repo.createMerchantNonce(merchantNonceRow({ nonce: 'c'.repeat(64), expiresAtSec: nowSec + 60 }));

      expect(await repo.purgeExpiredMerchantNonces(nowSec)).toBe(2);
      expect(await repo.getMerchantNonce('c'.repeat(64))).not.toBeNull();
      expect(await repo.getMerchantNonce('a'.repeat(64))).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Lists and the recovery worklist
  // -------------------------------------------------------------------------

  describe('queries the recovery worker and the merchant board depend on', () => {
    it('lists unsettled executions oldest first and drops settled and failed ones', async () => {
      await repo.createOrder(orderRow({ id: 'o1' }));
      await repo.createOrder(orderRow({ id: 'o2' }));
      await repo.createOrder(orderRow({ id: 'o3' }));
      for (const [i, id] of ['o1', 'o2', 'o3'].entries()) {
        await repo.createChallenge(challengeRow({ nonce: `${i}`.repeat(32), orderId: id }));
        await repo.createRefundExecution(
          executionRow({
            id: `rex_${id}`,
            orderId: id,
            challengeNonce: `${i}`.repeat(32),
            createdAt: NOW + i,
            updatedAt: NOW + i,
          }),
        );
      }
      await repo.updateRefundExecution('rex_o2', {
        refundTxHash: 'e'.repeat(64),
        confirmedAt: NOW,
        updatedAt: NOW,
      });
      await repo.updateRefundExecution('rex_o3', { failureReason: 'dead', updatedAt: NOW });

      const unsettled = await repo.listUnsettledRefundExecutions();
      expect(unsettled.map((e) => e.id)).toEqual(['rex_o1']);
    });

    it('finds an order by its verified payment hash, and lists newest first', async () => {
      const hash = '9'.repeat(64);
      await repo.createOrder(orderRow({ id: 'old', createdAt: NOW - 1_000, updatedAt: NOW - 1_000 }));
      await repo.createOrder(
        orderRow({ id: 'new', state: 'PAID', paymentTxHash: hash, payerAddress: PAYER }),
      );
      expect((await repo.getOrderByPaymentTx(hash))?.id).toBe('new');
      expect(await repo.getOrderByPaymentTx('0'.repeat(64))).toBeNull();
      expect((await repo.listOrders()).map((o) => o.id)).toEqual(['new', 'old']);
      expect((await repo.listOrders(1)).map((o) => o.id)).toEqual(['new']);
    });

    it('filters the treasury ledger by wallet and by window', async () => {
      await repo.createOrder(orderRow({ id: 'l1' }));
      await repo.createOrder(orderRow({ id: 'l2' }));
      await repo.appendDemoRefund({
        id: 'dled_1', orderId: 'l1', walletAddress: PAYER, amountLuna: 1_000, createdAt: NOW - 10_000,
      });
      await repo.appendDemoRefund({
        id: 'dled_2', orderId: 'l2', walletAddress: OTHER, amountLuna: 2_000, createdAt: NOW,
      });

      expect(await repo.listDemoRefundsSince(0)).toHaveLength(2);
      expect(await repo.listDemoRefundsSince(NOW - 1)).toHaveLength(1);
      const mine = await repo.listDemoRefundsForWalletSince(PAYER, 0);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.amountLuna).toBe(1_000);
      expect(mine[0]?.createdAt).toBe(NOW - 10_000);
      expect(await repo.listDemoRefundsForWalletSince(PAYER, NOW)).toHaveLength(0);
    });

    it('lists an order’s challenges newest first', async () => {
      await repo.createOrder(orderRow());
      await repo.createChallenge(challengeRow({ nonce: '1'.repeat(32), createdAt: NOW }));
      await repo.createChallenge(challengeRow({ nonce: '2'.repeat(32), createdAt: NOW + 5 }));
      const listed = await repo.listChallengesForOrder('ord_fixture_1');
      expect(listed.map((c) => c.nonce)).toEqual(['2'.repeat(32), '1'.repeat(32)]);
      expect(await repo.listChallengesForOrder('nobody')).toHaveLength(0);
    });

    it('lists merchants in id order', async () => {
      expect((await repo.listMerchants()).map((m) => m.id)).toEqual(['demo-store', 'shop']);
    });
  });

  // -------------------------------------------------------------------------
  // The same domain guarantees the in-memory tests prove, through Postgres
  // -------------------------------------------------------------------------

  describe('the money rules, run over Postgres', () => {
    const harness = (config: Parameters<typeof makeHarnessOver>[1] = {}): HarnessOver =>
      makeHarnessOver(repo, config);

    it('accepts a signed refund request from the wallet that paid', async () => {
      const h = harness();
      const order = await createPaidOrder(h);
      const signed = await signRefundRequest(h, order.id);

      const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.order.state).toBe('REFUND_REQUESTED');
      expect(result.challenge.consumedAt).not.toBeNull();
    });

    it('accepts a signature from another address and still refunds only the payer', async () => {
      const h = harness();
      const order = await createPaidOrder(h);
      const signed = await signRefundRequest(h, order.id, OTHER);

      const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.challenge.signerAddress).toBe(OTHER);

      const reserved = await reserveRefund(h.deps, order.id);
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      expect(reserved.execution.refundTo).toBe(PAYER);
    });

    it('refuses a replayed challenge nonce', async () => {
      const h = harness();
      const order = await createPaidOrder(h);
      const signed = await signRefundRequest(h, order.id);

      expect((await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed })).ok).toBe(true);
      const replay = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
      expect(replay.ok).toBe(false);
      if (replay.ok) return;
      expect(replay.reason).toBe('nonce_already_used');
    });

    it('refuses two parallel presentations of the same signature, accepting one', async () => {
      const h = harness();
      const order = await createPaidOrder(h);
      const signed = await signRefundRequest(h, order.id);

      const results = await Promise.all([
        submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed }),
        submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed }),
        submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await repo.getOrder(order.id))?.state).toBe('REFUND_REQUESTED');
    });

    it('produces one reservation and one refund from two concurrent approvals', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);

      const [a, b] = await Promise.all([
        reserveRefund(h.deps, order.id),
        reserveRefund(h.deps, order.id),
      ]);
      const outcomes = [a, b].map((r) =>
        r.ok ? (r.alreadyReserved ? 'existing' : 'new') : `fail:${r.reason}`,
      );
      expect(outcomes.filter((o) => o === 'new')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'existing')).toHaveLength(1);
      expect(await repo.listUnsettledRefundExecutions()).toHaveLength(1);

      await executeTreasuryRefund(h.deps, order.id);
      expect(h.broadcaster.distinctSentCount()).toBe(1);
    });

    it('refuses to reject an order that already carries an obligation', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, order.id);
      expect(await rejectRefund(h.deps, order.id)).toBeNull();
      expect((await repo.getOrder(order.id))?.state).not.toBe('REJECTED');
    });

    it('sends one transaction when two senders race and the block height moves between them', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, order.id);

      const inner = h.deps.chain;
      const drifting: ChainReader = {
        getBlockNumber: async () => {
          h.chain.advanceHeight(1);
          return inner.getBlockNumber();
        },
        getTransactionByHash: (hash) => inner.getTransactionByHash(hash),
        getAccountByAddress: (address) => inner.getAccountByAddress(address),
        getTransactionsByAddress: (address, max, startAt) =>
          inner.getTransactionsByAddress(address, max, startAt),
      };
      const deps: DomainDeps = { ...h.deps, chain: drifting };

      await Promise.all([
        executeTreasuryRefund(deps, order.id),
        executeTreasuryRefund(deps, order.id),
      ]);

      expect(h.builder.prepared.length).toBeGreaterThanOrEqual(1);
      expect(h.broadcaster.distinctSentCount()).toBe(1);
      const execution = await repo.getRefundExecutionByOrder(order.id);
      expect(h.broadcaster.sent[0]).toBe(execution?.serializedTx);
    });

    it('restarts: a second process adopts the stored bytes instead of building a second transaction', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, order.id);

      // The first process persists its bytes and then dies before the broadcast.
      h.broadcaster.outcome = 'throw_before_send';
      await executeTreasuryRefund(h.deps, order.id);
      const before = await repo.getRefundExecutionByOrder(order.id);
      expect(before?.serializedTx).not.toBeNull();
      expect(before?.intendedTxHash).not.toBeNull();
      expect(h.broadcaster.sent).toHaveLength(0);

      // A second process, with its OWN repository object over the same database, reads the
      // row. It must not create a second execution and must not prepare a second time.
      const second: Repository = new PostgresRepository(db);
      const revived: DomainDeps = { ...h.deps, repo: second };
      h.broadcaster.outcome = 'ok';

      const lost = await second.prepareRefundExecution(before?.id ?? '', {
        serializedTx: 'a-different-transaction',
        intendedTxHash: '7'.repeat(64),
        validityStartHeight: 99_999,
        updatedAt: NOW,
      });
      expect(lost).toBeNull();

      const resumed = await resumeUnsettledRefunds(revived);
      expect(resumed.resent).toBe(1);
      const after = await second.getRefundExecutionByOrder(order.id);
      expect(after?.serializedTx).toBe(before?.serializedTx);
      expect(after?.intendedTxHash).toBe(before?.intendedTxHash);
      expect(h.broadcaster.distinctSentCount()).toBe(1);

      h.chain.advanceHeight(h.deps.config.minConfirmations);
      const settled = await resumeUnsettledRefunds(revived);
      expect(settled.settled).toBe(1);
      expect(h.broadcaster.distinctSentCount()).toBe(1);
      expect((await repo.getOrder(order.id))?.state).toBe('REFUNDED');
    });

    it('settles without re-sending when the crash happened after the broadcast', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, order.id);

      h.broadcaster.outcome = 'send_then_throw';
      const attempt = await executeTreasuryRefund(h.deps, order.id);
      expect(attempt.ok).toBe(false);
      expect(h.broadcaster.sent).toHaveLength(1);
      expect((await repo.getRefundExecutionByOrder(order.id))?.broadcastAt).toBeNull();

      h.broadcaster.outcome = 'ok';
      h.chain.advanceHeight(h.deps.config.minConfirmations);
      const summary = await resumeUnsettledRefunds({ ...h.deps });

      expect(summary.settled).toBe(1);
      expect(summary.resent).toBe(0);
      expect(h.broadcaster.distinctSentCount()).toBe(1);
      expect((await repo.getOrder(order.id))?.state).toBe('REFUNDED');
      const execution = await repo.getRefundExecutionByOrder(order.id);
      expect(execution?.refundTxHash).toBe(execution?.intendedTxHash);
      expect(execution?.confirmedAt).not.toBeNull();
    });

    it('runs the whole demo flow to a verified refund, and a second sweep does nothing', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);

      expect((await reserveRefund(h.deps, order.id)).ok).toBe(true);
      await executeTreasuryRefund(h.deps, order.id);
      h.chain.advanceHeight(h.deps.config.minConfirmations);
      const settled = await settleRefund(h.deps, order.id);

      expect(settled.status).toBe('refunded');
      expect(settled.order?.state).toBe('REFUNDED');
      expect(settled.execution?.refundTxHash).not.toBeNull();

      const again = await resumeUnsettledRefunds(h.deps);
      expect(again.checked).toBe(0);
      expect(h.broadcaster.distinctSentCount()).toBe(1);
    });

    it('refuses a second treasury refund once the wallet has used its allowance', async () => {
      const h = harness({
        treasuryCaps: { ...DEFAULT_TREASURY_CAPS, maxRefundsPerWalletPerWindow: 1 },
      });

      const first = await orderAwaitingApproval(h);
      expect((await reserveRefund(h.deps, first.id)).ok).toBe(true);
      await executeTreasuryRefund(h.deps, first.id);
      h.chain.advanceHeight(h.deps.config.minConfirmations);
      expect((await settleRefund(h.deps, first.id)).status).toBe('refunded');
      expect(await repo.listDemoRefundsSince(0)).toHaveLength(1);

      const second = await orderAwaitingApproval(h);
      const denied = await reserveRefund(h.deps, second.id);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.reason).toBe('cap_denied');
      expect(denied.capReason).toBe('wallet_count');
      expect(await repo.getRefundExecutionByOrder(second.id)).toBeNull();
      expect(h.broadcaster.distinctSentCount()).toBe(1);
      expect((await repo.getOrder(second.id))?.state).toBe('REFUND_REQUESTED');
    });

    it('refuses once the global hourly count is reached', async () => {
      const h = harness({
        treasuryCaps: {
          ...DEFAULT_TREASURY_CAPS,
          maxRefundsPerWalletPerWindow: 10,
          maxRefundsPerHourGlobal: 1,
        },
      });
      const first = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, first.id);
      await executeTreasuryRefund(h.deps, first.id);

      const second = await orderAwaitingApproval(h);
      const denied = await reserveRefund(h.deps, second.id);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.capReason).toBe('global_hourly_count');
    });

    it('refuses once the lifetime ceiling is reached', async () => {
      const h = harness({
        treasuryCaps: {
          ...DEFAULT_TREASURY_CAPS,
          maxRefundsPerWalletPerWindow: 10,
          maxLunaTotal: AMOUNT_LUNA + 1,
        },
      });
      const first = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, first.id);
      await executeTreasuryRefund(h.deps, first.id);

      const second = await orderAwaitingApproval(h);
      const denied = await reserveRefund(h.deps, second.id);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.capReason).toBe('global_total');
    });

    it('writes exactly one ledger row per order even when the send is retried', async () => {
      const h = harness();
      const order = await orderAwaitingApproval(h);
      await reserveRefund(h.deps, order.id);

      h.broadcaster.outcome = 'throw_before_send';
      await executeTreasuryRefund(h.deps, order.id);
      h.broadcaster.outcome = 'ok';
      await executeTreasuryRefund(h.deps, order.id);
      await executeTreasuryRefund(h.deps, order.id);

      expect(await repo.listDemoRefundsSince(0)).toHaveLength(1);
      expect(h.broadcaster.distinctSentCount()).toBe(1);
    });


    /**
     * A divergence between the two repositories, found by this file. `schema.sql` allows at
     * most one CONSUMED challenge per order; the in-memory repository has no such rule. A
     * buyer can hold two unconsumed challenges for one PAID order, sign both, and present
     * them in turn — `checkChallengeAgainstOrder` does not look at the order's state, so the
     * second one reaches `consumeChallenge`. Postgres used to raise 23505 there, and the
     * violation escaped `submitSignedRefundRequest` as a thrown error, i.e. a 500. It is now
     * reported as the replay it is.
     */
    it('refuses a second signed challenge for an order that already has one', async () => {
      const h = harness();
      const order = await createPaidOrder(h);
      const a = await signRefundRequest(h, order.id);
      const b = await signRefundRequest(h, order.id);
      expect(a.nonce).not.toBe(b.nonce);

      expect((await submitSignedRefundRequest(h.deps, { orderId: order.id, ...a })).ok).toBe(true);

      const second = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...b });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe('nonce_already_used');

      // And the database still holds exactly one consumed challenge for that order.
      const consumed = await db.query(
        'SELECT count(*)::int AS n FROM refund_challenges WHERE order_id = $1 AND consumed_at IS NOT NULL',
        [order.id],
      );
      expect(consumed[0]?.n).toBe(1);
      expect((await repo.getOrder(order.id))?.state).toBe('REFUND_REQUESTED');
    });

    it('refuses to attach one payment to two orders', async () => {
      const h = harness();
      const paid = await createPaidOrder(h);
      const stored = await repo.getOrder(paid.id);
      expect(stored?.paymentTxHash).not.toBeNull();
      expect(await repo.getOrderByPaymentTx(stored?.paymentTxHash ?? '')).not.toBeNull();

      await expect(
        repo.createOrder(
          orderRow({
            id: 'ord_thief',
            state: 'PAID',
            paymentTxHash: stored?.paymentTxHash ?? '',
            payerAddress: PAYER,
          }),
        ),
      ).rejects.toMatchObject({ constraint: CONSTRAINTS.orderPaymentTx });
    });
  });
});
