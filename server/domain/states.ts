/**
 * The order / refund state machine.
 *
 * Two invariants matter more than the rest, because they are the ones that would move
 * money twice or lose it:
 *   I1  REFUNDED is terminal.
 *   I2  Nothing may transition back into REFUND_APPROVED. Once an obligation is approved
 *       and a transaction is recorded, recovery re-checks the chain and re-sends the very
 *       same serialised transaction; it never re-enters approval and never builds a second one.
 */

export const ORDER_STATES = [
  'CREATED',
  'PAYMENT_PENDING',
  'PAID',
  'REFUND_REQUESTED',
  'REFUND_APPROVED',
  'REFUND_BROADCAST',
  'REFUNDED',
  'REFUND_FAILED',
  'REJECTED',
  'EXPIRED',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/**
 * Allowed transitions. Anything not listed is refused.
 *
 * PAYMENT_PENDING -> CREATED is the one apparent step backwards: a payment hint that the
 * chain refuses (wrong amount, wrong recipient, never included) drops the order back to
 * awaiting payment. No money has moved into the order at that point.
 */
const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  CREATED: ['PAYMENT_PENDING', 'EXPIRED'],
  PAYMENT_PENDING: ['PAID', 'CREATED', 'EXPIRED'],
  PAID: ['REFUND_REQUESTED'],
  REFUND_REQUESTED: ['REFUND_APPROVED', 'REJECTED'],
  REFUND_APPROVED: ['REFUND_BROADCAST', 'REFUNDED', 'REFUND_FAILED'],
  REFUND_BROADCAST: ['REFUNDED', 'REFUND_FAILED'],
  REFUNDED: [],
  REFUND_FAILED: [],
  REJECTED: [],
  EXPIRED: [],
};

export const TERMINAL_STATES: readonly OrderState[] = [
  'REFUNDED',
  'REFUND_FAILED',
  'REJECTED',
  'EXPIRED',
];

/** States in which a refund obligation exists and money may already be in flight. */
export const REFUND_IN_FLIGHT_STATES: readonly OrderState[] = ['REFUND_APPROVED', 'REFUND_BROADCAST'];

export function isOrderState(value: unknown): value is OrderState {
  return typeof value === 'string' && (ORDER_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function allowedNext(state: OrderState): readonly OrderState[] {
  return TRANSITIONS[state];
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Structural check of the two money invariants, run as a test so a careless edit to
 * TRANSITIONS cannot pass silently.
 */
export function checkInvariants(): string[] {
  const problems: string[] = [];
  if (TRANSITIONS.REFUNDED.length > 0) {
    problems.push('I1 violated: REFUNDED has outgoing transitions');
  }
  for (const from of ORDER_STATES) {
    if (TRANSITIONS[from].includes('REFUND_APPROVED') && from !== 'REFUND_REQUESTED') {
      problems.push(`I2 violated: ${from} -> REFUND_APPROVED`);
    }
  }
  for (const terminal of TERMINAL_STATES) {
    if (TRANSITIONS[terminal].length > 0) {
      problems.push(`terminal state ${terminal} has outgoing transitions`);
    }
  }
  return problems;
}

/** Display copy. The product never says "reversible NIM"; a refund is approved, then verified. */
export const STATE_LABELS: Readonly<Record<OrderState, string>> = {
  CREATED: 'Awaiting payment',
  PAYMENT_PENDING: 'Checking the chain',
  PAID: 'Payment verified on chain',
  REFUND_REQUESTED: 'Refund requested, signature verified',
  REFUND_APPROVED: 'Merchant approved the refund',
  REFUND_BROADCAST: 'Refund sent, waiting for the chain',
  REFUNDED: 'Refund verified on chain',
  REFUND_FAILED: 'Refund failed — needs a person',
  REJECTED: 'Refund rejected by the merchant',
  EXPIRED: 'Order expired',
};
