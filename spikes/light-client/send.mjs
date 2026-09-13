#!/usr/bin/env node
// Rewind spike — light-client. Builds, signs and BROADCASTS a Nimiq TESTNET basic-with-data
// transaction through the light client's own `sendTransaction`, with no JSON-RPC server
// anywhere in the path, then polls until the network reports it included.
//
// Usage:
//   node send.mjs [--to NQ..] [--luna 100000] [--data "rewind:lc:<ts>"] [--timeout 180]
//
// Defaults: sends 1 NIM back to the public testnet faucet with data "rewind:lc:<unix ms>".
// TESTNET ONLY — networkId is hard-coded to 5 and the script refuses any other network.
// Never prints the private key.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Client,
  ClientConfiguration,
  KeyPair,
  PrivateKey,
  Address,
  Transaction,
  TransactionBuilder,
  Policy,
} from '@nimiq/core';

const here = dirname(fileURLToPath(import.meta.url));
const T0 = performance.now();

// Nimiq Albatross TESTNET.
const NETWORK_ID_TESTNET = 5;
const NETWORK_NAME = 'TestAlbatross';
const MAX_DATA_BYTES = 64;

// See sync.mjs for why these must be passed explicitly: the WASM default seed list is
// mainnet-only, and config.network('TestAlbatross') does not replace it.
const TESTNET_SEEDS = [
  '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
  '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
];

// The public testnet faucet. Sending the NIM straight back to it is the tidiest recipient
// available and is guaranteed to be a live, valid testnet address.
const DEFAULT_TO = 'NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ';

function parseArgs(argv) {
  const out = { luna: 100000n, timeout: 180, feePerByte: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--to': out.to = next(); break;
      case '--luna': out.luna = BigInt(next()); break;
      case '--data': out.data = next(); break;
      case '--timeout': out.timeout = Number(next()); break;
      case '--fee-per-byte': out.feePerByte = Number(next()); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

function loadPrivateKeyHex() {
  const envPath = resolve(here, '.env.local');
  if (!existsSync(envPath)) {
    throw new Error(`${envPath} does not exist. Run "node gen-key.mjs" then "node faucet.mjs".`);
  }
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('REWIND_TESTNET_PRIVATE_KEY='));
  if (!line) throw new Error(`REWIND_TESTNET_PRIVATE_KEY not found in ${envPath}`);
  return line.split('=').slice(1).join('=').trim();
}

const ms = (n) => `${n.toFixed(0)} ms`;

// The fee is a fixed-width u64 so its value does not change the serialised size, but the
// signature proof does (~98 bytes). Size must be measured on the SIGNED transaction, so this
// re-measures until it converges. Same approach as spikes/server-tx/build-tx.mjs.
function buildSigned(args, keyPair) {
  const tx = TransactionBuilder.newBasicWithData(
    args.sender,
    args.recipient,
    args.dataBytes,
    args.value,
    args.fee,
    args.validityStartHeight,
    NETWORK_ID_TESTNET,
  );
  tx.sign(keyPair, undefined);
  return tx;
}

function chooseFee(opts, args, keyPair) {
  let size = buildSigned({ ...args, fee: 0n }, keyPair).serializedSize;
  for (let i = 0; i < 4; i++) {
    const fee = BigInt(Math.ceil(size * opts.feePerByte));
    const next = buildSigned({ ...args, fee }, keyPair);
    if (next.serializedSize === size) return fee;
    size = next.serializedSize;
  }
  throw new Error('fee/size did not converge');
}

function printDetails(t, indent = '  ') {
  const dataRaw = t.data?.raw ?? '';
  console.log(`${indent}transactionHash    ${t.transactionHash}`);
  console.log(`${indent}state              ${t.state}`);
  console.log(`${indent}executionResult    ${t.executionResult}`);
  console.log(`${indent}blockHeight        ${t.blockHeight}`);
  console.log(`${indent}confirmations      ${t.confirmations}`);
  console.log(`${indent}timestamp          ${t.timestamp} (${t.timestamp ? new Date(t.timestamp).toISOString() : '-'})`);
  console.log(`${indent}format             ${t.format}`);
  console.log(`${indent}sender             ${t.sender}`);
  console.log(`${indent}recipient          ${t.recipient}`);
  console.log(`${indent}value              ${t.value} Luna = ${(t.value / 1e5).toFixed(5)} NIM`);
  console.log(`${indent}fee                ${t.fee} Luna`);
  console.log(`${indent}network            ${t.network}`);
  console.log(`${indent}size               ${t.size} bytes`);
  console.log(`${indent}data (hex)         ${dataRaw || '(empty)'}`);
  console.log(`${indent}data (utf8)        ${JSON.stringify(dataRaw ? Buffer.from(dataRaw, 'hex').toString('utf8') : '')}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataStr = opts.data ?? `rewind:lc:${Date.now()}`;
  const dataBytes = new TextEncoder().encode(dataStr);
  if (dataBytes.length > MAX_DATA_BYTES) {
    throw new Error(`--data is ${dataBytes.length} UTF-8 bytes; the limit is ${MAX_DATA_BYTES}`);
  }

  const keyPair = KeyPair.derive(PrivateKey.fromHex(loadPrivateKeyHex()));
  const sender = keyPair.toAddress();
  const recipient = Address.fromString(opts.to ?? DEFAULT_TO);
  if (sender.equals(recipient)) throw new Error('sender and recipient are the same address');
  if (opts.luna <= 0n) throw new Error('--luna must be greater than 0');

  console.log('=== rewind spike — light-client send (TESTNET) ===');
  console.log(`started at           ${new Date().toISOString()}`);
  console.log(`sender               ${sender.toUserFriendlyAddress()}`);
  console.log(`recipient            ${recipient.toUserFriendlyAddress()}`);
  console.log('');

  // ----------------------------------------------------------- client + consensus
  const config = new ClientConfiguration();
  config.network(NETWORK_NAME);
  config.seedNodes(TESTNET_SEEDS);
  config.logLevel('warn');
  const tCreate = performance.now();
  const client = await Client.create(config.build());
  await client.waitForConsensusEstablished();
  const tConsensus = performance.now();
  console.log(`consensus            established in ${ms(tConsensus - tCreate)} after Client.create()`);

  const netId = await client.getNetworkId();
  if (netId !== NETWORK_ID_TESTNET) {
    throw new Error(`REFUSING TO SEND: client reports networkId ${netId}, expected ${NETWORK_ID_TESTNET} (testnet)`);
  }
  const height = await client.getHeadHeight();
  console.log(`networkId            ${netId} (testnet, verified before signing)`);
  console.log(`head height          ${height}`);

  const accBefore = await client.getAccount(sender);
  console.log(`sender balance       ${accBefore.balance} Luna = ${(accBefore.balance / 1e5).toFixed(5)} NIM`);
  if (BigInt(accBefore.balance) <= opts.luna) {
    throw new Error(`sender balance ${accBefore.balance} Luna does not cover ${opts.luna} Luna + fee. Run "node faucet.mjs".`);
  }

  // ----------------------------------------------------------- build + sign
  const args = { sender, recipient, dataBytes, value: opts.luna, validityStartHeight: height };
  const fee = chooseFee(opts, args, keyPair);
  const tx = buildSigned({ ...args, fee }, keyPair);

  // Local consensus-rule gate before anything touches the network.
  tx.verify(Policy.MAX_SUPPORTED_VERSION, NETWORK_ID_TESTNET);

  const localHash = tx.hash();
  const hex = tx.toHex();
  const explorer = `https://test.nimiq.watch/#${localHash}`;

  console.log('');
  console.log(`value                ${opts.luna} Luna = ${(Number(opts.luna) / 1e5).toFixed(5)} NIM`);
  console.log(`fee                  ${fee} Luna (${opts.feePerByte} Luna/byte, feePerByte ${tx.feePerByte})`);
  console.log(`data (utf8)          ${JSON.stringify(dataStr)}`);
  console.log(`data (hex)           ${Buffer.from(tx.data).toString('hex')}`);
  console.log(`data bytes           ${dataBytes.length} / ${MAX_DATA_BYTES}`);
  console.log(`format               ${tx.toPlain().format}`);
  console.log(`validityStartHeight  ${height} (valid through ${height + Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS})`);
  console.log(`serializedSize       ${tx.serializedSize} bytes`);
  console.log(`local verify()       PASS (protocol_version ${Policy.MAX_SUPPORTED_VERSION}, networkId ${NETWORK_ID_TESTNET})`);
  console.log(`local tx hash        ${localHash}`);
  console.log(`raw hex              ${hex}`);
  console.log(`explorer             ${explorer}`);

  // Sanity: the bytes deserialise back to the same transaction.
  const rt = Transaction.fromAny(hex);
  console.log(`round-trip hash      ${rt.hash()} (${rt.hash() === localHash ? 'MATCH' : 'MISMATCH'})`);

  // ----------------------------------------------------------- broadcast
  console.log('');
  console.log('--- client.sendTransaction(tx) — light client broadcast, NO JSON-RPC ---');
  const tSend = performance.now();
  const sent = await client.sendTransaction(tx);
  const tSendDone = performance.now();
  console.log(`sendTransaction()    returned in ${ms(tSendDone - tSend)}`);
  console.log(`returned hash        ${sent.transactionHash} (${sent.transactionHash === localHash ? 'MATCHES local' : 'DIFFERS from local ' + localHash})`);
  console.log(`returned state       ${sent.state}`);
  printDetails(sent, '  ');

  // ----------------------------------------------------------- poll for inclusion
  console.log('');
  console.log('--- polling client.getTransaction(hash) until included ---');
  const deadline = Date.now() + opts.timeout * 1000;
  let final = null;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    polls++;
    try {
      const d = await client.getTransaction(localHash);
      console.log(`  poll ${String(polls).padStart(2)}  +${ms(performance.now() - tSendDone)}  state=${d.state} blockHeight=${d.blockHeight ?? '-'}`);
      if (d.state === 'included' || d.state === 'confirmed') {
        final = d;
        break;
      }
      if (d.state === 'invalidated' || d.state === 'expired') {
        final = d;
        break;
      }
    } catch (e) {
      console.log(`  poll ${String(polls).padStart(2)}  +${ms(performance.now() - tSendDone)}  not yet: ${e?.message ?? e}`);
    }
  }

  console.log('');
  if (!final) {
    console.log(`NOT INCLUDED within ${opts.timeout}s. Still valid until block ${height + Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS}.`);
    console.log(`Check ${explorer}`);
    process.exitCode = 1;
  } else {
    const inclusionMs = performance.now() - tSendDone;
    console.log('--- INCLUDED ---');
    console.log(`observed at          ${new Date().toISOString()}`);
    console.log(`time to inclusion    ${ms(inclusionMs)} after sendTransaction() returned`);
    printDetails(final, '  ');
    const dataBack = final.data?.raw ? Buffer.from(final.data.raw, 'hex').toString('utf8') : '';
    console.log(`  data round-trips   ${dataBack === dataStr ? 'YES' : `NO (got ${JSON.stringify(dataBack)})`}`);
    console.log(`  explorer           ${explorer}`);
    const pass =
      final.executionResult === true &&
      dataBack === dataStr &&
      final.transactionHash === localHash;
    console.log('');
    console.log(`SEND GATE: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exitCode = 1;
  }

  const accAfter = await client.getAccount(sender);
  console.log('');
  console.log(`sender balance after ${accAfter.balance} Luna = ${(accAfter.balance / 1e5).toFixed(5)} NIM`);
  console.log(`  delta              ${accAfter.balance - accBefore.balance} Luna (expected -${opts.luna + fee})`);
  console.log(`total wall clock     ${ms(performance.now() - T0)}`);

  await client.disconnectNetwork().catch(() => {});
}

try {
  await main();
} catch (e) {
  console.error(`ERROR: ${e?.stack ?? e}`);
  process.exitCode = 1;
}
// The WASM worker thread keeps the event loop alive forever; everything is already flushed.
process.exit(process.exitCode ?? 0);
