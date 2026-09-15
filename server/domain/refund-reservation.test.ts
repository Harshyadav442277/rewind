import { describe, expect, it } from 'vitest';
import type { DomainDeps } from './deps.js';
import type { ChainReader } from './ports.js';
import { fakeKeyFor, fakeSign } from './fakes.js';
import {
  executeTreasuryRefund,
  issueRefundChallenge,
  recordMerchantRefundBroadcast,
  rejectRefund,
  reserveRefund,
  resumeUnsettledRefunds,
  settleRefund,
  submitSignedRefundRequest,
} from './refund-reservation.js';
import {
  OTHER,
  SHOP,
  createPaidOrder,
  installGate,
  makeHarness,
  orderAwaitingApproval,
  signRefundRequest,
  type Harness,
} from './test-helpers.js';

/** A new deps object over the same storage and the same chain: a process restart. */
function restart(h: Harness): DomainDeps {
  return { ...h.deps };
}

describe('signed refund request', () => {
  it('accepts a signature from the wallet that paid', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const signed = await signRefundRequest(h, order.id);

    const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.state).toBe('REFUND_REQUESTED');
    expect(result.challenge.consumedAt).not.toBeNull();
  });

  it('rejects a signature from any other wallet', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const signed = await signRefundRequest(h, order.id, OTHER);

    const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('wrong_signer');

    const fresh = await h.repo.getOrder(order.id);
    expect(fresh?.state).toBe('PAID');
  });

  describe('a payer that is an HTLC, the way Nimiq Pay pays (GAPS N29)', () => {
    // The mainnet pair observed on 2026-09-14.
    const HTLC = 'NQ66 DL0K CXPR 0ACP 0D7T 06G4 67KT SQ6P 7M05';
    const FUNDER = 'NQ87 T28S MDL1 TUC7 7L8L 5BED J4HC KBM7 MUXR';

    it('sends the refund to the wallet that funded the HTLC, never to the HTLC', async () => {
      const h = makeHarness();
      h.chain.setHtlc(HTLC, FUNDER);
      const order = await createPaidOrder(h, { payer: HTLC });
      expect(order.payerAddress).toBe(HTLC);

      const signed = await signRefundRequest(h, order.id, FUNDER);
      expect(signed.message).toContain(`refundTo=${FUNDER}`);

      const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.challenge.signerAddress).toBe(FUNDER);

      const reserved = await reserveRefund(h.deps, order.id);
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      expect(reserved.execution.refundTo).toBe(FUNDER);
    });

    it('refuses a signature from the HTLC address or any wallet other than the funder', async () => {
      const h = makeHarness();
      h.chain.setHtlc(HTLC, FUNDER);
      for (const signer of [HTLC, OTHER]) {
        const order = await createPaidOrder(h, { payer: HTLC });
        const signed = await signRefundRequest(h, order.id, signer);
        const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('wrong_signer');
      }
    });
  });

  it('issues no refund request when the payer is an account it cannot refund', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const inner = h.deps.chain;
    const staking: ChainReader = {
      getBlockNumber: () => inner.getBlockNumber(),
      getAccountByAddress: async (address) => ({
        data: { address, balance: 1, type: 'staking' },
        fetchedAtMs: h.clock.nowMs(),
        source: 'network',
      }),
      getTransactionByHash: (hash) => inner.getTransactionByHash(hash),
      getTransactionsByAddress: (address, max, startAt) =>
        inner.getTransactionsByAddress(address, max, startAt),
    };

    const issued = await issueRefundChallenge({ ...h.deps, chain: staking }, order.id);
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.reason).toBe('unrefundable_payer');
  });

  it('rejects an expired challenge', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const signed = await signRefundRequest(h, order.id);

    h.clock.advance((h.deps.config.challengeTtlSec + 1) * 1000);

    const result = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('challenge_rejected');
    expect(result.detail).toMatch(/^expired/);
  });

  it('rejects a replayed nonce', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const signed = await signRefundRequest(h, order.id);

    const first = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
    expect(first.ok).toBe(true);

    const replay = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe('nonce_already_used');
  });

  it('rejects text that differs from the issued challenge by a single byte', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const issued = await issueRefundChallenge(h.deps, order.id);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    // Same nonce, one digit more on the amount, signed correctly over the tampered text.
    const tampered = issued.challenge.message.replace('amountLuna=1000', 'amountLuna=1001');
    const key = h.verifier.register(fakeKeyFor(issued.challenge.refundTo));

    const result = await submitSignedRefundRequest(h.deps, {
      orderId: order.id,
      message: tampered,
      publicKey: key.publicKey,
      signature: fakeSign(key, tampered),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('message_mismatch');
  });

  it('rejects a nonce Rewind never issued', async () => {
    const h = makeHarness();
    const order = await createPaidOrder(h);
    const signed = await signRefundRequest(h, order.id);
    const foreign = signed.message.replace(/nonce=[0-9a-f]{32}/, `nonce=${'f'.repeat(32)}`);
    const key = h.verifier.registerAddress(
      (await h.repo.getOrder(order.id))?.payerAddress ?? '',
    );

    const result = await submitSignedRefundRequest(h.deps, {
      orderId: order.id,
      message: foreign,
      publicKey: key.publicKey,
      signature: fakeSign(key, foreign),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_nonce');
  });
});

describe('reservation is exactly once', () => {
  it('two concurrent approvals produce one reservation and one refund', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    installGate(h.repo);

    const [a, b] = await Promise.all([
      reserveRefund(h.deps, order.id),
      reserveRefund(h.deps, order.id),
    ]);

    const outcomes = [a, b].map((r) => (r.ok ? (r.alreadyReserved ? 'existing' : 'new') : `fail:${r.reason}`));
    expect(outcomes.filter((o) => o === 'new')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'existing')).toHaveLength(1);

    const executions = await h.repo.listUnsettledRefundExecutions();
    expect(executions).toHaveLength(1);

    h.repo.setGate(null);
    await executeTreasuryRefund(h.deps, order.id);
    expect(h.broadcaster.distinctSentCount()).toBe(1);
  });

  it('approving twice in a row cannot create a second obligation', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);

    const first = await reserveRefund(h.deps, order.id);
    const second = await reserveRefund(h.deps, order.id);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.alreadyReserved).toBe(false);
    expect(second.alreadyReserved).toBe(true);
    expect(second.execution.id).toBe(first.execution.id);
    expect(await h.repo.listUnsettledRefundExecutions()).toHaveLength(1);
  });

  it('refuses to reject an order that already carries an obligation', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    await reserveRefund(h.deps, order.id);

    expect(await rejectRefund(h.deps, order.id)).toBeNull();
    const fresh = await h.repo.getOrder(order.id);
    expect(fresh?.state).not.toBe('REJECTED');
  });

  it('rejects a refund request that has not been approved', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    const rejected = await rejectRefund(h.deps, order.id);
    expect(rejected?.state).toBe('REJECTED');
    expect(await h.repo.getRefundExecutionByOrder(order.id)).toBeNull();
  });
});

describe('preparation is exactly once', () => {
  it('two concurrent sends produce one transaction even when the height moves between them', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    await reserveRefund(h.deps, order.id);

    // A chain whose height advances on every read, so two preparers would otherwise build
    // two different transactions with two different validity start heights.
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

    installGate(h.repo);
    await Promise.all([
      executeTreasuryRefund(deps, order.id),
      executeTreasuryRefund(deps, order.id),
    ]);
    h.repo.setGate(null);

    // Two candidate transactions were built; exactly one was ever allowed to exist or be sent.
    expect(h.builder.prepared.length).toBeGreaterThanOrEqual(1);
    expect(h.broadcaster.distinctSentCount()).toBe(1);

    const execution = await h.repo.getRefundExecutionByOrder(order.id);
    expect(h.broadcaster.sent[0]).toBe(execution?.serializedTx);
  });
});

describe('crash recovery', () => {
  it('settles without re-sending when the crash happened after the broadcast', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    await reserveRefund(h.deps, order.id);

    // The bytes reach the network and then the response is lost.
    h.broadcaster.outcome = 'send_then_throw';
    const attempt = await executeTreasuryRefund(h.deps, order.id);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.reason).toBe('broadcast_error');

    const stored = await h.repo.getRefundExecutionByOrder(order.id);
    expect(stored?.serializedTx).not.toBeNull();
    expect(stored?.intendedTxHash).not.toBeNull();
    expect(stored?.broadcastAt).toBeNull();
    expect(h.broadcaster.sent).toHaveLength(1);

    // Restart. The chain now has the transaction; recovery must find it, not repeat it.
    const revived = restart(h);
    h.broadcaster.outcome = 'ok';
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    const summary = await resumeUnsettledRefunds(revived);

    expect(summary.settled).toBe(1);
    expect(summary.resent).toBe(0);
    expect(h.broadcaster.calls).toHaveLength(1);
    expect(h.broadcaster.distinctSentCount()).toBe(1);

    const settledOrder = await h.repo.getOrder(order.id);
    expect(settledOrder?.state).toBe('REFUNDED');
    const execution = await h.repo.getRefundExecutionByOrder(order.id);
    expect(execution?.refundTxHash).toBe(execution?.intendedTxHash);
    expect(execution?.confirmedAt).not.toBeNull();
  });

  it('re-sends the same bytes when the crash happened before the broadcast', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);
    await reserveRefund(h.deps, order.id);

    h.broadcaster.outcome = 'throw_before_send';
    const attempt = await executeTreasuryRefund(h.deps, order.id);
    expect(attempt.ok).toBe(false);
    expect(h.broadcaster.sent).toHaveLength(0);

    const before = await h.repo.getRefundExecutionByOrder(order.id);
    expect(before?.serializedTx).not.toBeNull();

    const revived = restart(h);
    h.broadcaster.outcome = 'ok';
    const first = await resumeUnsettledRefunds(revived);
    expect(first.resent).toBe(1);

    // Same bytes, so the same transaction. Never a second one.
    const after = await h.repo.getRefundExecutionByOrder(order.id);
    expect(after?.serializedTx).toBe(before?.serializedTx);
    expect(after?.intendedTxHash).toBe(before?.intendedTxHash);
    expect(h.broadcaster.distinctSentCount()).toBe(1);

    h.chain.advanceHeight(h.deps.config.minConfirmations);
    const second = await resumeUnsettledRefunds(revived);
    expect(second.settled).toBe(1);
    expect(h.broadcaster.distinctSentCount()).toBe(1);
    expect((await h.repo.getOrder(order.id))?.state).toBe('REFUNDED');
  });

  it('runs the whole demo flow to a verified refund', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h);

    const reserved = await reserveRefund(h.deps, order.id);
    expect(reserved.ok).toBe(true);
    await executeTreasuryRefund(h.deps, order.id);
    h.chain.advanceHeight(h.deps.config.minConfirmations);
    const settled = await settleRefund(h.deps, order.id);

    expect(settled.status).toBe('refunded');
    expect(settled.order?.state).toBe('REFUNDED');
    expect(settled.execution?.refundTxHash).not.toBeNull();
    expect(h.broadcaster.distinctSentCount()).toBe(1);

    // Terminal. Another sweep changes nothing and sends nothing.
    const again = await resumeUnsettledRefunds(h.deps);
    expect(again.checked).toBe(0);
    expect(h.broadcaster.distinctSentCount()).toBe(1);
  });
});

describe('merchant-funded refunds', () => {
  it('only accepts a reported refund transaction that the chain agrees with', async () => {
    const h = makeHarness();
    const order = await orderAwaitingApproval(h, { merchantId: 'shop' });
    const reserved = await reserveRefund(h.deps, order.id);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.execution.source).toBe('MERCHANT_WALLET');

    // A hash for a transaction that pays the wrong person.
    const wrong = h.chain.include({
      from: reserved.execution.refunderAddress,
      to: OTHER,
      value: reserved.execution.amountLuna,
      data: `RW1:R:${order.id}`,
      timestamp: h.clock.nowMs(),
    });
    h.chain.advanceHeight(h.deps.config.minConfirmations);

    await recordMerchantRefundBroadcast(h.deps, order.id, wrong.hash);
    const settled = await settleRefund(h.deps, order.id);

    expect(settled.status).toBe('failed');
    expect(settled.order?.state).toBe('REFUND_FAILED');
    expect(settled.mismatch?.kind).toBe('recipient_mismatch');
    expect(settled.execution?.refundTxHash).toBeNull();
  });

  describe('a refund the merchant sends from Nimiq Pay, with no hash reported', () => {
    // Merchant wallet SHOP pays out of its own HTLC, exactly as a buyer does (GAPS N29).
    const SHOP_HTLC = 'NQ66 DL0K CXPR 0ACP 0D7T 06G4 67KT SQ6P 7M05';

    async function approvedMerchantOrder(h: Harness) {
      const order = await orderAwaitingApproval(h, { merchantId: 'shop' });
      const reserved = await reserveRefund(h.deps, order.id);
      if (!reserved.ok) throw new Error(reserved.reason);
      return { order, execution: reserved.execution };
    }

    it('is found on chain by its reference and settles, even when it leaves the merchant HTLC', async () => {
      const h = makeHarness();
      h.chain.setHtlc(SHOP_HTLC, SHOP);
      const { order, execution } = await approvedMerchantOrder(h);

      const waiting = await settleRefund(h.deps, order.id);
      expect(waiting.status).toBe('pending');
      expect(waiting.message).toMatch(/Waiting for the merchant/);

      const sent = h.chain.include({
        from: SHOP_HTLC,
        to: execution.refundTo,
        value: execution.amountLuna,
        data: `RW1:R:${order.id}`,
        timestamp: h.clock.nowMs(),
      });
      h.chain.advanceHeight(h.deps.config.minConfirmations);

      const settled = await settleRefund(h.deps, order.id);
      expect(settled.status).toBe('refunded');
      expect(settled.order?.state).toBe('REFUNDED');
      expect(settled.execution?.refundTxHash).toBe(sent.hash);
    });

    it('ignores a lookalike from a wallet the merchant does not control, and does not fail the order', async () => {
      const h = makeHarness();
      const { order, execution } = await approvedMerchantOrder(h);

      h.chain.include({
        from: OTHER,
        to: execution.refundTo,
        value: execution.amountLuna,
        data: `RW1:R:${order.id}`,
        timestamp: h.clock.nowMs(),
      });
      h.chain.advanceHeight(h.deps.config.minConfirmations);

      const settled = await settleRefund(h.deps, order.id);
      expect(settled.status).toBe('pending');
      expect((await h.repo.getOrder(order.id))?.state).toBe('REFUND_APPROVED');
    });

    it('does not settle a refund sent from an HTLC somebody else funded', async () => {
      const h = makeHarness();
      h.chain.setHtlc(SHOP_HTLC, OTHER);
      const { order, execution } = await approvedMerchantOrder(h);

      h.chain.include({
        from: SHOP_HTLC,
        to: execution.refundTo,
        value: execution.amountLuna,
        data: `RW1:R:${order.id}`,
        timestamp: h.clock.nowMs(),
      });
      h.chain.advanceHeight(h.deps.config.minConfirmations);

      expect((await settleRefund(h.deps, order.id)).status).toBe('pending');
    });

    it('lets a shop refund its own wallet when it was paid from that wallet\'s HTLC', async () => {
      // One Nimiq Pay wallet as both shop and buyer: HTLC → shop, refund HTLC → shop.
      const h = makeHarness();
      h.chain.setHtlc(SHOP_HTLC, SHOP);
      const order = await createPaidOrder(h, { merchantId: 'shop', payer: SHOP_HTLC });
      const signed = await signRefundRequest(h, order.id, SHOP);
      const submitted = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
      expect(submitted.ok).toBe(true);

      const reserved = await reserveRefund(h.deps, order.id);
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      expect(reserved.execution.refundTo).toBe(SHOP);
      expect(reserved.execution.refunderAddress).toBe(SHOP);

      h.chain.include({
        from: SHOP_HTLC,
        to: SHOP,
        value: reserved.execution.amountLuna,
        data: `RW1:R:${order.id}`,
        timestamp: h.clock.nowMs(),
      });
      h.chain.advanceHeight(h.deps.config.minConfirmations);
      expect((await settleRefund(h.deps, order.id)).status).toBe('refunded');
    });

    it('still lets the demo treasury path report nothing to check before it broadcasts', async () => {
      const h = makeHarness({ demoAutoApprove: false });
      const order = await orderAwaitingApproval(h);
      const reserved = await reserveRefund(h.deps, order.id);
      expect(reserved.ok).toBe(true);
      expect((await settleRefund(h.deps, order.id)).status).toBe('nothing_to_check');
    });
  });
});
