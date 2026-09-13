#!/usr/bin/env node
// Rewind spike — light-client. Measures the @nimiq/core 2.21.0 light client from plain Node,
// with NO JSON-RPC server anywhere in the path.
//
// Usage:
//   node sync.mjs --network testnet [--address NQ..] [--log-level info] [--sync-mode pico|light]
//   node sync.mjs --network mainnet
//
// What it measures and prints:
//   * ms to import @nimiq/core (WASM load, synchronous)
//   * ms for Client.create()  (spawns the worker thread, starts connecting)
//   * ms for waitForConsensusEstablished()  <- the number that decides serverless viability
//   * head height, network id, protocol version, peer count
//   * process.memoryUsage() after consensus, main thread + worker thread (resourceUsage)
//   * getTransactionsByAddress() on a busy address, then getTransaction() on one of the hashes,
//     with every parsed field printed (sender, recipient, value, data hex + utf8, height, state)
//
// A machine-readable "RESULT " JSON line is printed last so runs can be diffed.

import { performance } from 'node:perf_hooks';

const T_PROC_START = performance.now();

const tImportStart = performance.now();
const Nimiq = await import('@nimiq/core');
const tImportEnd = performance.now();

const { Client, ClientConfiguration } = Nimiq;

// ------------------------------------------------------------------ arguments

const NETWORKS = {
  testnet: {
    networkName: 'TestAlbatross',
    expectNetworkId: 5,
    // GOTCHA, observed 2026-09-13: ClientConfiguration's default seedNodes list is baked into
    // the WASM and contains ONLY the 14 mainnet seeds. Calling config.network('TestAlbatross')
    // does NOT swap them. A testnet client left on the defaults dials mainnet seeds, gets
    // dropped at handshake, and sits in "connecting" forever. Seeds must be set explicitly.
    // The package's own README documents /dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss;
    // seed2..seed4 resolve too (verified by DNS + TCP connect on 2026-09-13). Note port 8443,
    // not the 443 the mainnet seeds use.
    seedNodes: [
      '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
      '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
    ],
    // The public PoS testnet faucet. Confirmed 2026-09-13 via GET
    // https://faucet.pos.nimiq-testnet.com/info -> {"network":"test","address":"NQ37 ..."}.
    // It pays out 110000 NIM per dispense, so it is the busiest address on the testnet.
    busyAddress: 'NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ',
    explorer: (h) => `https://test.nimiq.watch/#${h}`,
  },
  mainnet: {
    networkName: 'MainAlbatross',
    expectNetworkId: 24,
    // A real mainnet staker address, taken from the getTransactionByHash payload recorded in
    // spikes/server-tx/README.md §"90fca75b..." (block 61420752). Not the staking contract
    // NQ77 0000 ... 0001, which has a history far too large for a light-client history query.
    busyAddress: 'NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M',
    explorer: (h) => `https://nimiq.watch/#${h}`,
  },
};

function parseArgs(argv) {
  const out = { network: 'testnet', logLevel: 'warn', limit: 5, minPeers: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--network': out.network = next(); break;
      case '--address': out.address = next(); break;
      case '--log-level': out.logLevel = next(); break;
      case '--sync-mode': out.syncMode = next(); break;
      case '--limit': out.limit = Number(next()); break;
      case '--min-peers': out.minPeers = Number(next()); break;
      case '--peers': out.desiredPeerCount = Number(next()); break;
      case '--hash': out.hash = next(); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!NETWORKS[out.network]) {
    throw new Error(`--network must be one of ${Object.keys(NETWORKS).join('|')}`);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const net = NETWORKS[opts.network];
const address = opts.address ?? net.busyAddress;

const ms = (n) => `${n.toFixed(0)} ms`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const hexToUtf8 = (hex) => (hex ? Buffer.from(hex, 'hex').toString('utf8') : '');

// ------------------------------------------------------------------ run

const result = {
  network: opts.network,
  networkName: net.networkName,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  importMs: +(tImportEnd - tImportStart).toFixed(0),
};

console.log('=== rewind spike — light-client sync ===');
console.log(`started at           ${result.startedAt}`);
console.log(`node                 ${process.version} on ${process.platform}/${process.arch}`);
console.log(`network              ${opts.network} (${net.networkName})`);
console.log(`log level            ${opts.logLevel}`);
console.log(`import @nimiq/core   ${ms(tImportEnd - tImportStart)}`);
console.log('');

const config = new ClientConfiguration();
config.network(net.networkName);
config.logLevel(opts.logLevel);
if (net.seedNodes) config.seedNodes(net.seedNodes);
if (opts.syncMode) config.syncMode(opts.syncMode);
if (opts.desiredPeerCount) config.desiredPeerCount(opts.desiredPeerCount);
const plainConfig = config.build();
console.log(`built config         ${JSON.stringify(plainConfig)}`);
result.config = plainConfig;

// Consensus-state transitions, timestamped relative to Client.create().
const consensusEvents = [];
const peerEvents = [];

const tCreateStart = performance.now();
const client = await Client.create(plainConfig);
const tCreateEnd = performance.now();
result.createMs = +(tCreateEnd - tCreateStart).toFixed(0);
console.log(`Client.create()      ${ms(tCreateEnd - tCreateStart)}`);

await client.addConsensusChangedListener((state) => {
  const at = +(performance.now() - tCreateStart).toFixed(0);
  consensusEvents.push({ state, atMsAfterCreate: at });
  console.log(`  [consensus] ${state} @ +${at} ms`);
});
await client.addPeerChangedListener((peerId, reason, peerCount) => {
  const at = +(performance.now() - tCreateStart).toFixed(0);
  if (peerEvents.length < 40) peerEvents.push({ reason, peerCount, atMsAfterCreate: at });
  console.log(`  [peer] ${reason} count=${peerCount} @ +${at} ms  ${peerId.slice(0, 16)}…`);
});

const tConsensusStart = performance.now();
const CONSENSUS_TIMEOUT_MS = Number(process.env.CONSENSUS_TIMEOUT_MS ?? 180000);
const timedOut = Symbol('timeout');
const race = await Promise.race([
  client.waitForConsensusEstablished().then(() => 'ok'),
  new Promise((r) => setTimeout(() => r(timedOut), CONSENSUS_TIMEOUT_MS).unref?.()),
]);
if (race === timedOut) {
  result.consensusTimedOutAfterMs = CONSENSUS_TIMEOUT_MS;
  result.consensusEvents = consensusEvents;
  result.peerEvents = peerEvents;
  console.log('');
  console.log(`NO CONSENSUS within ${CONSENSUS_TIMEOUT_MS} ms — giving up.`);
  console.log(`  consensus events: ${JSON.stringify(consensusEvents)}`);
  console.log(`  peer events:      ${JSON.stringify(peerEvents)}`);
  console.log('');
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(1);
}
const tConsensus = performance.now();

result.consensusMsAfterCreate = +(tConsensus - tCreateStart).toFixed(0);
result.consensusMsFromProcessStart = +(tConsensus - T_PROC_START).toFixed(0);
result.consensusEvents = consensusEvents;

console.log('');
console.log(`CONSENSUS ESTABLISHED`);
console.log(`  after Client.create()      ${ms(tConsensus - tCreateStart)}`);
console.log(`  after waitFor…() called    ${ms(tConsensus - tConsensusStart)}`);
console.log(`  from process start         ${ms(tConsensus - T_PROC_START)}   <-- cold-start number`);
console.log('');

// ---------------------------------------------------------------- head state

const headHeight = await client.getHeadHeight();
const headHash = await client.getHeadHash();
const networkId = await client.getNetworkId();
const protocolVersion = await client.getProtocolVersion();
const version = await client.getVersion();
const addressBook = await client.getAddressBook();

Object.assign(result, {
  headHeight,
  headHash,
  networkId,
  protocolVersion,
  clientVersion: version,
  addressBookSize: addressBook.length,
  networkIdMatchesExpected: networkId === net.expectNetworkId,
});

console.log(`head height          ${headHeight}`);
console.log(`head hash            ${headHash}`);
console.log(`networkId            ${networkId}  (expected ${net.expectNetworkId}: ${networkId === net.expectNetworkId ? 'MATCH' : 'MISMATCH'})`);
console.log(`protocolVersion      ${protocolVersion}`);
console.log(`client version       ${version}`);
console.log(`address book         ${addressBook.length} peers`);
if (addressBook.length) {
  const proto = {};
  for (const p of addressBook) {
    for (const a of p.addresses ?? []) {
      const m = a.match(/\/(wss?|tcp|webrtc|p2p-circuit|quic)\b/g) ?? [];
      for (const t of m) proto[t] = (proto[t] ?? 0) + 1;
    }
  }
  console.log(`  multiaddr protocol tally  ${JSON.stringify(proto)}`);
  console.log(`  sample peer               ${JSON.stringify(addressBook[0])}`);
  result.multiaddrProtocols = proto;
  result.samplePeer = addressBook[0];
}

// ---------------------------------------------------------------- memory

const mem = process.memoryUsage();
const ru = process.resourceUsage();
result.memoryAfterConsensus = {
  rssBytes: mem.rss,
  heapUsedBytes: mem.heapUsed,
  externalBytes: mem.external,
  arrayBuffersBytes: mem.arrayBuffers,
  maxRSSKb: ru.maxRSS,
};
console.log('');
console.log('process.memoryUsage() after consensus (main thread; worker RSS is shared in rss):');
console.log(`  rss                ${mb(mem.rss)}`);
console.log(`  heapTotal          ${mb(mem.heapTotal)}`);
console.log(`  heapUsed           ${mb(mem.heapUsed)}`);
console.log(`  external           ${mb(mem.external)}`);
console.log(`  arrayBuffers       ${mb(mem.arrayBuffers)}`);
console.log(`  resourceUsage.maxRSS  ${(ru.maxRSS / 1024).toFixed(1)} MB (peak, whole process)`);

// ---------------------------------------------------- getTransactionsByAddress

console.log('');
console.log(`=== getTransactionsByAddress("${address}", limit ${opts.limit}, minPeers ${opts.minPeers}) ===`);
let txs = [];
const tTxsStart = performance.now();
try {
  // signature: (address, since_block_height?, known_transaction_details?, start_at?, limit?, min_peers?)
  txs = await client.getTransactionsByAddress(address, null, null, null, opts.limit, opts.minPeers);
  result.getTransactionsByAddressMs = +(performance.now() - tTxsStart).toFixed(0);
  result.getTransactionsByAddressCount = txs.length;
  console.log(`took                 ${ms(performance.now() - tTxsStart)}`);
  console.log(`returned             ${txs.length} transactions`);
} catch (e) {
  result.getTransactionsByAddressError = String(e?.message ?? e);
  result.getTransactionsByAddressMs = +(performance.now() - tTxsStart).toFixed(0);
  console.log(`FAILED after ${ms(performance.now() - tTxsStart)}: ${e?.message ?? e}`);
}

function printTx(t, indent = '  ') {
  const dataRaw = t.data?.raw ?? '';
  console.log(`${indent}transactionHash    ${t.transactionHash}`);
  console.log(`${indent}state              ${t.state}`);
  console.log(`${indent}executionResult    ${t.executionResult}`);
  console.log(`${indent}blockHeight        ${t.blockHeight}`);
  console.log(`${indent}confirmations      ${t.confirmations}`);
  console.log(`${indent}timestamp          ${t.timestamp} (${t.timestamp ? new Date(t.timestamp).toISOString() : '-'})`);
  console.log(`${indent}format             ${t.format}`);
  console.log(`${indent}sender             ${t.sender} (${t.senderType})`);
  console.log(`${indent}recipient          ${t.recipient} (${t.recipientType})`);
  console.log(`${indent}value              ${t.value} Luna = ${(t.value / 1e5).toFixed(5)} NIM`);
  console.log(`${indent}fee                ${t.fee} Luna (feePerByte ${t.feePerByte})`);
  console.log(`${indent}validityStartHeight ${t.validityStartHeight}`);
  console.log(`${indent}network            ${t.network}`);
  console.log(`${indent}flags              ${t.flags}`);
  console.log(`${indent}size               ${t.size} bytes`);
  console.log(`${indent}data.type          ${t.data?.type}`);
  console.log(`${indent}data (hex)         ${dataRaw || '(empty)'}`);
  console.log(`${indent}data (utf8)        ${JSON.stringify(hexToUtf8(dataRaw))}`);
  console.log(`${indent}proof.type         ${t.proof?.type}`);
}

for (const [i, t] of txs.entries()) {
  console.log('');
  console.log(`--- tx[${i}] ---`);
  printTx(t);
}
result.transactions = txs.map((t) => ({
  hash: t.transactionHash,
  state: t.state,
  blockHeight: t.blockHeight,
  value: t.value,
  sender: t.sender,
  recipient: t.recipient,
  dataHex: t.data?.raw ?? '',
  dataUtf8: hexToUtf8(t.data?.raw ?? ''),
}));

// ---------------------------------------------------------- getTransaction

const targetHash = opts.hash ?? txs[0]?.transactionHash;
console.log('');
if (!targetHash) {
  console.log('=== getTransaction(hash) SKIPPED — no hash available ===');
  result.getTransactionSkipped = true;
} else {
  console.log(`=== getTransaction("${targetHash}") ===`);
  const tOneStart = performance.now();
  try {
    const one = await client.getTransaction(targetHash);
    result.getTransactionMs = +(performance.now() - tOneStart).toFixed(0);
    console.log(`took                 ${ms(performance.now() - tOneStart)}`);
    printTx(one, '  ');
    console.log(`  explorer           ${net.explorer(targetHash)}`);
    result.getTransactionHash = one.transactionHash;
    result.getTransactionMatchesRequested = one.transactionHash === targetHash;
    console.log(`  hash matches ask   ${one.transactionHash === targetHash ? 'YES' : 'NO'}`);
  } catch (e) {
    result.getTransactionError = String(e?.message ?? e);
    result.getTransactionMs = +(performance.now() - tOneStart).toFixed(0);
    console.log(`FAILED after ${ms(performance.now() - tOneStart)}: ${e?.message ?? e}`);
  }
}

// ------------------------------------------------------------- getAccount

console.log('');
console.log(`=== getAccount("${address}") ===`);
const tAccStart = performance.now();
try {
  const acc = await client.getAccount(address);
  result.getAccountMs = +(performance.now() - tAccStart).toFixed(0);
  result.account = acc;
  console.log(`took                 ${ms(performance.now() - tAccStart)}`);
  console.log(`  ${JSON.stringify(acc)}`);
  if (typeof acc.balance === 'number') {
    console.log(`  balance            ${acc.balance} Luna = ${(acc.balance / 1e5).toFixed(5)} NIM`);
  }
} catch (e) {
  result.getAccountError = String(e?.message ?? e);
  console.log(`FAILED: ${e?.message ?? e}`);
}

// ------------------------------------------------------------------ wrap up

result.totalMs = +(performance.now() - T_PROC_START).toFixed(0);
result.memoryAtEnd = { rssBytes: process.memoryUsage().rss };
console.log('');
console.log(`total wall clock     ${ms(performance.now() - T_PROC_START)}`);
console.log('');
console.log(`RESULT ${JSON.stringify(result)}`);

// Teardown. The WASM worker thread keeps the event loop alive forever, so the process will not
// exit on its own. disconnectNetwork() only signals; it does not join the worker. Everything
// above is already flushed to stdout by this point, so a hard exit cannot hide a result.
await client.disconnectNetwork().catch(() => {});
process.exit(0);
