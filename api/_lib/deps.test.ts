import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('wiring', () => {
  it('refuses an unknown REWIND_CHAIN rather than falling back to the fake chain', async () => {
    // `lightclient` was the local testnet rehearsal mode, removed on 2026-09-15.
    vi.stubEnv('REWIND_CHAIN', 'lightclient');
    vi.resetModules();
    const { getDeps } = await import('./deps.js');
    expect(() => getDeps()).toThrow(/REWIND_CHAIN=lightclient is not supported/);
  });

  it('still builds the fake chain for local development by default', async () => {
    vi.stubEnv('REWIND_CHAIN', '');
    vi.resetModules();
    const { getDeps, getFakeChain, IS_FAKE_CHAIN } = await import('./deps.js');
    expect(IS_FAKE_CHAIN).toBe(true);
    expect(getDeps().config.networkId).toBe('24');
    expect(getFakeChain()).not.toBeNull();
  });
});
