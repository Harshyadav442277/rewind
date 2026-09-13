/**
 * Dev helper: produce a payload.sample.json shaped exactly like the phone page's POST body,
 * signed with a throwaway keypair under the canonical Nimiq signed-message scheme.
 * Lets the server and the page be exercised end-to-end with no phone involved.
 * Run: node mkpayload.mjs
 */
import { KeyPair } from '@nimiq/core';
import { buildVariants } from './verify.mjs';
import { writeFileSync } from 'node:fs';

const kp = KeyPair.generate();
const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const message = `REWIND_SPIKE_V1 nonce=${nonce} ts=${new Date().toISOString()}`;
const v = buildVariants(message).find((x) => x.name === 'nimiq-prefixed-sha256');

writeFileSync('payload.sample.json', JSON.stringify({
  message,
  accounts: [kp.toAddress().toUserFriendlyAddress()],
  publicKey: kp.publicKey.toHex(),
  signature: kp.sign(v.data).toHex(),
}, null, 2));
console.log('wrote payload.sample.json for', kp.toAddress().toUserFriendlyAddress());
