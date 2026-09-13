/**
 * Rewind spike — selftest for gate N11 tooling.
 *
 * Proves the verifier without a phone: generate a keypair with @nimiq/core, sign the
 * challenge under EVERY variant verify.mjs knows about, and confirm verify.mjs names
 * the right one each time and derives the right address. Then a negative test, then a
 * live cross-check of the same canonical signature against the public JSON-RPC node.
 *
 * Run: node selftest.mjs            (add --no-rpc to skip the network cross-check)
 */

import { KeyPair, Signature } from '@nimiq/core';
import { buildVariants, verifySigned, rpcVerifySignature, bytesToHex } from './verify.mjs';

const RPC_URL = 'https://rpc.nimiqwatch.com';
const skipRpc = process.argv.includes('--no-rpc');

function challenge() {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  return `REWIND_SPIKE_V1 nonce=${nonce} ts=${new Date().toISOString()}`;
}

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('=== Rewind spike selftest: sign/verify variant identification ===');
console.log(`node ${process.version}  platform ${process.platform}  ${new Date().toISOString()}`);

const kp = KeyPair.generate();
const pubHex = kp.publicKey.toHex();
const address = kp.toAddress().toUserFriendlyAddress();
console.log(`\ngenerated keypair -> address ${address}`);
console.log(`public key ${pubHex}`);
console.log('(private key intentionally never printed)\n');

const message = challenge();
console.log(`challenge: ${message}`);
console.log(`challenge byte length: ${new TextEncoder().encode(message).length}\n`);

// --- 1. every variant round-trips and is identified by name -------------------
const variants = buildVariants(message);
console.log(`--- ${variants.length} variants under test ---`);
for (const v of variants) {
  const sig = kp.sign(v.data);
  const report = await verifySigned({
    message,
    publicKey: pubHex,
    signature: sig.toHex(),
    accounts: [address],
  });
  const identified = report.matchedVariant === v.name;
  const single = report.variants.filter((x) => x.verified).length === 1;
  ok(
    identified && single && report.derivedAddress === address && report.gateN11.pass,
    `variant "${v.name}"`,
    `-> matched=${report.matchedVariant} verifiedCount=${report.variants.filter((x) => x.verified).length} addrMatch=${report.addressMatchesAccount}`,
  );
}

// --- 2. negative: tampered message must not verify under any variant ----------
console.log('\n--- negative tests ---');
{
  const canonical = variants.find((v) => v.name === 'nimiq-prefixed-sha256');
  const sig = kp.sign(canonical.data);
  const bad = await verifySigned({
    message: message.replace('REWIND_SPIKE_V1', 'REWIND_SPIKE_V2'),
    publicKey: pubHex,
    signature: sig.toHex(),
    accounts: [address],
  });
  ok(bad.ok === false && bad.matchedVariant === null, 'tampered message verifies under no variant', `ok=${bad.ok}`);
}
{
  const canonical = variants.find((v) => v.name === 'nimiq-prefixed-sha256');
  const sig = kp.sign(canonical.data);
  const otherKp = KeyPair.generate();
  const bad = await verifySigned({
    message,
    publicKey: otherKp.publicKey.toHex(),
    signature: sig.toHex(),
    accounts: [address],
  });
  ok(bad.ok === false, 'wrong public key verifies under no variant', `ok=${bad.ok}`);
}
{
  const canonical = variants.find((v) => v.name === 'nimiq-prefixed-sha256');
  const sig = kp.sign(canonical.data);
  const wrongAccount = await verifySigned({
    message,
    publicKey: pubHex,
    signature: sig.toHex(),
    accounts: ['NQ07 0000 0000 0000 0000 0000 0000 0000 0000'],
  });
  ok(
    wrongAccount.ok === true && wrongAccount.addressMatchesAccount === false && wrongAccount.gateN11.pass === false,
    'valid signature but foreign account fails gate N11',
    `ok=${wrongAccount.ok} addrMatch=${wrongAccount.addressMatchesAccount} gate=${wrongAccount.gateN11.pass}`,
  );
}
{
  const garbage = await verifySigned({ message, publicKey: 'zz', signature: 'zz', accounts: [address] });
  ok(garbage.ok === false && garbage.errors.length > 0, 'malformed hex is rejected cleanly', garbage.errors[0] ?? '');
}

// --- 3. address derivation matches the keypair --------------------------------
console.log('\n--- address derivation ---');
{
  const canonical = variants.find((v) => v.name === 'nimiq-prefixed-sha256');
  const sig = kp.sign(canonical.data);
  const r = await verifySigned({ message, publicKey: pubHex, signature: sig.toHex(), accounts: [address] });
  ok(r.derivedAddress === address, 'PublicKey.toAddress().toUserFriendlyAddress() == KeyPair address', r.derivedAddress);
  ok(/^NQ\d{2}( [A-Z0-9]{4}){8}$/.test(r.derivedAddress), 'derived address is user-friendly IBAN form', r.derivedAddress);
}

// --- 4. signature/round-trip sanity on hex parsing ----------------------------
{
  const canonical = variants.find((v) => v.name === 'nimiq-prefixed-sha256');
  const sig = kp.sign(canonical.data);
  ok(Signature.fromHex(sig.toHex()).toHex() === sig.toHex(), 'Signature hex round-trips');
  ok(sig.toHex().length === 128, 'signature is 64 bytes', `${sig.toHex().length} hex chars`);
  ok(pubHex.length === 64, 'public key is 32 bytes', `${pubHex.length} hex chars`);
}

// --- 5. live cross-check: does the public node agree with our canonical variant?
console.log('\n--- live RPC cross-check (nimiqwatch, read-only) ---');
if (skipRpc) {
  console.log('SKIP  --no-rpc given');
} else {
  const canonical = variants.find((v) => v.name === 'nimiq-prefixed-sha256');
  const goodSig = kp.sign(canonical.data).toHex();
  const good = await rpcVerifySignature({ rpcUrl: RPC_URL, message, publicKey: pubHex, signature: goodSig });
  console.log(`  request : verifySignature ["<challenge>", "<pubkey>", "<sig>", false]`);
  console.log(`  response: ${JSON.stringify(good.raw)}`);
  ok(good.ok === true, 'RPC verifySignature accepts a nimiq-prefixed-sha256 signature', `ok=${good.ok} error=${good.error}`);

  const rawSig = kp.sign(new TextEncoder().encode(message)).toHex();
  const bad = await rpcVerifySignature({ rpcUrl: RPC_URL, message, publicKey: pubHex, signature: rawSig });
  console.log(`  response (raw-utf8 signature): ${JSON.stringify(bad.raw)}`);
  ok(bad.ok === false, 'RPC verifySignature rejects a raw-utf8 signature (confirms the prefix scheme)', `ok=${bad.ok}`);
}

// Close undici's keep-alive sockets before teardown. Without this, Node 24 on Windows
// aborts at exit (exit code 127) with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
// once the @nimiq/core WASM worker and a live fetch() connection are torn down together.
// The assertion happens strictly after all output; results are unaffected. See README.
try { await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close(); } catch { /* best effort */ }

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
