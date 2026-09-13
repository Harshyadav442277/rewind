#!/usr/bin/env node
/**
 * A SCRIPTED BUYER for the testnet rehearsal. This is a script, not a test: it opens sockets,
 * spends (free) testnet NIM and depends on a dev server already running. `npm test` never runs
 * it and never will.
 *
 * It does on testnet exactly what a person with a phone does, against a dev server started by
 * `npm run rehearsal:testnet`:
 *
 *   1. GET  /api/health                       — which chain am I talking to
 *   2. POST /api/orders                       — create a Demo Store order
 *   3. build + sign + send a real testnet transaction to the merchant address, data
 *      `RW1:P:<orderId>`, through the light client (no JSON-RPC anywhere)
 *   4. POST /api/orders/:id/payment {}        — NO hash hint, so the server has to find the
 *                                               payment by scanning for the reference
 *   5. poll GET /api/orders/:id until PAID
 *   6. POST /api/orders/:id/refund-challenge  — get the exact text to sign
 *   7. sign it with the buyer key, the same scheme the real verifier checks:
 *        sha256("\x16Nimiq Signed Message:\n" + asciiDecimal(byteLength(msg)) + msg), Ed25519
 *   8. POST /api/orders/:id/refund            — the Demo Store auto-approves and the treasury
 *                                               broadcasts the refund
 *   9. poll until REFUNDED, then confirm both transactions against test-api.nimiq.watch, which
 *      is a third party and not the code under test
 *
 * The buyer key lives in `.env.buyer.local` (gitignored via `.env.*`), is generated on first
 * run, is funded from the public faucet, and is never printed.
 *
 * Usage: node scripts/rehearsal-buyer.mjs [--base http://localhost:5173]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Address,
  Client,
  ClientConfiguration,
  Hash,
  KeyPair,
  Policy,
  PrivateKey,
  TransactionBuilder,
} from '@nimiq/core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BUYER_ENV = resolve(root, '.env.buyer.local');

const FAUCET = 'https://faucet.pos.nimiq-testnet.com';
const EXPLORER_API = 'https://test-api.nimiq.watch/api/v1';
const EXPLORER = 'https://test.nimiq.watch/#';
const TESTNET_NETWORK_ID = 5;
/** Source of truth: server/chain/light-client-chain-reader.ts. Port 8443, not 443. */
const TESTNET_SEEDS = [
  '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
];
const SIGN_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n';

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE = baseIdx === -1 ? 'http://localhost:5173' : args[baseIdx + 1];

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

function buyerKey() {
  if (existsSync(BUYER_ENV)) {
    const line = readFileSync(BUYER_ENV, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith('REWIND_BUYER_PRIVATE_KEY='));
    if (line) return KeyPair.derive(PrivateKey.fromHex(line.split('=').slice(1).join('=').trim()));
  }
  const pair = KeyPair.generate();
  writeFileSync(
    BUYER_ENV,
    `# Rewind rehearsal SCRIPTED BUYER — testnet burner, faucet funded, worth nothing.\n` +
      `# Never mainnet, never committed. Address: ${pair.toAddress().toUserFriendlyAddress()}\n` +
      `REWIND_BUYER_PRIVATE_KEY=${pair.privateKey.toHex()}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  return pair;
}

async function balanceLuna(address) {
  const res = await fetch(`${EXPLORER_API}/account/${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`test-api ${res.status}`);
  return (await res.json()).balance;
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { status: res.status, body, text };
}

function signChallenge(keyPair, message) {
  const body = enc.encode(message);
  const preimage = new Uint8Array(
    enc.encode(SIGN_MESSAGE_PREFIX).length + enc.encode(String(body.length)).length + body.length,
  );
  let o = 0;
  for (const part of [enc.encode(SIGN_MESSAGE_PREFIX), enc.encode(String(body.length)), body]) {
    preimage.set(part, o);
    o += part.length;
  }
  const digest = Hash.computeSha256(preimage);
  return {
    publicKey: keyPair.publicKey.toHex(),
    signature: keyPair.sign(digest).toHex(),
  };
}

/** Fee is 1 Luna per SIGNED byte, so the size is measured on a signed probe. */
function buildPayment(client, keyPair, recipient, valueLuna, data, validityStartHeight) {
  const build = (fee) => {
    const tx = TransactionBuilder.newBasicWithData(
      keyPair.toAddress(),
      Address.fromString(recipient),
      enc.encode(data),
      BigInt(valueLuna),
      fee,
      validityStartHeight,
      TESTNET_NETWORK_ID,
    );
    tx.sign(keyPair, undefined);
    return tx;
  };
  let size = build(0n).serializedSize;
  let fee = BigInt(size);
  for (let i = 0; i < 4; i++) {
    const next = build(fee).serializedSize;
    if (next === size) break;
    size = next;
    fee = BigInt(size);
  }
  const tx = build(fee);
  tx.verify(Policy.MAX_SUPPORTED_VERSION, TESTNET_NETWORK_ID);
  void client;
  return tx;
}

async function main() {
  console.log('=== Rewind scripted buyer, testnet ===');
  console.log(`server               ${BASE}`);

  const health = await api('/api/health');
  if (health.status !== 200) throw new Error(`GET /api/health -> ${health.status} ${health.text}`);
  const chain = health.body.chain;
  log(`health               mode=${chain.mode} network=${chain.network} networkId=${chain.networkId} block=${chain.blockNumber} reachable=${chain.reachable}`);
  log(`treasury             ${health.body.treasury.address} holds ${health.body.treasury.balanceLabel}, demoPaused=${health.body.demoPaused}`);
  if (chain.network !== 'testnet' || chain.mode !== 'lightclient') {
    throw new Error('server is not in testnet rehearsal mode; refusing to send anything');
  }

  const keyPair = buyerKey();
  const buyer = keyPair.toAddress().toUserFriendlyAddress();
  let buyerBalance = await balanceLuna(buyer);
  log(`buyer                ${buyer} holds ${buyerBalance} Luna`);
  if (buyerBalance < 100_000) {
    log('tapping the faucet for the buyer');
    const res = await fetch(`${FAUCET}/tapit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ address: buyer }).toString(),
    });
    log(`faucet               http ${res.status} ${await res.text()}`);
    const deadline = Date.now() + 120_000;
    while (buyerBalance < 100_000 && Date.now() < deadline) {
      await sleep(3_000);
      buyerBalance = await balanceLuna(buyer);
    }
    log(`buyer balance        ${buyerBalance} Luna`);
    if (buyerBalance < 100_000) throw new Error('faucet payout never arrived');
  }

  // --- 1. order -------------------------------------------------------------
  const created = await api('/api/orders', { method: 'POST', body: JSON.stringify({}) });
  if (created.status !== 201) throw new Error(`POST /api/orders -> ${created.status} ${created.text}`);
  const order = created.body.order;
  log(`order                ${order.id} ${order.amountLabel} to ${order.merchantAddress} (networkId ${order.networkId})`);
  log(`reference            ${order.paymentReference}`);

  // --- 2. pay, for real -----------------------------------------------------
  const config = new ClientConfiguration();
  config.network('TestAlbatross');
  config.seedNodes(TESTNET_SEEDS);
  config.logLevel('error');
  const bootStart = Date.now();
  const client = await Client.create(config.build());
  await client.waitForConsensusEstablished();
  const netId = await client.getNetworkId();
  if (netId !== TESTNET_NETWORK_ID) throw new Error(`client is on networkId ${netId}`);
  const head = await client.getHeadHeight();
  log(`buyer light client   consensus in ${Date.now() - bootStart} ms, networkId ${netId}, head ${head}`);

  const tx = buildPayment(
    client,
    keyPair,
    order.merchantAddress,
    order.amountLuna,
    order.paymentReference,
    head,
  );
  log(`payment tx           hash ${tx.hash()} fee ${tx.fee} size ${tx.serializedSize} validityStart ${head}`);
  const sendStart = Date.now();
  const sent = await client.sendTransaction(tx);
  log(`sendTransaction      returned in ${Date.now() - sendStart} ms state=${sent.state} block=${sent.blockHeight} executionResult=${sent.executionResult}`);
  log(`explorer             ${EXPLORER}${tx.hash()}`);

  // --- 3. tell the server, WITHOUT a hash hint ------------------------------
  const payment = await api(`/api/orders/${order.id}/payment`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  log(`POST payment         ${payment.status} status=${payment.body?.status ?? '-'} note=${payment.body?.note ?? '-'}`);

  const paid = await pollUntil(order.id, (s) => s.order.state === 'PAID', 'PAID', 180_000);
  log(`order PAID           payer ${paid.order.payerAddress} tx ${paid.order.paymentTxHash} block ${paid.order.paymentBlockNumber}`);
  log(`payment explorer     ${paid.order.paymentExplorerUrl}`);

  // --- 4. challenge and signature -------------------------------------------
  const challenge = await api(`/api/orders/${order.id}/refund-challenge`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (challenge.status !== 201) throw new Error(`challenge -> ${challenge.status} ${challenge.text}`);
  const message = challenge.body.challenge.message;
  log(`challenge            nonce ${challenge.body.challenge.nonce}, ${message.split('\n').length} lines`);
  const signed = signChallenge(keyPair, message);

  const refund = await api(`/api/orders/${order.id}/refund`, {
    method: 'POST',
    body: JSON.stringify({ message, ...signed }),
  });
  log(`POST refund          ${refund.status} autoApproved=${refund.body?.autoApproved} note=${refund.body?.note ?? refund.text.slice(0, 200)}`);

  const refunded = await pollUntil(order.id, (s) => s.order.state === 'REFUNDED', 'REFUNDED', 300_000);
  const execution = refunded.execution;
  log(`order REFUNDED       refund tx ${execution.refundTxHash} block ${execution.refundBlockNumber}`);
  log(`refund explorer      ${execution.refundExplorerUrl}`);

  // --- 5. third-party confirmation ------------------------------------------
  for (const [label, hash] of [
    ['payment', paid.order.paymentTxHash],
    ['refund', execution.refundTxHash],
  ]) {
    const res = await fetch(`${EXPLORER_API}/transaction/${hash}`);
    const body = await res.text();
    console.log(`third party ${label.padEnd(8)} ${res.status} ${body.slice(0, 400)}`);
  }

  const finalBalance = await balanceLuna(buyer);
  log(`buyer balance after  ${finalBalance} Luna`);
  console.log('');
  console.log('REHEARSAL: PASS');
  // The WASM worker keeps the event loop alive for ever; everything above is flushed.
  process.exit(0);
}

async function pollUntil(orderId, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let unavailable = 0;
  while (Date.now() < deadline) {
    const res = await api(`/api/orders/${orderId}`);
    if (res.status === 503) {
      // Expected: the light client throws "Transaction not found" about transactions that
      // exist, so the adapter reports "we do not know" until a peer serves the proof.
      unavailable += 1;
      await sleep(3_000);
      continue;
    }
    if (res.status !== 200) throw new Error(`GET order -> ${res.status} ${res.text}`);
    last = res.body;
    if (predicate(last)) {
      if (unavailable > 0) log(`(${unavailable} x 503 chain-unavailable while waiting for ${label})`);
      return last;
    }
    process.stdout.write(`  [${stamp()}] waiting for ${label}: ${last.order.state}${last.note ? ` — ${last.note}` : ''}\n`);
    await sleep(3_000);
  }
  throw new Error(`timed out waiting for ${label}; last state ${last?.order?.state}`);
}

await main();
