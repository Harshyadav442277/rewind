#!/usr/bin/env node
// Rewind spike — light-client. Measures the WARM read path: boot the client once, then do
// repeated reads, to quantify what a long-lived process gets that a per-invocation serverless
// function does not.
//
// Usage: node warm.mjs [--network testnet|mainnet] [--rounds 8]

import { Client, ClientConfiguration } from '@nimiq/core';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const NETWORKS = {
  testnet: {
    name: 'TestAlbatross',
    seeds: [
      '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
    ],
    addr: 'NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ',
  },
  mainnet: {
    name: 'MainAlbatross',
    seeds: null,
    addr: 'NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M',
  },
};

const argv = process.argv.slice(2);
const network = argv.includes('--network') ? argv[argv.indexOf('--network') + 1] : 'testnet';
const rounds = argv.includes('--rounds') ? Number(argv[argv.indexOf('--rounds') + 1]) : 8;
const net = NETWORKS[network];

const config = new ClientConfiguration();
config.network(net.name);
config.logLevel('error');
if (net.seeds) config.seedNodes(net.seeds);

const t0 = performance.now();
const client = await Client.create(config.build());
await client.waitForConsensusEstablished();
const bootMs = performance.now() - t0;

console.log(`=== warm read path — ${network} ===`);
console.log(`boot to consensus    ${bootMs.toFixed(0)} ms  (paid ONCE per process)`);
console.log(`rss after consensus  ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
console.log('');
console.log('round | getHeadHeight | getAccount | getTransactionsByAddress(limit 3)');

const stats = { head: [], acc: [], txs: [] };
for (let i = 1; i <= rounds; i++) {
  const a = performance.now();
  const h = await client.getHeadHeight();
  const b = performance.now();
  await client.getAccount(net.addr);
  const c = performance.now();
  let txsMs, txsN;
  try {
    const list = await client.getTransactionsByAddress(net.addr, null, null, null, 3, 1);
    txsN = list.length;
  } catch (e) {
    txsN = `ERR ${String(e?.message ?? e).slice(0, 40)}`;
  }
  txsMs = performance.now() - c;

  stats.head.push(b - a);
  stats.acc.push(c - b);
  if (typeof txsN === 'number') stats.txs.push(txsMs);
  console.log(
    `${String(i).padStart(5)} | ${(b - a).toFixed(0).padStart(13)} | ${(c - b).toFixed(0).padStart(10)} | ${txsMs.toFixed(0).padStart(7)} ms (${txsN}) head=${h}`,
  );
  await sleep(1000);
}

const summarise = (name, xs) => {
  if (!xs.length) return `${name}: no successful samples`;
  const s = [...xs].sort((p, q) => p - q);
  return `${name}: min ${s[0].toFixed(0)} / median ${s[Math.floor(s.length / 2)].toFixed(0)} / max ${s[s.length - 1].toFixed(0)} ms  (n=${s.length})`;
};
console.log('');
console.log(summarise('getHeadHeight           ', stats.head));
console.log(summarise('getAccount              ', stats.acc));
console.log(summarise('getTransactionsByAddress', stats.txs));
console.log(`getTransactionsByAddress failures: ${rounds - stats.txs.length} / ${rounds}`);
console.log(`rss at end           ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
console.log(`peak rss             ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MB`);

process.exit(0);
