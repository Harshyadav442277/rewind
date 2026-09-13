#!/usr/bin/env node
// Rewind spike N12 — build, sign, serialise (and optionally broadcast) a Nimiq mainnet
// basic-with-data transaction using @nimiq/core 2.21.0 in plain Node ESM.
//
// Usage:
//   node build-tx.mjs --to <NQ.. address> --luna <n> --data "<utf8, <=64 bytes>" [options]
//
// Options:
//   --dry-run           default. Builds, signs, serialises, verifies and round-trips. No write RPC.
//   --broadcast         ALSO calls sendRawTransaction, then polls getTransactionByHash.
//   --fee-per-byte <n>  Luna per SIGNED serialised byte. Default 1.
//   --fee <n>           Absolute fee in Luna. Overrides --fee-per-byte.
//   --key <hex>         Use this private key instead of .env.local (never logged).
//   --ephemeral         Generate a throwaway in-memory key. Nothing is persisted. Dry-run only.
//   --env <path>        Path to the env file. Default ./.env.local
//   --rpc <url>         Default https://rpc.nimiqwatch.com
//   --timeout <s>       Confirmation poll budget. Default 90.
//
// Never prints a private key.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  KeyPair,
  PrivateKey,
  Address,
  Transaction,
  TransactionBuilder,
  Policy,
} from '@nimiq/core';
import {
  DEFAULT_RPC,
  getBlockNumber,
  getMinFeePerByte,
  getTransactionByHash,
  sendRawTransaction,
  isNotFound,
} from './rpc.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Nimiq Albatross mainnet. Confirmed two ways on 2026-09-13:
//   - TransactionBuilder with network_id 24 yields toPlain().network === "mainalbatross";
//     23 and 25 throw "Unknown network ID".
//   - A real mainnet transaction fetched from rpc.nimiqwatch.com reports "networkId": 24.
const NETWORK_ID_MAINNET = 24;
const MAX_DATA_BYTES = 64;

// Never call process.exit() in this script. On Windows + Node 24.19.0, tearing the process down
// while @nimiq/core's WASM objects are live aborts with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
// and exit code 127, which hides the real result. Reproduced deterministically 2026-09-13.
// Set process.exitCode and let the event loop drain instead.
class Halt extends Error {}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exitCode = 2;
  throw new Halt(msg);
}

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const out = { dryRun: true, feePerByte: 1, timeout: 90, rpc: DEFAULT_RPC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--to': out.to = next(); break;
      case '--luna': out.luna = next(); break;
      case '--data': out.data = next(); break;
      case '--fee': out.fee = next(); break;
      case '--fee-per-byte': out.feePerByte = Number(next()); break;
      case '--key': out.key = next(); break;
      case '--env': out.env = next(); break;
      case '--rpc': out.rpc = next(); break;
      case '--timeout': out.timeout = Number(next()); break;
      case '--ephemeral': out.ephemeral = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--broadcast': out.dryRun = false; break;
      default: fail(`unknown argument ${a}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- key loading

function loadPrivateKeyHex(opts) {
  if (opts.key) return opts.key.trim();
  const envPath = resolve(opts.env ? opts.env : resolve(here, '.env.local'));
  if (!existsSync(envPath)) {
    fail(`no key. ${envPath} does not exist. Run "node gen-key.mjs" first, or pass --ephemeral.`);
  }
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('REWIND_TREASURY_PRIVATE_KEY='));
  if (!line) fail(`REWIND_TREASURY_PRIVATE_KEY not found in ${envPath}`);
  return line.split('=').slice(1).join('=').trim();
}

// ---------------------------------------------------------------- fee model
//
// getMinFeePerByte on rpc.nimiqwatch.com returned 0 on 2026-09-12 and again on 2026-09-13, and
// zero-fee transactions are demonstrably being included on mainnet right now. A zero fee is
// therefore usually enough — but that is mempool policy, not a consensus rule, and it can change
// under load without notice. The default here is 1 Luna per SIGNED serialised byte: for the
// 230-byte worst case (a full 64-byte data field) that is 230 Luna = 0.0023 NIM, free in practice,
// while placing the transaction strictly above every zero-fee transaction in a fee-ordered mempool.
//
// The fee is a fixed-width u64, so its value does not change the serialised size — but the
// signature proof does (~98 bytes), so the size must be measured on the SIGNED transaction.
// Sizing before signing under-pays by roughly half. The loop below re-measures and converges.

function buildSigned(args, keyPair) {
  const tx = TransactionBuilder.newBasicWithData(
    args.sender,
    args.recipient,
    args.dataBytes,
    args.value,
    args.fee,
    args.validityStartHeight,
    NETWORK_ID_MAINNET,
  );
  if (keyPair) tx.sign(keyPair, undefined);
  return tx;
}

function chooseFee(opts, args, keyPair) {
  if (opts.fee !== undefined) return BigInt(opts.fee);
  let size = buildSigned({ ...args, fee: 0n }, keyPair).serializedSize;
  for (let i = 0; i < 4; i++) {
    const fee = BigInt(Math.ceil(size * opts.feePerByte));
    const next = buildSigned({ ...args, fee }, keyPair);
    if (next.serializedSize === size) return fee;
    size = next.serializedSize;
  }
  fail('fee/size did not converge');
}

// ---------------------------------------------------------------- round trip

function roundTrip(tx) {
  const hex = tx.toHex();
  const fromBytes = Transaction.deserialize(tx.serialize());
  const fromHex = Transaction.fromAny(hex);
  const checks = [];
  const eq = (name, a, b) =>
    checks.push({ name, ok: String(a) === String(b), a: String(a), b: String(b) });
  const hexOf = (u8) => Buffer.from(u8).toString('hex');
  for (const [label, rt] of [['deserialize(bytes)', fromBytes], ['fromAny(hex)', fromHex]]) {
    eq(`${label} hash`, tx.hash(), rt.hash());
    eq(`${label} sender`, tx.sender.toUserFriendlyAddress(), rt.sender.toUserFriendlyAddress());
    eq(`${label} recipient`, tx.recipient.toUserFriendlyAddress(), rt.recipient.toUserFriendlyAddress());
    eq(`${label} value`, tx.value, rt.value);
    eq(`${label} fee`, tx.fee, rt.fee);
    eq(`${label} validityStartHeight`, tx.validityStartHeight, rt.validityStartHeight);
    eq(`${label} networkId`, tx.networkId, rt.networkId);
    eq(`${label} data(hex)`, hexOf(tx.data), hexOf(rt.data));
    eq(`${label} data(utf8)`, new TextDecoder().decode(tx.data), new TextDecoder().decode(rt.data));
    eq(`${label} proof(hex)`, hexOf(tx.proof), hexOf(rt.proof));
    eq(`${label} serializedSize`, tx.serializedSize, rt.serializedSize);
    eq(`${label} toHex`, hex, rt.toHex());
  }
  return checks;
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.to) fail('--to is required');
  if (opts.luna === undefined) fail('--luna is required');
  if (opts.data === undefined) fail('--data is required (pass "" for an empty data field)');
  if (opts.ephemeral && !opts.dryRun) {
    fail('--ephemeral is dry-run only; an ephemeral key holds no funds');
  }

  const value = BigInt(opts.luna);
  const dataBytes = new TextEncoder().encode(opts.data);
  if (dataBytes.length > MAX_DATA_BYTES) {
    fail(`--data is ${dataBytes.length} UTF-8 bytes; the data field allows ${MAX_DATA_BYTES}`);
  }

  const keyPair = opts.ephemeral
    ? KeyPair.generate()
    : KeyPair.derive(PrivateKey.fromHex(loadPrivateKeyHex(opts)));
  const sender = keyPair.toAddress();
  let recipient;
  try {
    recipient = Address.fromString(opts.to);
  } catch {
    fail(`--to is not a valid Nimiq address: "${opts.to}". Use a real address you control, e.g. your Nimiq Pay wallet's receive address (Nimiq Pay -> Receive -> copy), in the form "NQxx XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX".`);
  }

  if (sender.equals(recipient)) fail('sender and recipient are the same address; mainnet rejects that');
  if (value <= 0n) fail('--luna must be greater than 0');

  const height = await getBlockNumber(opts.rpc);
  const minFeePerByte = await getMinFeePerByte(opts.rpc);
  const validityStartHeight = height;

  const args = { sender, recipient, dataBytes, value, validityStartHeight };
  const fee = chooseFee(opts, args, keyPair);
  const tx = buildSigned({ ...args, fee }, keyPair);

  // Local consensus-rule gate. verify() throws on a data field over 64 bytes ("Overflow"),
  // sender == recipient, zero value, a bad signature, or an unknown network. Confirmed 2026-09-13.
  tx.verify(Policy.MAX_SUPPORTED_VERSION, NETWORK_ID_MAINNET);

  const hash = tx.hash();
  const hex = tx.toHex();
  const plain = tx.toPlain();
  const explorer = `https://nimiq.watch/#${hash}`;

  console.log('=== rewind spike N12 — build-tx ===');
  console.log(`built at             ${new Date().toISOString()}`);
  console.log(`rpc                  ${opts.rpc}`);
  console.log(`network              ${plain.network} (networkId ${tx.networkId})`);
  console.log(`chain head           ${height}`);
  console.log(`getMinFeePerByte     ${minFeePerByte}`);
  console.log(
    `key source           ${opts.ephemeral ? 'EPHEMERAL (in-memory, not persisted)' : opts.key ? '--key argument' : resolve(opts.env ? opts.env : resolve(here, '.env.local'))}`,
  );
  console.log('');
  console.log(`sender               ${sender.toUserFriendlyAddress()}`);
  console.log(`recipient            ${recipient.toUserFriendlyAddress()}`);
  console.log(`value                ${value} Luna  =  ${(Number(value) / 1e5).toFixed(5)} NIM`);
  console.log(
    `fee                  ${fee} Luna  (${opts.fee !== undefined ? 'explicit --fee' : `${opts.feePerByte} Luna/byte`}), feePerByte ${tx.feePerByte}`,
  );
  console.log(`data (utf8)          ${JSON.stringify(opts.data)}`);
  console.log(`data (hex)           ${Buffer.from(tx.data).toString('hex') || '(empty)'}`);
  console.log(`data bytes           ${dataBytes.length} / ${MAX_DATA_BYTES}`);
  console.log(`format               ${plain.format} (TransactionFormat ${tx.format})`);
  console.log(
    `validityStartHeight  ${validityStartHeight}  (valid through ${validityStartHeight + Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS})`,
  );
  console.log(`serializedSize       ${tx.serializedSize} bytes`);
  console.log(`tx hash              ${hash}`);
  console.log(`explorer             ${explorer}`);
  console.log('');
  console.log('raw hex (sendRawTransaction param):');
  console.log(hex);
  console.log('');

  const checks = roundTrip(tx);
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `round-trip           ${failed.length === 0 ? `PASS (${checks.length}/${checks.length} field comparisons)` : `FAIL (${failed.length} mismatches)`}`,
  );
  for (const f of failed) console.log(`  MISMATCH ${f.name}: ${f.a} != ${f.b}`);
  console.log(
    `local verify()       PASS (protocol_version ${Policy.MAX_SUPPORTED_VERSION}, networkId ${NETWORK_ID_MAINNET})`,
  );
  if (failed.length) {
    process.exitCode = 1;
    return;
  }

  if (opts.dryRun) {
    console.log('');
    console.log('DRY RUN — sendRawTransaction was NOT called. Nothing was broadcast.');
    console.log('Re-run with --broadcast to submit (requires a funded sender).');
    return;
  }

  // -------------------------------------------------------------- broadcast

  console.log('--- BROADCASTING (sendRawTransaction) ---');
  let returnedHash;
  try {
    returnedHash = await sendRawTransaction(hex, opts.rpc);
  } catch (e) {
    console.error(`sendRawTransaction FAILED: ${e.message}`);
    console.error('Nothing was confirmed. It may still have propagated — check the explorer link.');
    process.exitCode = 1;
    return;
  }
  console.log(`sendRawTransaction   returned ${returnedHash}`);
  console.log(`matches local hash   ${returnedHash === hash ? 'YES' : `NO (local ${hash})`}`);
  console.log(`sent at              ${new Date().toISOString()}`);

  const deadline = Date.now() + opts.timeout * 1000;
  let details = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      details = await getTransactionByHash(hash, opts.rpc);
      break;
    } catch (e) {
      if (isNotFound(e)) {
        process.stdout.write('.');
        continue;
      }
      console.log('');
      console.error(`poll error (continuing): ${e.message}`);
    }
  }
  console.log('');

  if (!details) {
    console.log(`NOT CONFIRMED within ${opts.timeout}s — getTransactionByHash still reports not found.`);
    console.log(`Still valid until block ${validityStartHeight + Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS}.`);
    console.log(`Keep checking: ${explorer}`);
    process.exitCode = 1;
    return;
  }

  const dataUtf8 = details.recipientData
    ? Buffer.from(details.recipientData, 'hex').toString('utf8')
    : '';
  console.log('--- CONFIRMED (getTransactionByHash) ---');
  console.log(`confirmed at         ${new Date().toISOString()}`);
  console.log(`blockNumber          ${details.blockNumber}`);
  console.log(`confirmations        ${details.confirmations}`);
  console.log(`executionResult      ${details.executionResult}`);
  console.log(`from                 ${details.from}`);
  console.log(`to                   ${details.to}`);
  console.log(`value                ${details.value} Luna`);
  console.log(`fee                  ${details.fee} Luna`);
  console.log(`networkId            ${details.networkId}`);
  console.log(`recipientData (hex)  ${details.recipientData}`);
  console.log(`recipientData (utf8) ${JSON.stringify(dataUtf8)}`);
  console.log(`data round-trips     ${dataUtf8 === opts.data ? 'YES' : 'NO'}`);
  console.log(`explorer             ${explorer}`);
  console.log('');
  console.log('full getTransactionByHash payload:');
  console.log(JSON.stringify(details, null, 2));

  const pass = details.executionResult === true && dataUtf8 === opts.data;
  console.log('');
  console.log(`GATE N12: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Halt)) {
    console.error(e?.stack || String(e));
    process.exitCode = 1;
  }
}
