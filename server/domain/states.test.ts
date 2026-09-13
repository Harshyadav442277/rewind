import { describe, expect, it } from 'vitest';
import {
  ORDER_STATES,
  allowedNext,
  assertTransition,
  canTransition,
  checkInvariants,
  isTerminal,
} from './states';

describe('state machine invariants', () => {
  it('has no invariant violations', () => {
    expect(checkInvariants()).toEqual([]);
  });

  it('REFUNDED is terminal', () => {
    expect(isTerminal('REFUNDED')).toBe(true);
    expect(allowedNext('REFUNDED')).toEqual([]);
    for (const state of ORDER_STATES) {
      expect(canTransition('REFUNDED', state)).toBe(false);
    }
  });

  it('nothing but a refund request may lead to REFUND_APPROVED', () => {
    const sources = ORDER_STATES.filter((from) => canTransition(from, 'REFUND_APPROVED'));
    expect(sources).toEqual(['REFUND_REQUESTED']);
  });

  it('a broadcast refund can never go back to approval', () => {
    expect(canTransition('REFUND_BROADCAST', 'REFUND_APPROVED')).toBe(false);
    expect(canTransition('REFUND_FAILED', 'REFUND_APPROVED')).toBe(false);
    expect(canTransition('REFUNDED', 'REFUND_APPROVED')).toBe(false);
  });

  it('refuses an illegal transition loudly', () => {
    expect(() => assertTransition('CREATED', 'REFUNDED')).toThrow(/illegal transition/);
    expect(() => assertTransition('PAID', 'REFUND_REQUESTED')).not.toThrow();
  });
});
