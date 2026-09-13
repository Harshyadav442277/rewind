import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TREASURY_CAPS,
  checkTreasuryCaps,
  type CapInput,
  type TreasuryCaps,
} from './demo-treasury';
import { executeTreasuryRefund, reserveRefund, settleRefund } from './refund-reservation';
import type { DemoRefundLedgerRow } from './types';
import { PAYER, makeHarness, orderAwaitingApproval } from './test-helpers';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<DemoRefundLedgerRow> = {}): DemoRefundLedgerRow {
  return {
    id: 'dled_1',
    orderId: 'o1',
    walletAddress: PAYER,
    amountLuna: 1_000,
    createdAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<CapInput> = {}): CapInput {
  return {
    amountLuna: 1_000,
    nowMs: NOW,
    walletRows: [],
    globalHourRows: [],
    totalLunaCommitted: 0,
    ...overrides,
  };
}

describe('treasury caps', () => {
  it('allows a small refund against an empty ledger', () => {
    expect(checkTreasuryCaps(input(), DEFAULT_TREASURY_CAPS)).toEqual({ allowed: true });
  });

  it('refuses a refund above the per-refund cap', () => {
    const decision = checkTreasuryCaps(
      input({ amountLuna: DEFAULT_TREASURY_CAPS.maxLunaPerRefund + 1 }),
      DEFAULT_TREASURY_CAPS,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('per_refund_amount');
  });

  it('counts a wallet only inside its window', () => {
    const caps: TreasuryCaps = { ...DEFAULT_TREASURY_CAPS, maxRefundsPerWalletPerWindow: 1 };
    const stale = row({ createdAt: NOW - caps.walletWindowMs - 1 });
    expect(checkTreasuryCaps(input({ walletRows: [stale] }), caps)).toEqual({ allowed: true });

    const recent = row({ createdAt: NOW - 60_000 });
    const decision = checkTreasuryCaps(input({ walletRows: [recent] }), caps);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('wallet_count');
  });

  it('refuses when a wallet would go over its Luna allowance', () => {
    const caps: TreasuryCaps = {
      ...DEFAULT_TREASURY_CAPS,
      maxRefundsPerWalletPerWindow: 10,
      maxLunaPerWalletPerWindow: 1_500,
    };
    const decision = checkTreasuryCaps(input({ walletRows: [row()] }), caps);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('wallet_amount');
  });

  it('refuses on the global hourly count, ignoring rows older than the hour', () => {
    const caps: TreasuryCaps = { ...DEFAULT_TREASURY_CAPS, maxRefundsPerHourGlobal: 2 };
    const old = [row({ id: 'a', createdAt: NOW - HOUR - 1 }), row({ id: 'b', createdAt: NOW - HOUR - 2 })];
    expect(checkTreasuryCaps(input({ globalHourRows: old }), caps)).toEqual({ allowed: true });

    const recent = [row({ id: 'c', createdAt: NOW - 10 }), row({ id: 'd', createdAt: NOW - 20 })];
    const decision = checkTreasuryCaps(input({ globalHourRows: recent }), caps);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('global_hourly_count');
  });

  it('refuses on the global hourly Luna total', () => {
    const caps: TreasuryCaps = {
      ...DEFAULT_TREASURY_CAPS,
      maxRefundsPerHourGlobal: 100,
      maxLunaPerHourGlobal: 1_500,
    };
    const decision = checkTreasuryCaps(input({ globalHourRows: [row()] }), caps);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('global_hourly_amount');
  });

  it('refuses once the lifetime ceiling is reached', () => {
    const caps: TreasuryCaps = { ...DEFAULT_TREASURY_CAPS, maxLunaTotal: 1_500 };
    const decision = checkTreasuryCaps(input({ totalLunaCommitted: 1_000 }), caps);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('global_total');
  });
});

describe('caps stop a second treasury refund end to end', () => {
  it('refuses to reserve once the wallet has used its allowance', async () => {
    const h = makeHarness({
      treasuryCaps: { ...DEFAULT_TREASURY_CAPS, maxRefundsPerWalletPerWindow: 1 },
    });

    const first = await orderAwaitingApproval(h);
    expect((await reserveRefund(h.deps, first.id)).ok).toBe(true);
    await executeTreasuryRefund(h.deps, first.id);
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    expect((await settleRefund(h.deps, first.id)).status).toBe('refunded');
    expect(await h.repo.listDemoRefundsSince(0)).toHaveLength(1);

    const second = await orderAwaitingApproval(h);
    const denied = await reserveRefund(h.deps, second.id);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.reason).toBe('cap_denied');
    expect(denied.capReason).toBe('wallet_count');

    // Nothing was reserved and nothing was sent for the second order.
    expect(await h.repo.getRefundExecutionByOrder(second.id)).toBeNull();
    expect(h.broadcaster.distinctSentCount()).toBe(1);
    expect((await h.repo.getOrder(second.id))?.state).toBe('REFUND_REQUESTED');
  });

  it('writes exactly one ledger row per order even when the send is retried', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    await reserveRefund(h.deps, order.id);

    h.broadcaster.outcome = 'throw_before_send';
    await executeTreasuryRefund(h.deps, order.id);
    h.broadcaster.outcome = 'ok';
    await executeTreasuryRefund(h.deps, order.id);
    await executeTreasuryRefund(h.deps, order.id);

    expect(await h.repo.listDemoRefundsSince(0)).toHaveLength(1);
    expect(h.broadcaster.distinctSentCount()).toBe(1);
  });
});
