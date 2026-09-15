/**
 * Vercel turns every file under `api/` into a public serverless function unless a path segment
 * starts with an underscore. Before 2026-09-15 `api/health.test.ts` was deployed as the function
 * `api/health.test`, and new test files would have pushed the deployment past twelve functions.
 * This pins the deployed surface to the route handlers.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..');

function deployedFunctionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...deployedFunctionFiles(full));
    else if (name.endsWith('.ts')) out.push(relative(API_ROOT, full).split(sep).join('/'));
  }
  return out.sort();
}

describe('deployed API surface', () => {
  it('is exactly the route handlers: no tests, no development endpoints', () => {
    expect(deployedFunctionFiles(API_ROOT)).toEqual([
      'health.ts',
      'merchant/challenge.ts',
      'merchant/refunds.ts',
      'merchant/register.ts',
      'merchants/[id].ts',
      'orders.ts',
      'orders/[id].ts',
      'orders/[id]/payment.ts',
      'orders/[id]/refund-challenge.ts',
      'orders/[id]/refund.ts',
    ]);
  });
});
