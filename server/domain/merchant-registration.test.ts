import { describe, expect, it } from 'vitest';
import { fakeKeyFor, fakeSign } from './fakes.js';
import {
  buildRegistrationMessage,
  merchantIdForAddress,
  parseRegistrationMessage,
  registerMerchant,
} from './merchant-registration.js';
import { OTHER, PAYER, makeHarness, type Harness } from './test-helpers.js';

function signed(h: Harness, signer: string, name: string, issuedAtSec = Math.floor(h.clock.nowMs() / 1000)) {
  const message = buildRegistrationMessage({ name, issuedAtSec });
  const key = h.verifier.register(fakeKeyFor(signer));
  return { message, publicKey: key.publicKey, signature: fakeSign(key, message) };
}

describe('merchant registration', () => {
  it('creates a merchant whose address is the signer and whose id comes from that address', async () => {
    const h = makeHarness();
    const result = await registerMerchant(h.deps, signed(h, PAYER, 'Corner Café'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.merchant.address).toBe(PAYER);
    expect(result.merchant.id).toBe(merchantIdForAddress(PAYER));
    expect(result.merchant.allowTreasuryRefund).toBe(false);
    expect(await h.repo.getMerchant(result.merchant.id)).toMatchObject({ name: 'Corner Café', address: PAYER });
  });

  it('renames on a second registration from the same wallet, and a different wallet is a different merchant', async () => {
    const h = makeHarness();
    await registerMerchant(h.deps, signed(h, PAYER, 'First name'));
    const renamed = await registerMerchant(h.deps, signed(h, PAYER, 'Second name'));
    const other = await registerMerchant(h.deps, signed(h, OTHER, 'Second name'));
    expect(renamed.ok && other.ok).toBe(true);
    if (!renamed.ok || !other.ok) return;
    expect(renamed.merchant).toMatchObject({ name: 'Second name', address: PAYER });
    expect(other.merchant.id).not.toBe(renamed.merchant.id);
    expect(other.merchant.address).toBe(OTHER);
  });

  it('refuses a stale signature, a tampered text and a bad name', async () => {
    const h = makeHarness();
    const nowSec = Math.floor(h.clock.nowMs() / 1000);

    const stale = await registerMerchant(h.deps, signed(h, PAYER, 'Shop', nowSec - 301));
    expect(stale.ok ? null : stale.reason).toBe('stale');

    const good = signed(h, PAYER, 'Shop');
    const tampered = await registerMerchant(h.deps, { ...good, message: good.message.replace('Shop', 'Shoq') });
    expect(tampered.ok ? null : tampered.reason).toBe('bad_signature');

    for (const name of ['', ' padded ', 'x'.repeat(41), 'two\nlines']) {
      expect(parseRegistrationMessage(buildRegistrationMessage({ name, issuedAtSec: nowSec })).ok).toBe(false);
    }
  });

  it('never registers the demo store id', () => {
    expect(merchantIdForAddress(PAYER)).toMatch(/^w-nq64/);
    expect(merchantIdForAddress('not an address')).toBeNull();
  });
});
