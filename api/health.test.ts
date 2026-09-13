/**
 * Offline. Drives the real handler against the fake chain through the same wiring a request
 * would use, so what is exercised is the endpoint, not a copy of its logic.
 *
 * It does NOT prove anything about `getAccountByAddress` on a real node: that RPC method's
 * response shape has never been observed from this repository. See README-DEV.md, gap H1.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import handler from './health';
import { DEMO_MERCHANT, getDeps, getFakeChain, resetDeps } from './_lib/deps';
import { resetRateLimits } from './_lib/ratelimit';
import type { ApiRequest, ApiResponse } from './_lib/http';

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

const get = (): ApiRequest => ({ method: 'GET', headers: {}, query: {} });

beforeEach(() => {
  resetDeps();
  resetRateLimits();
});

afterEach(() => {
  resetDeps();
});

describe('GET /api/health', () => {
  it('reports the chain, the treasury and a floor, and is not paused with a funded treasury', async () => {
    const { res, captured } = makeRes();
    await handler(get(), res);

    expect(captured.status).toBe(200);
    const body = captured.body as {
      chain: { reachable: boolean; blockNumber: number | null; checkedAtMs: number | null };
      treasury: { address: string; balanceLuna: number | null; floorLuna: number };
      demoPaused: boolean;
    };
    expect(body.chain.reachable).toBe(true);
    expect(typeof body.chain.blockNumber).toBe('number');
    expect(typeof body.chain.checkedAtMs).toBe('number');
    expect(body.treasury.address).toBe(DEMO_MERCHANT.address);
    expect(body.treasury.balanceLuna).toBeGreaterThan(body.treasury.floorLuna);
    expect(body.demoPaused).toBe(false);
  });

  it('pauses the demo when the treasury is below the floor', async () => {
    getDeps(); // builds the fake chain
    const chain = getFakeChain();
    expect(chain).not.toBeNull();
    chain?.setBalance(DEMO_MERCHANT.address, 10);

    const { res, captured } = makeRes();
    await handler(get(), res);

    expect(captured.body.demoPaused).toBe(true);
    expect(String(captured.body.demoPausedReason)).toContain('below its floor');
  });

  it('refuses anything but GET', async () => {
    const { res, captured } = makeRes();
    await handler({ ...get(), method: 'POST' }, res);
    expect(captured.status).toBe(405);
  });
});
