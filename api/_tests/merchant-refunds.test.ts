/**
 * Offline. The shop's refund board, `GET /api/merchant/refunds`, driven through the real handler
 * and the same wiring a request uses: in-memory repository, fake chain, fake signature verifier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import handler from '../merchant/refunds.js';
import { DEMO_MERCHANT_ID, getDeps, getFakeSignatureVerifier, resetDeps } from '../_lib/deps.js';
import { issueAndRecordMerchantChallenge } from '../_lib/merchant-auth.js';
import { resetRateLimits } from '../_lib/ratelimit.js';
import type { ApiRequest, ApiResponse } from '../_lib/http.js';
import { LIST_ORDER_SENTINEL } from '../../server/domain/merchant-auth.js';
import { merchantIdForAddress } from '../../server/domain/merchant-registration.js';
import { fakeKeyFor, fakeSign } from '../../server/domain/fakes.js';
import type { Merchant, Order } from '../../server/domain/types.js';
import type { OrderState } from '../../server/domain/states.js';

const SHOP_ADDRESS = 'NQ64 5H0P 0000 0000 0000 0000 0000 0000 0004';
const OTHER_SHOP_ADDRESS = 'NQ13 0THE R000 0000 0000 0000 0000 0000 0003';
const PAYER = 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001';

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function makeRes(): { res: ApiResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {} };
  const res: ApiResponse = {
    status(code) {
      captured.status = code;
      return res;
    },
    setHeader() {},
    json(body) {
      captured.body = body as Record<string, unknown>;
    },
    end() {},
  };
  return { res, captured };
}

async function registerShop(address: string, name: string): Promise<Merchant> {
  const id = merchantIdForAddress(address);
  if (id === null) throw new Error('bad test address');
  return getDeps().repo.upsertMerchant({ id, name, address, allowTreasuryRefund: false });
}

let sequence = 0;

async function seedOrder(merchant: Merchant, state: OrderState, createdAt: number): Promise<Order> {
  sequence += 1;
  const paid = state !== 'CREATED' && state !== 'PAYMENT_PENDING' && state !== 'EXPIRED';
  const id = `ord${String(sequence).padStart(13, '0')}`;
  return getDeps().repo.createOrder({
    id,
    state,
    merchantId: merchant.id,
    merchantAddress: merchant.address,
    itemLabel: `order ${sequence}`,
    amountLuna: 1_000,
    networkId: String(getDeps().config.networkId),
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + 15 * 60_000,
    paymentTxHash: paid ? sequence.toString(16).padStart(64, '0') : null,
    payerAddress: paid ? PAYER : null,
    paidAt: paid ? createdAt : null,
    paymentBlockNumber: paid ? 1 : null,
    claimedPaymentTxHash: null,
    refundSource: merchant.allowTreasuryRefund ? 'DEMO_TREASURY' : 'MERCHANT_WALLET',
    refunderAddress: merchant.address,
    lastError: null,
  });
}

/** Signs a `list` challenge with the shop's fake key, as the board does after one wallet dialog. */
async function signedBoardRead(merchant: Merchant): Promise<ApiRequest> {
  const deps = getDeps();
  const issued = await issueAndRecordMerchantChallenge(deps, {
    merchant,
    action: 'list',
    orderId: LIST_ORDER_SENTINEL,
    nowMs: deps.clock.nowMs(),
  });
  if (!issued.ok) throw new Error('challenge not issued');
  const verifier = getFakeSignatureVerifier();
  if (!verifier) throw new Error('fake verifier missing');
  const key = verifier.register(fakeKeyFor(merchant.address));
  return {
    method: 'GET',
    query: {},
    headers: {
      'x-rewind-merchant-challenge': Buffer.from(issued.issued.message, 'utf8').toString('base64'),
      'x-rewind-merchant-publickey': key.publicKey,
      'x-rewind-merchant-signature': fakeSign(key, issued.issued.message),
    },
  };
}

beforeEach(() => {
  resetDeps();
  resetRateLimits();
});

afterEach(() => {
  resetDeps();
});

describe('POST /api/merchant/refunds', () => {
  it('refuses the removed record-tx action: a shop refund is found on chain, never reported', async () => {
    const shop = await registerShop(SHOP_ADDRESS, 'Corner Coffee');
    const order = await seedOrder(shop, 'REFUND_APPROVED', Date.now() - 60_000);

    const { res, captured } = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        query: {},
        body: { orderId: order.id, action: 'record-tx', txHash: 'e'.repeat(64) },
      },
      res,
    );

    expect(captured.status).toBe(400);
    expect((await getDeps().repo.getOrder(order.id))?.state).toBe('REFUND_APPROVED');
  });
});

describe('GET /api/merchant/refunds', () => {
  it("still shows a shop's waiting refund request after 60 newer Demo Store orders", async () => {
    const shop = await registerShop(SHOP_ADDRESS, 'Corner Coffee');
    const demo = await getDeps().repo.getMerchant(DEMO_MERCHANT_ID);
    if (!demo) throw new Error('demo store missing');

    const start = Date.now() - 3_600_000;
    const waiting = await seedOrder(shop, 'REFUND_REQUESTED', start);
    await seedOrder(shop, 'PAID', start + 1);
    for (let i = 0; i < 60; i += 1) await seedOrder(demo, 'REFUND_REQUESTED', start + 10 + i);

    const { res, captured } = makeRes();
    await handler(await signedBoardRead(shop), res);

    expect(captured.status).toBe(200);
    const rows = (captured.body as { requests: Array<{ order: { id: string; merchantId: string } }> })
      .requests;
    expect(rows.map((r) => r.order.id)).toEqual([waiting.id]);
    expect(captured.body.scopedToMerchantId).toBe(shop.id);
  });

  it("never lists another shop's orders", async () => {
    const shop = await registerShop(SHOP_ADDRESS, 'Corner Coffee');
    const other = await registerShop(OTHER_SHOP_ADDRESS, 'Other Shop');
    const start = Date.now() - 60_000;
    await seedOrder(other, 'REFUND_REQUESTED', start);

    const { res, captured } = makeRes();
    await handler(await signedBoardRead(shop), res);

    expect(captured.status).toBe(200);
    expect((captured.body as { requests: unknown[] }).requests).toHaveLength(0);
  });

  it('refuses a read that carries no wallet signature, even in the developer loop', async () => {
    const shop = await registerShop(SHOP_ADDRESS, 'Corner Coffee');
    await seedOrder(shop, 'REFUND_REQUESTED', Date.now() - 60_000);

    const { res, captured } = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);

    expect(captured.status).toBe(400);
    expect(captured.body).not.toHaveProperty('requests');
  });

  it("refuses a sign-in signed by a wallet that is not the shop's", async () => {
    const shop = await registerShop(SHOP_ADDRESS, 'Corner Coffee');
    const request = await signedBoardRead(shop);
    const verifier = getFakeSignatureVerifier();
    const intruder = verifier!.register(fakeKeyFor(PAYER));
    const message = Buffer.from(String(request.headers['x-rewind-merchant-challenge']), 'base64').toString('utf8');

    const { res, captured } = makeRes();
    await handler(
      {
        ...request,
        headers: {
          ...request.headers,
          'x-rewind-merchant-publickey': intruder.publicKey,
          'x-rewind-merchant-signature': fakeSign(intruder, message),
        },
      },
      res,
    );

    expect(captured.status).toBe(400);
    expect(String((captured.body as { error: { detail?: string } }).error.detail)).toContain(
      'not_the_merchant_wallet',
    );
  });
});
