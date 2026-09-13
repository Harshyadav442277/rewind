/**
 * Caps on the built-in Demo Store treasury.
 *
 * The Demo Store is the only place where a server-held wallet sends NIM without a human
 * pressing approve, so it is the only place where a bug or an abuser can drain something.
 * A real merchant always signs their own refund in their own wallet and none of this applies.
 *
 * Caps are checked against the `demo_refunds` ledger at reservation time, before any
 * transaction is built, and the ledger row is written in the same reservation. A refund that
 * later fails on chain still leaves its ledger row: the cap counts NIM committed, not NIM
 * confirmed, because the alternative is a retry loop that spends past the cap.
 */

import type { DemoRefundLedgerRow } from './types';

export interface TreasuryCaps {
  /** Largest single refund the treasury will send. */
  maxLunaPerRefund: number;
  /** Rolling per-recipient-wallet window. */
  walletWindowMs: number;
  maxRefundsPerWalletPerWindow: number;
  maxLunaPerWalletPerWindow: number;
  /** Rolling global hour. */
  maxRefundsPerHourGlobal: number;
  maxLunaPerHourGlobal: number;
  /** Hard ceiling on everything the treasury will ever send. */
  maxLunaTotal: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Defaults, in Luna (1 NIM = 100_000 Luna). Chosen so the whole demo can be run repeatedly
 * for well under a NIM, and so the worst case if the treasury key leaks is 50 NIM.
 * Override per environment via `api/_lib/deps.ts`; never raise them in code.
 */
export const DEFAULT_TREASURY_CAPS: TreasuryCaps = {
  maxLunaPerRefund: 100_000, // 1 NIM
  walletWindowMs: 24 * HOUR_MS,
  maxRefundsPerWalletPerWindow: 3,
  maxLunaPerWalletPerWindow: 300_000, // 3 NIM
  maxRefundsPerHourGlobal: 20,
  maxLunaPerHourGlobal: 2_000_000, // 20 NIM
  maxLunaTotal: 5_000_000, // 50 NIM
};

export type CapDenialReason =
  | 'per_refund_amount'
  | 'wallet_count'
  | 'wallet_amount'
  | 'global_hourly_count'
  | 'global_hourly_amount'
  | 'global_total';

export type CapDecision =
  | { allowed: true }
  | { allowed: false; reason: CapDenialReason; detail: string };

export interface CapInput {
  amountLuna: number;
  nowMs: number;
  /** Ledger rows for this recipient wallet, any age. Filtered by window here. */
  walletRows: readonly DemoRefundLedgerRow[];
  /** Every ledger row from the last hour. */
  globalHourRows: readonly DemoRefundLedgerRow[];
  /** Total Luna the treasury has ever committed. */
  totalLunaCommitted: number;
}

const sum = (rows: readonly DemoRefundLedgerRow[]): number =>
  rows.reduce((acc, r) => acc + r.amountLuna, 0);

/** Pure. Same inputs, same answer, no clock and no repository of its own. */
export function checkTreasuryCaps(input: CapInput, caps: TreasuryCaps): CapDecision {
  const { amountLuna, nowMs } = input;

  if (amountLuna > caps.maxLunaPerRefund) {
    return {
      allowed: false,
      reason: 'per_refund_amount',
      detail: `${amountLuna} > ${caps.maxLunaPerRefund} Luna`,
    };
  }

  const windowStart = nowMs - caps.walletWindowMs;
  const inWindow = input.walletRows.filter((r) => r.createdAt >= windowStart);
  if (inWindow.length >= caps.maxRefundsPerWalletPerWindow) {
    return {
      allowed: false,
      reason: 'wallet_count',
      detail: `${inWindow.length} of ${caps.maxRefundsPerWalletPerWindow} demo refunds used for this wallet`,
    };
  }
  if (sum(inWindow) + amountLuna > caps.maxLunaPerWalletPerWindow) {
    return {
      allowed: false,
      reason: 'wallet_amount',
      detail: `${sum(inWindow) + amountLuna} > ${caps.maxLunaPerWalletPerWindow} Luna for this wallet`,
    };
  }

  const hourStart = nowMs - HOUR_MS;
  const thisHour = input.globalHourRows.filter((r) => r.createdAt >= hourStart);
  if (thisHour.length >= caps.maxRefundsPerHourGlobal) {
    return {
      allowed: false,
      reason: 'global_hourly_count',
      detail: `${thisHour.length} of ${caps.maxRefundsPerHourGlobal} demo refunds used this hour`,
    };
  }
  if (sum(thisHour) + amountLuna > caps.maxLunaPerHourGlobal) {
    return {
      allowed: false,
      reason: 'global_hourly_amount',
      detail: `${sum(thisHour) + amountLuna} > ${caps.maxLunaPerHourGlobal} Luna this hour`,
    };
  }

  if (input.totalLunaCommitted + amountLuna > caps.maxLunaTotal) {
    return {
      allowed: false,
      reason: 'global_total',
      detail: `${input.totalLunaCommitted + amountLuna} > ${caps.maxLunaTotal} Luna lifetime`,
    };
  }

  return { allowed: true };
}

export function describeCapDenial(reason: CapDenialReason): string {
  switch (reason) {
    case 'per_refund_amount':
      return 'This amount is above the Demo Store refund cap.';
    case 'wallet_count':
    case 'wallet_amount':
      return 'This wallet has used its Demo Store refund allowance. A real merchant refund is not capped.';
    case 'global_hourly_count':
    case 'global_hourly_amount':
      return 'The Demo Store has hit its hourly limit. Try again later.';
    case 'global_total':
      return 'The Demo Store treasury is exhausted.';
  }
}
