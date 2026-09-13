/**
 * JSON shapes the client sees. Kept in one file so a field can never mean two things.
 *
 * Nothing unverified is ever presented as verified: `paymentTxHash` and `refundTxHash` are
 * only ever populated from a chain record, while a hash the wallet merely reported appears
 * as `claimedPaymentTxHash` / `intendedTxHash` and the UI labels it as unconfirmed.
 */

import { formatLuna } from '../../server/domain/nimiq';
import { STATE_LABELS } from '../../server/domain/states';
import type { Order, RefundChallenge, RefundExecution } from '../../server/domain/types';

/**
 * UNVERIFIED: the explorer URL shape has not been checked against nimiq.watch from this
 * repository. If it is wrong the links 404 — nothing else breaks.
 */
const EXPLORER_BASE = process.env.REWIND_EXPLORER_BASE ?? 'https://nimiq.watch/#';

export function explorerUrl(hash: string | null): string | null {
  return hash ? `${EXPLORER_BASE}${hash}` : null;
}

export interface OrderView {
  id: string;
  state: string;
  stateLabel: string;
  merchantId: string;
  merchantAddress: string;
  itemLabel: string;
  amountLuna: number;
  amountLabel: string;
  networkId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  paymentTxHash: string | null;
  paymentExplorerUrl: string | null;
  payerAddress: string | null;
  paidAt: number | null;
  paymentBlockNumber: number | null;
  claimedPaymentTxHash: string | null;
  refundSource: string;
  refunderAddress: string;
  lastError: string | null;
  paymentReference: string;
  refundReference: string;
}

export function orderView(order: Order): OrderView {
  return {
    id: order.id,
    state: order.state,
    stateLabel: STATE_LABELS[order.state],
    merchantId: order.merchantId,
    merchantAddress: order.merchantAddress,
    itemLabel: order.itemLabel,
    amountLuna: order.amountLuna,
    amountLabel: formatLuna(order.amountLuna),
    networkId: String(order.networkId),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt,
    paymentTxHash: order.paymentTxHash,
    paymentExplorerUrl: explorerUrl(order.paymentTxHash),
    payerAddress: order.payerAddress,
    paidAt: order.paidAt,
    paymentBlockNumber: order.paymentBlockNumber,
    claimedPaymentTxHash: order.claimedPaymentTxHash,
    refundSource: order.refundSource,
    refunderAddress: order.refunderAddress,
    lastError: order.lastError,
    paymentReference: `RW1:P:${order.id}`,
    refundReference: `RW1:R:${order.id}`,
  };
}

export interface ExecutionView {
  id: string;
  source: string;
  refundTo: string;
  amountLuna: number;
  amountLabel: string;
  refunderAddress: string;
  /** A transaction we intend to send, or that a merchant says they sent. Not evidence. */
  intendedTxHash: string | null;
  broadcastAt: number | null;
  /** Only ever set from a chain record that passed verifyRefund. */
  refundTxHash: string | null;
  refundExplorerUrl: string | null;
  refundBlockNumber: number | null;
  confirmedAt: number | null;
  failureReason: string | null;
}

export function executionView(execution: RefundExecution): ExecutionView {
  return {
    id: execution.id,
    source: execution.source,
    refundTo: execution.refundTo,
    amountLuna: execution.amountLuna,
    amountLabel: formatLuna(execution.amountLuna),
    refunderAddress: execution.refunderAddress,
    intendedTxHash: execution.intendedTxHash,
    broadcastAt: execution.broadcastAt,
    refundTxHash: execution.refundTxHash,
    refundExplorerUrl: explorerUrl(execution.refundTxHash),
    refundBlockNumber: execution.refundBlockNumber,
    confirmedAt: execution.confirmedAt,
    failureReason: execution.failureReason,
  };
}

export interface ChallengeView {
  nonce: string;
  message: string;
  refundTo: string;
  amountLuna: number;
  expiresAtSec: number;
  consumedAt: number | null;
  signerAddress: string | null;
  signatureHex: string | null;
}

export function challengeView(challenge: RefundChallenge): ChallengeView {
  return {
    nonce: challenge.nonce,
    message: challenge.message,
    refundTo: challenge.refundTo,
    amountLuna: challenge.amountLuna,
    expiresAtSec: challenge.expiresAtSec,
    consumedAt: challenge.consumedAt,
    signerAddress: challenge.signerAddress,
    signatureHex: challenge.signatureHex,
  };
}
