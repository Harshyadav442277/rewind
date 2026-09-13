#!/usr/bin/env node
// Rewind spike — light-client. Requests testnet NIM from the public Nimiq PoS testnet faucet.
//
// Usage:
//   node faucet.mjs                 # funds the address in .env.local
//   node faucet.mjs --address NQ..  # funds an explicit address
//   node faucet.mjs --info          # just prints the faucet's own state and exits
//
// Faucet request format, observed 2026-09-13:
//   GET  https://faucet.pos.nimiq-testnet.com/info
//        -> {"network":"test","address":"NQ37 ...","balance":<NIM>,"dispenseAmount":110000,
//            "dispensesRemaining":<n>,"availableInRegion":true}
//   POST https://faucet.pos.nimiq-testnet.com/tapit
//        Content-Type: application/x-www-form-urlencoded
//        body: address=<user-friendly NQ address, spaces are fine once URL-encoded>
//        -> {"success":true, ...}
//
// This script never reads or prints the private key. It only derives the public address from it.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair, PrivateKey } from '@nimiq/core';

const here = dirname(fileURLToPath(import.meta.url));
const FAUCET = 'https://faucet.pos.nimiq-testnet.com';

function addressFromEnv(envPath) {
  if (!existsSync(envPath)) {
    throw new Error(`${envPath} does not exist. Run "node gen-key.mjs" first.`);
  }
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('REWIND_TESTNET_PRIVATE_KEY='));
  if (!line) throw new Error(`REWIND_TESTNET_PRIVATE_KEY not found in ${envPath}`);
  const hex = line.split('=').slice(1).join('=').trim();
  // Derived and immediately discarded. The hex never leaves this function.
  return KeyPair.derive(PrivateKey.fromHex(hex)).toAddress().toUserFriendlyAddress();
}

async function getInfo() {
  const res = await fetch(`${FAUCET}/info`);
  const body = await res.text();
  if (!res.ok) throw new Error(`GET /info -> ${res.status}: ${body}`);
  return JSON.parse(body);
}

async function tapit(address) {
  const res = await fetch(`${FAUCET}/tapit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address }).toString(),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { status: res.status, text, parsed };
}

async function main() {
  const args = process.argv.slice(2);
  const info = await getInfo();

  console.log('=== faucet /info ===');
  console.log(`network              ${info.network}`);
  console.log(`faucet address       ${info.address}`);
  console.log(`faucet balance       ${info.balance} NIM`);
  console.log(`dispenseAmount       ${info.dispenseAmount} NIM`);
  console.log(`dispensesRemaining   ${info.dispensesRemaining}`);
  console.log(`availableInRegion    ${info.availableInRegion}`);
  console.log('');

  if (args.includes('--info')) return;

  const addrIdx = args.indexOf('--address');
  const address =
    addrIdx === -1 ? addressFromEnv(resolve(here, '.env.local')) : args[addrIdx + 1];

  console.log('=== POST /tapit ===');
  console.log(`requested at         ${new Date().toISOString()}`);
  console.log(`address              ${address}`);
  const out = await tapit(address);
  console.log(`http status          ${out.status}`);
  console.log(`response             ${out.text}`);
  if (!out.parsed?.success) {
    console.log('');
    console.log('FAUCET REQUEST DID NOT REPORT SUCCESS.');
    process.exitCode = 1;
  }
}

await main();
