/**
 * Postgres repository. The deployment target is Neon; the engine is ordinary Postgres.
 *
 * STATUS 2026-09-13: the SQL below and `schema.sql` are now executed by
 * `postgres.integration.test.ts` against a real Postgres engine embedded in the test process
 * (PGlite, WASM). What that proves: the schema applies, every statement parses and runs, the
 * compare-and-set clauses decide races the way the in-memory repository does, unique
 * violations surface as `UniqueViolationError`, BIGINT and TIMESTAMPTZ round-trip.
 *
 * What it still does NOT prove, and must not be claimed:
 *   - `neonExecutor` itself. No Neon endpoint has been contacted from this repository, so the
 *     HTTP driver's type parsing, its error shape and its failure modes remain assumptions.
 *   - Multi-session behaviour. PGlite runs a single backend, so lock contention between two
 *     real connections is untested. Every guarantee here is decided inside one statement,
 *     which is why that gap is survivable, but it is a gap.
 */
import type {
  DemoRefundLedgerRow,
  Merchant,
  MerchantNonce,
  Order,
  RefundChallenge,
  RefundExecution,
} from '../domain/types.js';
import type { OrderState } from '../domain/states.js';
import { isOrderState } from '../domain/states.js';
import {
  neonExecutor,
  taggedFor,
  type SqlExecutor,
  type SqlTag,
} from './sql-executor.js';
import {
  NotFoundError,
  UniqueViolationError,
  type ChallengeConsumePatch,
  type ExecutionPatch,
  type OrderPatch,
  type Repository,
} from './repository.js';

type Row = Record<string, unknown>;

/**
 * int8 arrives as a number, a bigint or a decimal string depending on the driver: PGlite
 * returns a JS number while the value is safe and a bigint once it is not; the Neon HTTP
 * driver returns a string. All three are accepted, and a value that cannot be represented
 * exactly as a JS number is REFUSED rather than rounded. These columns hold Luna — silently
 * losing the low digits of an amount is the worst thing this file could do.
 */
function num(value: unknown): number {
  const parsed = numOrNull(value);
  return parsed === null ? 0 : parsed;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite numeric from database: ${value}`);
    return value;
  }
  if (typeof value === 'bigint') return exactly(value);
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value)) return exactly(BigInt(value));
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) throw new Error(`unparseable numeric from database: ${value}`);
    return asNumber;
  }
  throw new Error(`unexpected numeric type from database: ${typeof value}`);
}

function exactly(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(
      `BIGINT ${value} cannot be represented exactly as a JavaScript number; refusing to round it`,
    );
  }
  return Number(value);
}

/**
 * TIMESTAMPTZ. PGlite and the Neon driver both hand back a `Date`; a driver configured
 * without type parsers hands back the Postgres text form. An unparseable value throws
 * instead of becoming 1970 — a timestamp of 0 would make an order look expired and a
 * challenge look ancient.
 */
function ms(value: unknown): number {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t)) throw new Error('invalid Date from database');
    return t;
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return exactly(value);
  if (typeof value === 'string') {
    // Postgres text form is "2026-09-13 08:33:00.123+00"; Date parses it once the space is
    // an ISO 'T'. An already-ISO string is unaffected.
    const t = new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') : value).getTime();
    if (Number.isNaN(t)) throw new Error(`unparseable timestamp from database: ${value}`);
    return t;
  }
  throw new Error(`unexpected timestamp type from database: ${typeof value}`);
}

function msOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return ms(value);
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function isUniqueViolation(err: unknown): { constraint: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== '23505') return null;
  return { constraint: str(e.constraint ?? e.message ?? 'unknown') };
}

function rethrow(err: unknown): never {
  const unique = isUniqueViolation(err);
  if (unique) throw new UniqueViolationError(unique.constraint);
  throw err;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toMerchant(row: Row): Merchant {
  return {
    id: str(row.id),
    name: str(row.name),
    address: str(row.address),
    allowTreasuryRefund: row.allow_treasury_refund === true,
  };
}

function toOrder(row: Row): Order {
  const state = str(row.state);
  if (!isOrderState(state)) throw new Error(`unknown order state in database: ${state}`);
  return {
    id: str(row.id),
    state,
    merchantId: str(row.merchant_id),
    merchantAddress: str(row.merchant_address),
    itemLabel: str(row.item_label),
    amountLuna: num(row.amount_luna),
    networkId: str(row.network_id),
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    expiresAt: ms(row.expires_at),
    paymentTxHash: strOrNull(row.payment_tx_hash),
    payerAddress: strOrNull(row.payer_address),
    paidAt: msOrNull(row.paid_at),
    paymentBlockNumber: numOrNull(row.payment_block_number),
    claimedPaymentTxHash: strOrNull(row.claimed_payment_tx_hash),
    refundSource: str(row.refund_source) === 'DEMO_TREASURY' ? 'DEMO_TREASURY' : 'MERCHANT_WALLET',
    refunderAddress: str(row.refunder_address),
    lastError: strOrNull(row.last_error),
  };
}

function toChallenge(row: Row): RefundChallenge {
  return {
    nonce: str(row.nonce),
    orderId: str(row.order_id),
    message: str(row.message),
    refundTo: str(row.refund_to),
    amountLuna: num(row.amount_luna),
    paymentTxHash: str(row.payment_tx_hash),
    expiresAtSec: num(row.expires_at_sec),
    createdAt: ms(row.created_at),
    consumedAt: msOrNull(row.consumed_at),
    signaturePublicKey: strOrNull(row.signature_public_key),
    signatureHex: strOrNull(row.signature_hex),
    signerAddress: strOrNull(row.signer_address),
  };
}

function toExecution(row: Row): RefundExecution {
  return {
    id: str(row.id),
    orderId: str(row.order_id),
    challengeNonce: str(row.challenge_nonce),
    refundTo: str(row.refund_to),
    amountLuna: num(row.amount_luna),
    refunderAddress: str(row.refunder_address),
    source: str(row.source) === 'DEMO_TREASURY' ? 'DEMO_TREASURY' : 'MERCHANT_WALLET',
    intendedTxHash: strOrNull(row.intended_tx_hash),
    serializedTx: strOrNull(row.serialized_tx),
    validityStartHeight: numOrNull(row.validity_start_height),
    preparedAt: msOrNull(row.prepared_at),
    broadcastAt: msOrNull(row.broadcast_at),
    refundTxHash: strOrNull(row.refund_tx_hash),
    confirmedAt: msOrNull(row.confirmed_at),
    refundBlockNumber: numOrNull(row.refund_block_number),
    failureReason: strOrNull(row.failure_reason),
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
  };
}

function toDemoRow(row: Row): DemoRefundLedgerRow {
  return {
    id: str(row.id),
    orderId: str(row.order_id),
    walletAddress: str(row.wallet_address),
    amountLuna: num(row.amount_luna),
    createdAt: ms(row.created_at),
  };
}

function toMerchantNonce(row: Row): MerchantNonce {
  return {
    nonce: str(row.nonce),
    merchantId: str(row.merchant_id),
    merchantAddress: str(row.merchant_address),
    action: str(row.action),
    orderId: str(row.order_id),
    message: str(row.message),
    createdAt: ms(row.created_at),
    expiresAtSec: num(row.expires_at_sec),
    consumedAt: msOrNull(row.consumed_at),
    signerAddress: strOrNull(row.signer_address),
  };
}

const iso = (msValue: number): string => new Date(msValue).toISOString();
const isoOrNull = (msValue: number | null): string | null =>
  msValue === null ? null : new Date(msValue).toISOString();

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PostgresRepository implements Repository {
  private readonly sql: SqlTag;

  /**
   * Takes either a connection string — in which case it builds the Neon HTTP executor, the
   * production path — or an executor directly, which is how the tests point the identical
   * SQL at an embedded Postgres.
   */
  constructor(source: string | SqlExecutor) {
    if (typeof source === 'string') {
      if (!source) throw new Error('PostgresRepository: empty connection string');
      this.sql = taggedFor(neonExecutor(source));
    } else {
      this.sql = taggedFor(source);
    }
  }

  private async rows(run: () => Promise<unknown>): Promise<Row[]> {
    try {
      return (await run()) as Row[];
    } catch (err) {
      return rethrow(err);
    }
  }

  // -- merchants ------------------------------------------------------------

  async getMerchant(id: string): Promise<Merchant | null> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`SELECT id, name, address, allow_treasury_refund FROM merchants WHERE id = ${id}`,
    );
    const row = rows[0];
    return row ? toMerchant(row) : null;
  }

  async listMerchants(): Promise<Merchant[]> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`SELECT id, name, address, allow_treasury_refund FROM merchants ORDER BY id`,
    );
    return rows.map(toMerchant);
  }

  async upsertMerchant(merchant: Merchant): Promise<Merchant> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        INSERT INTO merchants (id, name, address, allow_treasury_refund)
        VALUES (${merchant.id}, ${merchant.name}, ${merchant.address}, ${merchant.allowTreasuryRefund})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, name, address, allow_treasury_refund`,
    );
    const row = rows[0];
    if (!row) throw new Error('upsertMerchant returned no row');
    return toMerchant(row);
  }

  // -- orders ---------------------------------------------------------------

  async createOrder(order: Order): Promise<Order> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        INSERT INTO orders (
          id, state, merchant_id, merchant_address, item_label, amount_luna, network_id,
          created_at, updated_at, expires_at,
          payment_tx_hash, payer_address, paid_at, payment_block_number,
          claimed_payment_tx_hash, refund_source, refunder_address, last_error
        ) VALUES (
          ${order.id}, ${order.state}, ${order.merchantId}, ${order.merchantAddress},
          ${order.itemLabel}, ${order.amountLuna}, ${String(order.networkId)},
          ${iso(order.createdAt)}, ${iso(order.updatedAt)}, ${iso(order.expiresAt)},
          ${order.paymentTxHash}, ${order.payerAddress}, ${isoOrNull(order.paidAt)},
          ${order.paymentBlockNumber}, ${order.claimedPaymentTxHash}, ${order.refundSource},
          ${order.refunderAddress}, ${order.lastError}
        )
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error('createOrder returned no row');
    return toOrder(row);
  }

  async getOrder(id: string): Promise<Order | null> {
    const sql = this.sql;
    const rows = await this.rows(() => sql`SELECT * FROM orders WHERE id = ${id}`);
    const row = rows[0];
    return row ? toOrder(row) : null;
  }

  async getOrderByPaymentTx(hash: string): Promise<Order | null> {
    const sql = this.sql;
    const rows = await this.rows(() => sql`SELECT * FROM orders WHERE payment_tx_hash = ${hash}`);
    const row = rows[0];
    return row ? toOrder(row) : null;
  }

  /** The state list is `REFUND_BOARD_STATES`, written out so only scalars are bound. */
  async listMerchantRefundOrders(merchantId: string, limit: number): Promise<Order[]> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        SELECT * FROM orders
        WHERE merchant_id = ${merchantId}
          AND state IN ('REFUND_REQUESTED', 'REFUND_APPROVED', 'REFUND_BROADCAST',
                        'REFUNDED', 'REFUND_FAILED', 'REJECTED')
        ORDER BY created_at DESC
        LIMIT ${limit}`,
    );
    return rows.map(toOrder);
  }

  /**
   * Compare-and-set. The `WHERE state = ${expectedState}` clause is the concurrency defence:
   * a loser updates zero rows and is told so, instead of overwriting the winner.
   *
   * COALESCE is used so a partial patch leaves untouched columns alone. Passing an explicit
   * null therefore cannot clear a column here — `claimed_payment_tx_hash` is the one place
   * that must be clearable, so it is handled with a sentinel rather than COALESCE.
   */
  async updateOrder(
    id: string,
    expectedState: OrderState,
    patch: OrderPatch,
  ): Promise<Order | null> {
    const sql = this.sql;
    const clearClaim = 'claimedPaymentTxHash' in patch && patch.claimedPaymentTxHash === null;
    const rows = await this.rows(
      () => sql`
        UPDATE orders SET
          state                   = COALESCE(${patch.state ?? null}, state),
          updated_at              = COALESCE(${isoOrNull(patch.updatedAt ?? null)}, updated_at),
          payment_tx_hash         = COALESCE(${patch.paymentTxHash ?? null}, payment_tx_hash),
          payer_address           = COALESCE(${patch.payerAddress ?? null}, payer_address),
          paid_at                 = COALESCE(${isoOrNull(patch.paidAt ?? null)}, paid_at),
          payment_block_number    = COALESCE(${patch.paymentBlockNumber ?? null}, payment_block_number),
          claimed_payment_tx_hash = CASE WHEN ${clearClaim} THEN NULL
                                         ELSE COALESCE(${patch.claimedPaymentTxHash ?? null}, claimed_payment_tx_hash) END,
          last_error              = CASE WHEN ${'lastError' in patch} THEN ${patch.lastError ?? null}
                                         ELSE last_error END,
          expires_at              = COALESCE(${isoOrNull(patch.expiresAt ?? null)}, expires_at)
        WHERE id = ${id} AND state = ${expectedState}
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      const exists = await this.getOrder(id);
      if (!exists) throw new NotFoundError(`order ${id}`);
      return null;
    }
    return toOrder(row);
  }

  // -- challenges -----------------------------------------------------------

  async createChallenge(challenge: RefundChallenge): Promise<RefundChallenge> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        INSERT INTO refund_challenges (
          nonce, order_id, message, refund_to, amount_luna, payment_tx_hash,
          expires_at_sec, created_at
        ) VALUES (
          ${challenge.nonce}, ${challenge.orderId}, ${challenge.message}, ${challenge.refundTo},
          ${challenge.amountLuna}, ${challenge.paymentTxHash}, ${challenge.expiresAtSec},
          ${iso(challenge.createdAt)}
        )
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error('createChallenge returned no row');
    return toChallenge(row);
  }

  async getChallenge(nonce: string): Promise<RefundChallenge | null> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`SELECT * FROM refund_challenges WHERE nonce = ${nonce}`,
    );
    const row = rows[0];
    return row ? toChallenge(row) : null;
  }

  async listChallengesForOrder(orderId: string): Promise<RefundChallenge[]> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`SELECT * FROM refund_challenges WHERE order_id = ${orderId} ORDER BY created_at DESC`,
    );
    return rows.map(toChallenge);
  }

  /**
   * `AND consumed_at IS NULL` is what makes a replayed nonce lose.
   *
   * The catch is NOT belt and braces. `schema.sql` also carries
   * `refund_challenges_one_consumed_per_order`, a partial unique index that allows at most
   * one consumed challenge per order, and the in-memory repository has no equivalent rule.
   * A buyer who asks for two challenges while the order is PAID, signs both, and presents
   * them one after the other consumes the first and then hits that index with the second.
   * Before this catch existed the violation escaped `submitSignedRefundRequest` as an
   * exception — a 500 — where the in-memory path returns a clean refusal. Losing that race
   * is exactly what a replay is, so it is reported the same way: null, which the caller
   * turns into `nonce_already_used`. Proved by
   * "refuses a second signed challenge for an order that already has one".
   */
  async consumeChallenge(
    nonce: string,
    patch: ChallengeConsumePatch,
  ): Promise<RefundChallenge | null> {
    const sql = this.sql;
    let rows: Row[];
    try {
      rows = await this.rows(
      () => sql`
        UPDATE refund_challenges SET
          consumed_at          = ${isoOrNull(patch.consumedAt)},
          signature_public_key = ${patch.signaturePublicKey},
          signature_hex        = ${patch.signatureHex},
          signer_address       = ${patch.signerAddress}
        WHERE nonce = ${nonce} AND consumed_at IS NULL
        RETURNING *`,
      );
    } catch (err) {
      if (
        err instanceof UniqueViolationError &&
        err.constraint === 'refund_challenges_one_consumed_per_order'
      ) {
        return null;
      }
      throw err;
    }
    const row = rows[0];
    return row ? toChallenge(row) : null;
  }

  // -- executions -----------------------------------------------------------

  async createRefundExecution(execution: RefundExecution): Promise<RefundExecution> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        INSERT INTO refund_executions (
          id, order_id, challenge_nonce, refund_to, amount_luna, refunder_address, source,
          intended_tx_hash, serialized_tx, validity_start_height, prepared_at, broadcast_at,
          refund_tx_hash, refund_block_number, confirmed_at, failure_reason,
          created_at, updated_at
        ) VALUES (
          ${execution.id}, ${execution.orderId}, ${execution.challengeNonce}, ${execution.refundTo},
          ${execution.amountLuna}, ${execution.refunderAddress}, ${execution.source},
          ${execution.intendedTxHash}, ${execution.serializedTx}, ${execution.validityStartHeight},
          ${isoOrNull(execution.preparedAt)}, ${isoOrNull(execution.broadcastAt)},
          ${execution.refundTxHash}, ${execution.refundBlockNumber},
          ${isoOrNull(execution.confirmedAt)}, ${execution.failureReason},
          ${iso(execution.createdAt)}, ${iso(execution.updatedAt)}
        )
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error('createRefundExecution returned no row');
    return toExecution(row);
  }

  async getRefundExecution(id: string): Promise<RefundExecution | null> {
    const sql = this.sql;
    const rows = await this.rows(() => sql`SELECT * FROM refund_executions WHERE id = ${id}`);
    const row = rows[0];
    return row ? toExecution(row) : null;
  }

  async getRefundExecutionByOrder(orderId: string): Promise<RefundExecution | null> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`SELECT * FROM refund_executions WHERE order_id = ${orderId}`,
    );
    const row = rows[0];
    return row ? toExecution(row) : null;
  }

  async updateRefundExecution(id: string, patch: ExecutionPatch): Promise<RefundExecution> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        UPDATE refund_executions SET
          intended_tx_hash      = COALESCE(${patch.intendedTxHash ?? null}, intended_tx_hash),
          serialized_tx         = COALESCE(${patch.serializedTx ?? null}, serialized_tx),
          validity_start_height = COALESCE(${patch.validityStartHeight ?? null}, validity_start_height),
          refunder_address      = COALESCE(${patch.refunderAddress ?? null}, refunder_address),
          prepared_at           = COALESCE(${isoOrNull(patch.preparedAt ?? null)}, prepared_at),
          broadcast_at          = COALESCE(${isoOrNull(patch.broadcastAt ?? null)}, broadcast_at),
          refund_tx_hash        = COALESCE(${patch.refundTxHash ?? null}, refund_tx_hash),
          refund_block_number   = COALESCE(${patch.refundBlockNumber ?? null}, refund_block_number),
          confirmed_at          = COALESCE(${isoOrNull(patch.confirmedAt ?? null)}, confirmed_at),
          failure_reason        = COALESCE(${patch.failureReason ?? null}, failure_reason),
          updated_at            = COALESCE(${isoOrNull(patch.updatedAt ?? null)}, now())
        WHERE id = ${id}
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`refund execution ${id}`);
    return toExecution(row);
  }

  /** `AND serialized_tx IS NULL` is what makes a second preparer lose instead of tie. */
  async prepareRefundExecution(id: string, patch: ExecutionPatch): Promise<RefundExecution | null> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        UPDATE refund_executions SET
          serialized_tx         = ${patch.serializedTx ?? null},
          intended_tx_hash      = ${patch.intendedTxHash ?? null},
          validity_start_height = ${patch.validityStartHeight ?? null},
          refunder_address      = COALESCE(${patch.refunderAddress ?? null}, refunder_address),
          prepared_at           = COALESCE(${isoOrNull(patch.preparedAt ?? null)}, now()),
          updated_at            = COALESCE(${isoOrNull(patch.updatedAt ?? null)}, now())
        WHERE id = ${id} AND serialized_tx IS NULL
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      const exists = await this.getRefundExecution(id);
      if (!exists) throw new NotFoundError(`refund execution ${id}`);
      return null;
    }
    return toExecution(row);
  }

  async listUnsettledRefundExecutions(): Promise<RefundExecution[]> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        SELECT * FROM refund_executions
        WHERE confirmed_at IS NULL AND failure_reason IS NULL
        ORDER BY created_at ASC
        LIMIT 200`,
    );
    return rows.map(toExecution);
  }

  // -- merchant challenge nonces (gap S3) -----------------------------------
  //
  // UNTESTED, like every other statement in this file. The three specific risks here:
  // `expires_at_sec` is BIGINT so `num()` coerces a string back to a number; the primary-key
  // violation on re-issue must surface as UniqueViolationError or an ordinary double-tap
  // becomes a 500; and `consume` must return zero rows when it loses, never one.

  async createMerchantNonce(row: MerchantNonce): Promise<MerchantNonce> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        INSERT INTO merchant_nonces (
          nonce, merchant_id, merchant_address, action, order_id, message,
          created_at, expires_at_sec, consumed_at, signer_address
        ) VALUES (
          ${row.nonce}, ${row.merchantId}, ${row.merchantAddress}, ${row.action},
          ${row.orderId}, ${row.message}, ${iso(row.createdAt)}, ${row.expiresAtSec},
          ${isoOrNull(row.consumedAt)}, ${row.signerAddress}
        )
        RETURNING *`,
    );
    const created = rows[0];
    if (!created) throw new Error('createMerchantNonce returned no row');
    return toMerchantNonce(created);
  }

  async getMerchantNonce(nonce: string): Promise<MerchantNonce | null> {
    const sql = this.sql;
    const rows = await this.rows(() => sql`SELECT * FROM merchant_nonces WHERE nonce = ${nonce}`);
    const row = rows[0];
    return row ? toMerchantNonce(row) : null;
  }

  async consumeMerchantNonce(
    nonce: string,
    patch: { consumedAt: number; signerAddress: string },
  ): Promise<MerchantNonce | null> {
    const sql = this.sql;
    // `AND consumed_at IS NULL` is the whole defence. Without it a replay updates the row
    // again and is reported as a fresh, valid approval.
    const rows = await this.rows(
      () => sql`
        UPDATE merchant_nonces SET
          consumed_at    = ${iso(patch.consumedAt)},
          signer_address = ${patch.signerAddress}
        WHERE nonce = ${nonce} AND consumed_at IS NULL
        RETURNING *`,
    );
    const row = rows[0];
    return row ? toMerchantNonce(row) : null;
  }

  async purgeExpiredMerchantNonces(nowSec: number): Promise<number> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`DELETE FROM merchant_nonces WHERE expires_at_sec < ${nowSec} RETURNING nonce`,
    );
    return rows.length;
  }

  // -- demo ledger ----------------------------------------------------------

  async appendDemoRefund(row: DemoRefundLedgerRow): Promise<DemoRefundLedgerRow> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        INSERT INTO demo_refunds (id, order_id, wallet_address, amount_luna, created_at)
        VALUES (${row.id}, ${row.orderId}, ${row.walletAddress}, ${row.amountLuna}, ${iso(row.createdAt)})
        RETURNING *`,
    );
    const created = rows[0];
    if (!created) throw new Error('appendDemoRefund returned no row');
    return toDemoRow(created);
  }

  async listDemoRefundsSince(sinceMs: number): Promise<DemoRefundLedgerRow[]> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`SELECT * FROM demo_refunds WHERE created_at >= ${iso(sinceMs)} ORDER BY created_at DESC`,
    );
    return rows.map(toDemoRow);
  }

  async listDemoRefundsForWalletSince(
    wallet: string,
    sinceMs: number,
  ): Promise<DemoRefundLedgerRow[]> {
    const sql = this.sql;
    const rows = await this.rows(
      () => sql`
        SELECT * FROM demo_refunds
        WHERE wallet_address = ${wallet} AND created_at >= ${iso(sinceMs)}
        ORDER BY created_at DESC`,
    );
    return rows.map(toDemoRow);
  }
}
