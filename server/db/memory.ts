/**
 * In-memory repository.
 *
 * Purpose: tests, and local `npm run dev` so the whole flow can be walked in a browser with
 * the FakeWallet and the fake chain. It is NOT a deployment target — a Vercel serverless
 * instance is short lived and there are many of them, so state here would be per-instance
 * and would vanish. `api/_lib/deps.ts` refuses it in production for that reason.
 *
 * Each mutating method awaits `gate()` before its critical section and then runs to
 * completion without another await. On a single-threaded runtime that makes the check-and-set
 * genuinely atomic, while `setGate()` lets a test force two callers to interleave at exactly
 * the point a real database round trip would.
 */

import type {
  DemoRefundLedgerRow,
  Merchant,
  MerchantNonce,
  Order,
  RefundChallenge,
  RefundExecution,
} from '../domain/types.js';
import { REFUND_BOARD_STATES, type OrderState } from '../domain/states.js';
import {
  CONSTRAINTS,
  NotFoundError,
  UniqueViolationError,
  type ChallengeConsumePatch,
  type ExecutionPatch,
  type OrderPatch,
  type Repository,
} from './repository.js';

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryRepository implements Repository {
  private readonly merchants = new Map<string, Merchant>();
  private readonly orders = new Map<string, Order>();
  private readonly paymentTxIndex = new Map<string, string>();
  private readonly challenges = new Map<string, RefundChallenge>();
  private readonly executions = new Map<string, RefundExecution>();
  private readonly executionByOrder = new Map<string, string>();
  private readonly refundTxIndex = new Map<string, string>();
  private readonly merchantNonces = new Map<string, MerchantNonce>();
  private readonly demoLedger: DemoRefundLedgerRow[] = [];
  private readonly demoLedgerOrders = new Set<string>();

  private gateFn: (() => Promise<void>) | null = null;

  constructor(merchants: Merchant[] = []) {
    for (const m of merchants) this.merchants.set(m.id, clone(m));
  }

  /** Test hook. Runs before every critical section, simulating a database round trip. */
  setGate(fn: (() => Promise<void>) | null): void {
    this.gateFn = fn;
  }

  private async gate(): Promise<void> {
    if (this.gateFn) await this.gateFn();
    else await Promise.resolve();
  }

  // -- merchants ------------------------------------------------------------

  async getMerchant(id: string): Promise<Merchant | null> {
    const m = this.merchants.get(id);
    return m ? clone(m) : null;
  }

  async upsertMerchant(merchant: Merchant): Promise<Merchant> {
    await this.gate();
    const existing = this.merchants.get(merchant.id);
    const next = existing ? { ...existing, name: merchant.name } : clone(merchant);
    this.merchants.set(merchant.id, next);
    return clone(next);
  }

  // -- orders ---------------------------------------------------------------

  async createOrder(order: Order): Promise<Order> {
    await this.gate();
    if (this.orders.has(order.id)) throw new UniqueViolationError(CONSTRAINTS.orderId);
    if (order.paymentTxHash && this.paymentTxIndex.has(order.paymentTxHash)) {
      throw new UniqueViolationError(CONSTRAINTS.orderPaymentTx);
    }
    this.orders.set(order.id, clone(order));
    if (order.paymentTxHash) this.paymentTxIndex.set(order.paymentTxHash, order.id);
    return clone(order);
  }

  async getOrder(id: string): Promise<Order | null> {
    const o = this.orders.get(id);
    return o ? clone(o) : null;
  }

  async getOrderByPaymentTx(hash: string): Promise<Order | null> {
    const id = this.paymentTxIndex.get(hash);
    return id ? this.getOrder(id) : null;
  }

  async listMerchantRefundOrders(merchantId: string, limit: number): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.merchantId === merchantId && REFUND_BOARD_STATES.includes(o.state))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async updateOrder(id: string, expectedState: OrderState, patch: OrderPatch): Promise<Order | null> {
    await this.gate();
    const current = this.orders.get(id);
    if (!current) throw new NotFoundError(`order ${id}`);
    if (current.state !== expectedState) return null;

    const nextPaymentTx = patch.paymentTxHash ?? current.paymentTxHash;
    if (nextPaymentTx && nextPaymentTx !== current.paymentTxHash) {
      const owner = this.paymentTxIndex.get(nextPaymentTx);
      if (owner !== undefined && owner !== id) {
        throw new UniqueViolationError(CONSTRAINTS.orderPaymentTx);
      }
    }

    const updated: Order = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.orders.set(id, updated);
    if (nextPaymentTx) this.paymentTxIndex.set(nextPaymentTx, id);
    return clone(updated);
  }

  // -- challenges -----------------------------------------------------------

  async createChallenge(challenge: RefundChallenge): Promise<RefundChallenge> {
    await this.gate();
    if (this.challenges.has(challenge.nonce)) {
      throw new UniqueViolationError(CONSTRAINTS.challengeNonce);
    }
    this.challenges.set(challenge.nonce, clone(challenge));
    return clone(challenge);
  }

  async getChallenge(nonce: string): Promise<RefundChallenge | null> {
    const c = this.challenges.get(nonce);
    return c ? clone(c) : null;
  }

  async listChallengesForOrder(orderId: string): Promise<RefundChallenge[]> {
    return [...this.challenges.values()]
      .filter((c) => c.orderId === orderId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async consumeChallenge(
    nonce: string,
    patch: ChallengeConsumePatch,
  ): Promise<RefundChallenge | null> {
    await this.gate();
    const current = this.challenges.get(nonce);
    if (!current) return null;
    if (current.consumedAt !== null) return null; // replay
    const updated: RefundChallenge = { ...current, ...patch };
    this.challenges.set(nonce, updated);
    return clone(updated);
  }

  // -- executions -----------------------------------------------------------

  async createRefundExecution(execution: RefundExecution): Promise<RefundExecution> {
    await this.gate();
    if (this.executionByOrder.has(execution.orderId)) {
      throw new UniqueViolationError(CONSTRAINTS.executionOrder);
    }
    if (this.executions.has(execution.id)) {
      throw new UniqueViolationError('refund_executions_pkey');
    }
    if (execution.refundTxHash && this.refundTxIndex.has(execution.refundTxHash)) {
      throw new UniqueViolationError(CONSTRAINTS.executionRefundTx);
    }
    this.executions.set(execution.id, clone(execution));
    this.executionByOrder.set(execution.orderId, execution.id);
    if (execution.refundTxHash) this.refundTxIndex.set(execution.refundTxHash, execution.id);
    return clone(execution);
  }

  async getRefundExecution(id: string): Promise<RefundExecution | null> {
    const e = this.executions.get(id);
    return e ? clone(e) : null;
  }

  async getRefundExecutionByOrder(orderId: string): Promise<RefundExecution | null> {
    const id = this.executionByOrder.get(orderId);
    return id ? this.getRefundExecution(id) : null;
  }

  async updateRefundExecution(id: string, patch: ExecutionPatch): Promise<RefundExecution> {
    await this.gate();
    const current = this.executions.get(id);
    if (!current) throw new NotFoundError(`refund execution ${id}`);
    if (patch.refundTxHash && patch.refundTxHash !== current.refundTxHash) {
      const owner = this.refundTxIndex.get(patch.refundTxHash);
      if (owner !== undefined && owner !== id) {
        throw new UniqueViolationError(CONSTRAINTS.executionRefundTx);
      }
    }
    const updated: RefundExecution = {
      ...current,
      ...patch,
      id: current.id,
      orderId: current.orderId,
      createdAt: current.createdAt,
    };
    this.executions.set(id, updated);
    if (updated.refundTxHash) this.refundTxIndex.set(updated.refundTxHash, id);
    return clone(updated);
  }

  async prepareRefundExecution(id: string, patch: ExecutionPatch): Promise<RefundExecution | null> {
    await this.gate();
    const current = this.executions.get(id);
    if (!current) throw new NotFoundError(`refund execution ${id}`);
    if (current.serializedTx !== null) return null; // somebody prepared first
    const updated: RefundExecution = {
      ...current,
      ...patch,
      id: current.id,
      orderId: current.orderId,
      createdAt: current.createdAt,
    };
    this.executions.set(id, updated);
    return clone(updated);
  }

  async listUnsettledRefundExecutions(): Promise<RefundExecution[]> {
    return [...this.executions.values()]
      .filter((e) => e.confirmedAt === null && e.failureReason === null)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  // -- merchant challenge nonces --------------------------------------------

  async createMerchantNonce(row: MerchantNonce): Promise<MerchantNonce> {
    await this.gate();
    if (this.merchantNonces.has(row.nonce)) {
      throw new UniqueViolationError(CONSTRAINTS.merchantNonce);
    }
    this.merchantNonces.set(row.nonce, clone(row));
    return clone(row);
  }

  async getMerchantNonce(nonce: string): Promise<MerchantNonce | null> {
    const row = this.merchantNonces.get(nonce);
    return row ? clone(row) : null;
  }

  async consumeMerchantNonce(
    nonce: string,
    patch: { consumedAt: number; signerAddress: string },
  ): Promise<MerchantNonce | null> {
    await this.gate();
    const current = this.merchantNonces.get(nonce);
    if (!current) return null;
    if (current.consumedAt !== null) return null; // replay
    const updated: MerchantNonce = { ...current, ...patch };
    this.merchantNonces.set(nonce, updated);
    return clone(updated);
  }

  async purgeExpiredMerchantNonces(nowSec: number): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.merchantNonces) {
      if (row.expiresAtSec < nowSec) {
        this.merchantNonces.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // -- demo ledger ----------------------------------------------------------

  async appendDemoRefund(row: DemoRefundLedgerRow): Promise<DemoRefundLedgerRow> {
    await this.gate();
    if (this.demoLedgerOrders.has(row.orderId)) {
      throw new UniqueViolationError(CONSTRAINTS.demoLedgerOrder);
    }
    this.demoLedgerOrders.add(row.orderId);
    this.demoLedger.push(clone(row));
    return clone(row);
  }

  async listDemoRefundsSince(sinceMs: number): Promise<DemoRefundLedgerRow[]> {
    return this.demoLedger.filter((r) => r.createdAt >= sinceMs).map(clone);
  }

  async listDemoRefundsForWalletSince(
    wallet: string,
    sinceMs: number,
  ): Promise<DemoRefundLedgerRow[]> {
    return this.demoLedger
      .filter((r) => r.walletAddress === wallet && r.createdAt >= sinceMs)
      .map(clone);
  }
}
