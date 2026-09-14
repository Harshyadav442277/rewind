/** Shared fixtures for the domain tests. Offline: no timers that wait, no sockets, no files. */

import { InMemoryRepository } from '../db/memory.js';
import type { Repository } from '../db/repository.js';
import { DEFAULT_CONFIG, type DomainConfig, type DomainDeps } from './deps.js';
import {
  FakeChain,
  FakeChainReader,
  FakeRefundTxBuilder,
  FakeSignatureVerifier,
  FakeTxBroadcaster,
  ManualClock,
  SeededRandom,
  fakeKeyFor,
  fakeSign,
} from './fakes.js';
import { buildReference } from './nimiq.js';
import { createOrder, submitPaymentHint, verifyOrderPayment } from './order-service.js';
import { issueRefundChallenge, submitSignedRefundRequest } from './refund-reservation.js';
import type { Merchant, Order } from './types.js';

export const TREASURY = 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001';
export const PAYER = 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001';
export const OTHER = 'NQ13 0THE R000 0000 0000 0000 0000 0000 0003';
export const SHOP = 'NQ64 5H0P 0000 0000 0000 0000 0000 0000 0004';

export const AMOUNT_LUNA = 1_000;

export const DEMO_MERCHANT: Merchant = {
  id: 'demo-store',
  name: 'Rewind Demo Store',
  address: TREASURY,
  allowTreasuryRefund: true,
};

export const PLAIN_MERCHANT: Merchant = {
  id: 'shop',
  name: 'A shop that signs its own refunds',
  address: SHOP,
  allowTreasuryRefund: false,
};

/**
 * The harness over ANY repository. `postgres.integration.test.ts` runs the same domain flows
 * over `PostgresRepository`, so the fixtures below must not assume the in-memory one.
 */
export interface HarnessOver {
  deps: DomainDeps;
  repo: Repository;
  chain: FakeChain;
  clock: ManualClock;
  verifier: FakeSignatureVerifier;
  builder: FakeRefundTxBuilder;
  broadcaster: FakeTxBroadcaster;
}

/** The in-memory harness, which is what every domain test uses. */
export interface Harness extends HarnessOver {
  repo: InMemoryRepository;
}

export function makeHarness(config: Partial<DomainConfig> = {}): Harness {
  const repo = new InMemoryRepository([DEMO_MERCHANT, PLAIN_MERCHANT]);
  return { ...makeHarnessOver(repo, config), repo };
}

/**
 * Same wiring, over a repository the caller supplies and has already seeded with
 * DEMO_MERCHANT and PLAIN_MERCHANT.
 */
export function makeHarnessOver(
  repo: Repository,
  config: Partial<DomainConfig> = {},
): HarnessOver {
  const clock = new ManualClock(1_700_000_000_000);
  const chain = new FakeChain();
  const verifier = new FakeSignatureVerifier();
  const builder = new FakeRefundTxBuilder(TREASURY);
  // Mirrors production wiring: a broadcast puts the transaction on the chain.
  const broadcaster = new FakeTxBroadcaster((serializedTx, hash) => {
    const parts = serializedTx.replace(/^fake-tx:/, '').split('|');
    chain.include({
      hash,
      from: TREASURY,
      to: parts[0] ?? '',
      value: Number(parts[1] ?? 0),
      data: parts[2] ?? '',
      timestamp: clock.nowMs(),
    });
  });

  const deps: DomainDeps = {
    repo,
    clock,
    random: new SeededRandom('test'),
    chain: new FakeChainReader(chain, clock),
    signatureVerifier: verifier,
    txBuilder: builder,
    broadcaster,
    config: { ...DEFAULT_CONFIG, ...config },
  };

  return { deps, repo, chain, clock, verifier, builder, broadcaster };
}

/** Creates an order, puts a matching payment on the fake chain, and verifies it. */
export async function createPaidOrder(
  h: HarnessOver,
  options: { merchantId?: string; payer?: string } = {},
): Promise<Order> {
  const merchantId = options.merchantId ?? DEMO_MERCHANT.id;
  const payer = options.payer ?? PAYER;

  const created = await createOrder(h.deps, {
    merchantId,
    itemLabel: 'Refund Test — 0.01 NIM',
    amountLuna: AMOUNT_LUNA,
  });
  if (!created.ok) throw new Error(`createOrder failed: ${created.reason}`);
  const order = created.order;

  const tx = h.chain.include({
    from: payer,
    to: order.merchantAddress,
    value: order.amountLuna,
    data: buildReference('P', order.id),
    networkId: String(h.deps.config.networkId),
    timestamp: h.clock.nowMs(),
  });
  h.chain.advanceHeight(h.deps.config.minConfirmations);

  const hint = await submitPaymentHint(h.deps, order.id, tx.hash);
  if (!hint.ok) throw new Error(`submitPaymentHint failed: ${hint.reason}`);

  const verified = await verifyOrderPayment(h.deps, order.id);
  if (verified.status !== 'paid') {
    throw new Error(`verifyOrderPayment: ${verified.status}`);
  }
  return verified.order;
}

/** Issues a challenge and signs it with a fake key bound to `signer`. */
export async function signRefundRequest(
  h: HarnessOver,
  orderId: string,
  signer: string = PAYER,
): Promise<{ message: string; publicKey: string; signature: string; nonce: string }> {
  const issued = await issueRefundChallenge(h.deps, orderId);
  if (!issued.ok) throw new Error(`issueRefundChallenge failed: ${issued.reason}`);
  const key = h.verifier.register(fakeKeyFor(signer));
  return {
    message: issued.challenge.message,
    publicKey: key.publicKey,
    signature: fakeSign(key, issued.challenge.message),
    nonce: issued.challenge.nonce,
  };
}

/** Paid order plus an accepted, signed refund request. State: REFUND_REQUESTED. */
export async function orderAwaitingApproval(
  h: HarnessOver,
  options: { merchantId?: string } = {},
): Promise<Order> {
  const order = await createPaidOrder(h, options);
  const signed = await signRefundRequest(h, order.id);
  const submitted = await submitSignedRefundRequest(h.deps, { orderId: order.id, ...signed });
  if (!submitted.ok) throw new Error(`submitSignedRefundRequest failed: ${submitted.reason}`);
  return submitted.order;
}

/** Forces two concurrent callers to interleave where a database round trip would happen. */
export function installGate(repo: InMemoryRepository): void {
  repo.setGate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
