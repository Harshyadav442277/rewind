#!/usr/bin/env node
/**
 * `npm run rehearsal:testnet` — start Rewind against the Nimiq PoS TESTNET, locally.
 *
 * What it does, in order:
 *   1. finds or creates the demo treasury key (root `.env.local`, `REWIND_TREASURY_PRIVATE_KEY`),
 *      reusing `spikes/light-client/.env.local`'s burner if that is the only one present. The
 *      spike file is READ, never written;
 *   2. prints the treasury address and its current testnet balance (third-party read, so the
 *      number does not come from the code under test);
 *   3. taps the public testnet faucet if the balance is under the floor, and waits for it;
 *   4. starts `vite` with the rehearsal environment and prints the LAN URL to type into
 *      Nimiq Pay -> Mini Apps -> Custom URL.
 *
 * TESTNET ONLY. It refuses to run with REWIND_NETWORK set to anything else, it never touches
 * mainnet, and the key it manages is a burner funded by a faucet. The private key is never
 * printed, logged or passed on a command line — it goes to the child process in its env.
 *
 * Flags:
 *   --no-server   do everything except starting vite (used by the end-to-end script)
 *   --skip-faucet do not tap the faucet even if the balance is low
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair, PrivateKey } from '@nimiq/core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ROOT_ENV = resolve(root, '.env.local');
const SPIKE_ENV = resolve(root, 'spikes/light-client/.env.local');

const FAUCET = 'https://faucet.pos.nimiq-testnet.com';
const EXPLORER_API = 'https://test-api.nimiq.watch/api/v1';
/** Below this the faucet is tapped. 100 NIM: a demo order is 0.01 NIM. */
const FLOOR_LUNA = 10_000_000;
const PORT = 5173;

const args = process.argv.slice(2);
const noServer = args.includes('--no-server');
const skipFaucet = args.includes('--skip-faucet');

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Never returns or logs the key itself; only where it came from. */
function resolveTreasuryKey() {
  const rootEnv = readEnvFile(ROOT_ENV);
  if (rootEnv.REWIND_TREASURY_PRIVATE_KEY) {
    return { hex: rootEnv.REWIND_TREASURY_PRIVATE_KEY, origin: `${ROOT_ENV} (existing)` };
  }
  const spikeEnv = readEnvFile(SPIKE_ENV);
  if (spikeEnv.REWIND_TESTNET_PRIVATE_KEY) {
    return {
      hex: spikeEnv.REWIND_TESTNET_PRIVATE_KEY,
      origin: `${SPIKE_ENV} (spike burner, copied in; the spike file is untouched)`,
      writeToRoot: true,
    };
  }
  return {
    hex: KeyPair.generate().privateKey.toHex(),
    origin: 'freshly generated testnet burner',
    writeToRoot: true,
  };
}

function persistTreasuryKey(hex, address) {
  const header =
    `# Rewind LOCAL rehearsal environment. TESTNET burner key — funded by a public faucet,\n` +
    `# holds nothing of value, never use on mainnet, never commit. Gitignored via .env.*\n` +
    `# Treasury address: ${address}\n`;
  const line = `REWIND_TREASURY_PRIVATE_KEY=${hex}\n`;
  if (!existsSync(ROOT_ENV)) {
    writeFileSync(ROOT_ENV, header + line, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } else {
    // Append only. Whatever else is in that file is not this script's business.
    appendFileSync(ROOT_ENV, `\n${header}${line}`, 'utf8');
  }
}

async function balanceLuna(address) {
  const res = await fetch(`${EXPLORER_API}/account/${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`test-api.nimiq.watch answered ${res.status}`);
  const body = await res.json();
  if (typeof body.balance !== 'number') throw new Error(`no balance in ${JSON.stringify(body)}`);
  return body.balance;
}

async function tapFaucet(address) {
  const res = await fetch(`${FAUCET}/tapit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address }).toString(),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function lanUrls() {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  return urls;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.REWIND_NETWORK && process.env.REWIND_NETWORK !== 'testnet') {
    console.error(`REFUSING: REWIND_NETWORK=${process.env.REWIND_NETWORK}. This script is testnet only.`);
    process.exitCode = 2;
    return;
  }

  console.log('=== Rewind testnet rehearsal ===');
  const key = resolveTreasuryKey();
  const address = KeyPair.derive(PrivateKey.fromHex(key.hex)).toAddress().toUserFriendlyAddress();
  if (key.writeToRoot) persistTreasuryKey(key.hex, address);
  console.log(`treasury key         ${key.origin}`);
  console.log(`treasury address     ${address}`);

  let balance = await balanceLuna(address);
  console.log(`balance              ${balance} Luna = ${(balance / 100_000).toFixed(5)} NIM  (test-api.nimiq.watch)`);

  if (balance < FLOOR_LUNA && !skipFaucet) {
    console.log(`below ${FLOOR_LUNA} Luna — tapping the faucet`);
    const out = await tapFaucet(address);
    console.log(`faucet               http ${out.status} ${out.text}`);
    const deadline = Date.now() + 120_000;
    while (balance < FLOOR_LUNA && Date.now() < deadline) {
      await sleep(3_000);
      balance = await balanceLuna(address);
      console.log(`  waiting…           ${balance} Luna`);
    }
    if (balance < FLOOR_LUNA) {
      console.error('faucet payout did not arrive within 120 s. Not starting the server.');
      process.exitCode = 1;
      return;
    }
  }

  const env = {
    ...process.env,
    REWIND_CHAIN: 'lightclient',
    REWIND_NETWORK: 'testnet',
    REWIND_REPO: 'memory',
    REWIND_VERIFIER: 'real',
    REWIND_DEMO_AUTO_APPROVE: 'on',
    REWIND_TREASURY_PRIVATE_KEY: key.hex,
    // Must be the address of that key: it is both the Demo Store's receiving address and the
    // refund sender, and the domain checks both.
    REWIND_TREASURY_ADDRESS: address,
  };

  console.log('');
  console.log('mode                 REWIND_CHAIN=lightclient  REWIND_NETWORK=testnet  networkId 5');
  console.log('repository           in-memory (orders are lost when this process stops)');
  console.log('signatures           REAL verifier; Demo Store auto-approves its own refunds');
  console.log('explorer             https://test.nimiq.watch/#<hash>');
  console.log('');
  console.log('On the phone: Nimiq Pay -> long-press the settings icon ~10 s -> developer menu');
  console.log('  -> switch to testnet -> "Get free NIM" -> Mini Apps -> Custom URL:');
  for (const url of lanUrls()) console.log(`     ${url}`);
  console.log(`  (port ${PORT} unless it is busy — vite prints the port it actually bound, below,`);
  console.log('   and so does the dev plugin. Same wifi both ends; plain http is UNVERIFIED)');
  console.log('');

  if (noServer) {
    console.log('--no-server: not starting vite.');
    return;
  }

  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

await main();
