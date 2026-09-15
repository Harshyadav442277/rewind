/**
 * Offline. `POST /api/orders` creates an order; there is no way to list them. A list would give
 * anyone the payer addresses and order ids of strangers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import handler from '../orders.js';
import { getDeps, resetDeps } from '../_lib/deps.js';
import { resetRateLimits } from '../_lib/ratelimit.js';
import type { ApiResponse } from '../_lib/http.js';

interface Captured {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function makeRes(): { res: ApiResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {}, headers: {} };
  const res: ApiResponse = {
    status(code) {
      captured.status = code;
      return res;
    },
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = value;
    },
    json(body) {
      captured.body = body as Record<string, unknown>;
    },
    end() {},
  };
  return { res, captured };
}

beforeEach(() => {
  resetDeps();
  resetRateLimits();
});

afterEach(() => {
  resetDeps();
});

describe('/api/orders', () => {
  it('creates a Demo Store order on POST', async () => {
    const { res, captured } = makeRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: {} }, res);

    expect(captured.status).toBe(201);
    const order = (captured.body as { order: { id: string; amountLuna: number; merchantId: string } }).order;
    expect(order.merchantId).toBe('demo-store');
    expect(order.amountLuna).toBe(1_000);
  });

  it('refuses GET, so orders and payer addresses cannot be listed', async () => {
    const created = makeRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: {} }, created.res);
    const id = (created.captured.body as { order: { id: string } }).order.id;
    expect(await getDeps().repo.getOrder(id)).not.toBeNull();

    const { res, captured } = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);

    expect(captured.status).toBe(405);
    expect(captured.headers.allow).toBe('POST');
    expect(JSON.stringify(captured.body)).not.toContain(id);
    expect(captured.body).not.toHaveProperty('orders');
  });
});
