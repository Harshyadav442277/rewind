# Rewind spike — `@nimiq/core` light client from Node, no JSON-RPC

Can `@nimiq/core@2.21.0`'s light client, running in plain Node with **no JSON-RPC server
anywhere in the path**, reach consensus, read the chain, and send a transaction — and is it a
usable fallback for the app's `ChainReader` when `rpc.nimiqwatch.com` is down?

**Short answer: it works on both networks, and it is not usable in a Vercel serverless
function. It is usable in a long-lived process.** Details and numbers below.

Everything marked *observed* was run on this machine on **2026-09-13** (Windows 11, Node
v24.19.0, win32/x64) and its raw output is in [`runs/`](runs/). Everything marked
**UNVERIFIED** was not run. Nothing here has been committed, deployed, or run against mainnet
with a key — the only transaction sent was on **testnet**, from a burner funded by the public
faucet.

---

## 1. Verdict

| Question | Answer |
|---|---|
| Consensus on testnet from Node, no RPC? | **Yes.** 4.9–6.0 s cold, 5 runs |
| Consensus on mainnet from Node, no RPC? | **Yes.** 8.4–32.1 s cold, 6 runs — median 15.1 s, and the spread is the problem |
| Read tx by hash / list by address? | **Yes**, both, on both networks |
| Build + sign + send + observe inclusion? | **Yes**, on testnet, real transaction, third-party confirmed |
| Native module needed? | **No** (on Node ≥ 22) |
| Usable inside a Vercel serverless function? | **No** for the app's current config. **With conditions** only in a narrow, unattractive form — §7 |
| Usable as a `ChainReader` fallback? | **Yes, in a long-lived process only**, and only with the `getTransactionByHash` null-semantics fix in §6 |

---

## 2. The two gotchas that cost the most time

### 2.1 `config.network('TestAlbatross')` does NOT change the seed nodes

`ClientConfiguration`'s default `seedNodes` list is baked into the WASM and contains **only the
14 mainnet seeds**. Selecting the testnet does not swap them. A testnet client left on the
defaults dials mainnet seeds, is dropped at handshake, and sits in `connecting` forever with no
error — I burned two runs on this before reading the config it had actually built.

Proof that the WASM ships no testnet seeds at all:

```
$ node -e "const b=require('fs').readFileSync('node_modules/@nimiq/core/nodejs/main-wasm/index_bg.wasm').toString('latin1');
           console.log((b.match(/[A-Za-z0-9.\-]*nimiq-testnet[A-Za-z0-9.\-]*/g)||[]).length)"
0
```

and the failing run's own log (`runs/testnet-diag.txt`), where `networkId: TestAlbatross` sits
next to a mainnet seed list, followed by peers connecting and instantly leaving:

```
built config {"networkId":"TestAlbatross","seedNodes":["/dns4/aurora.seed.nimiq.com/tcp/443/wss", ...
  [consensus] connecting @ +1928 ms
  [peer] left count=0 @ +1928 ms
  [consensus] connecting @ +2239 ms
  [peer] left count=0 @ +2239 ms
```

The fix is in the package's own `node_modules/@nimiq/core/README.md` — note **port 8443**, not
the 443 the mainnet seeds use:

```js
config.seedNodes(['/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss']);
```

`seed1..seed4.pos.nimiq-testnet.com` all resolve and accept TCP on 8443 (observed). All four
are used in `sync.mjs`.

### 2.2 `getTransaction(hash)` says "Transaction not found" about transactions that exist

This is the finding with real consequences for Rewind. See §6.

---

## 3. Measured timings — every run

`sync.mjs` prints a machine-readable `RESULT {...}` line; these are pulled from those lines.
Each run is a **fresh process**, so every row is a genuine cold start. Times in ms.

| run | import | `Client.create()` | consensus after create | **cold: process start → consensus** | peers | RSS after consensus | `getTransactionsByAddress` | `getTransaction` | `getAccount` | total |
|---|---|---|---|---|---|---|---|---|---|---|
| testnet-1 | 22 | 155 | 5707 | **5742** | 6 | 118.1 MB | 3702 (5 txs) | 610 | 558 | 10616 |
| testnet-2 | 40 | 324 | 4812 | **4860** | 6 | 116.2 MB | **FAILED** after 3 | – | 578 | 5443 |
| testnet-3 | 27 | 189 | 5110 | **5142** | 6 | 118.3 MB | 2755 (5 txs) | 643 | 623 | 9168 |
| testnet-4 | 21 | 171 | 5960 | **5989** | 5 | 117.5 MB | 2494 (5 txs) | 583 | 418 | 9489 |
| testnet-5 | 23 | 179 | 5241 | **5273** | 6 | 117.9 MB | 3132 (5 txs) | 568 | 551 | 9529 |
| mainnet-1 | 26 | 180 | 15095 | **15128** | 24 | 112.3 MB | 2831 (5 txs) | 415 | 1255 | 19634 |
| mainnet-2 | 22 | 167 | 29987 | **30014** | 29 | 117.7 MB | 3563 (5 txs) | 474 | 854 | 34911 |
| mainnet-3 | 24 | 178 | 11313 | **11345** | 24 | 115.6 MB | 1953 (5 txs) | 436 | 1580 | 15319 |
| mainnet-4 | 43 | 313 | 13793 | **13848** | 24 | 112.1 MB | 2292 (5 txs) | 446 | 520 | 17110 |
| mainnet-5 | 24 | 179 | 32053 | **32086** | 24 | 112.9 MB | 2090 (5 txs) | 406 | 385 | 34979 |
| mainnet-6 | 26 | 176 | 8331 | **8362** | 24 | 115.9 MB | 1997 (5 txs) | 410 | 1088 | 11861 |

**Cold consensus, sorted:**

- **testnet** (n=5): 4860, 5142, 5273, 5742, 5989 → min 4.9 s, median 5.3 s, max 6.0 s. Tight.
- **mainnet** (n=6): 8362, 11345, 13848, 15128, 30014, 32086 → min 8.4 s, median 15.1 s,
  **max 32.1 s**. Nearly 4× spread between best and worst.

The mainnet spread is the single most important number in this document. It is not an outlier:
two of six runs exceeded 29 s. Mainnet has ~24 peers versus testnet's ~6, and takes longer,
so this is not a peer-scarcity problem — it is the pico-sync handshake itself being variable.

### Warm read path (`warm.mjs`) — one process, repeated reads

8 rounds each, 1 s apart, in a single process. min / median / max.

| read | testnet | mainnet |
|---|---|---|
| boot to consensus (paid **once**) | 5617 ms | 4861 ms |
| `getHeadHeight` | **0 / 0 / 1 ms** | **0 / 0 / 1 ms** |
| `getAccount` | 562 / 647 / 1352 ms | 502 / 556 / 1053 ms |
| `getTransactionsByAddress` (limit 3) | 2066 / 2519 / 4028 ms | 2356 / 2647 / 3648 ms |
| `getTransactionsByAddress` failures | 0 / 8 | 0 / 8 |
| peak rss | 166.3 MB | 166.4 MB |

`getHeadHeight` costing **0–1 ms warm versus 4.9–32 s cold** is the whole argument for a
long-lived process: after boot the head is already in the client's own state and no network
round trip happens at all. The head advanced every round (11344189 → 11344219), so the client
is genuinely tracking the chain, not serving a stale cached value.

Note that `warm.mjs`'s mainnet boot was **4861 ms** — faster than every one of the six
`sync.mjs` mainnet runs. Counting it, mainnet cold consensus across 7 samples spans
**4.9 s to 32.1 s**, which widens the spread rather than narrowing it.

### Memory

`process.memoryUsage()` after consensus, main thread (the WASM worker is a `worker_thread`, so
it is inside the same process and its pages are counted in `rss`):

- **rss: 112–118 MB** across all 11 runs, remarkably stable
- **peak rss (`resourceUsage().maxRSS`): 165–167 MB** across all 11 runs
- heapUsed ~9 MB, external ~5 MB — almost all of the footprint is WASM, not JS heap

Comfortably inside Vercel's 2 GB Hobby / 4 GB Pro memory ceiling. Memory is not the blocker.

---

## 4. The API that actually worked

The type surface is `node_modules/@nimiq/core/types/wasm/bundler.d.ts`. Names differ from the
JSON-RPC names in places, and from the names in the task brief:

```js
import { Client, ClientConfiguration } from '@nimiq/core';

const config = new ClientConfiguration();
config.network('TestAlbatross');            // 'MainAlbatross' | 'TestAlbatross' | 'DevAlbatross'
config.seedNodes([...]);                     // REQUIRED for testnet — see §2.1
config.logLevel('warn');                     // 'trace'|'debug'|'info'|'warn'|'error'
// config.syncMode('pico');                  // 'pico' (default) | 'light'. Not overridden in any run here.

const client = await Client.create(config.build());
await client.waitForConsensusEstablished();
```

Calls exercised, all observed working:

| call | notes |
|---|---|
| `client.getHeadHeight()` | ~1 ms warm; local |
| `client.getHeadHash()` | local |
| `client.getNetworkId()` | returned **5** on testnet, **24** on mainnet — matches the brief |
| `client.getProtocolVersion()` | 2 |
| `client.getVersion()` | `2.1.0` (the crate version, not the npm 2.21.0) |
| `client.getAccount(addr)` | returns `PlainAccount`, a union; `{type:'basic',balance:<Luna>}` |
| `client.getAddressBook()` | peer list with multiaddrs and advertised services |
| `client.getTransactionsByAddress(addr, sinceBlockHeight, knownDetails, startAt, limit, minPeers)` | **six** params, not the RPC's three |
| `client.getTransaction(hash)` | **not** `getTransactionByHash`. See §6 |
| `client.sendTransaction(tx)` | takes a `Transaction`, `PlainTransaction`, hex string or bytes |
| `client.addConsensusChangedListener(cb)` | `'connecting' \| 'syncing' \| 'established'` |
| `client.addPeerChangedListener(cb)` | `joined`/`left` + peer count |
| `client.addTransactionListener(cb, addresses)` | declared; **UNVERIFIED — not exercised** |
| `client.disconnectNetwork()` | signals only; does not join the worker |

Naming corrections against the brief: there is **no** `getTransactionByHash` (it is
`getTransaction`) and **no** `getHeadHeight`-adjacent `getBlockNumber` (it is `getHeadHeight`).

### Parsed transaction fields, observed

Testnet, from `runs/testnet-1.txt` — the faucet payout into the burner:

```
transactionHash    e6c108b90b03b0fbf6eff66e98697d62b7233b9d0d14d749058226ebfb01e4cf
state              confirmed
executionResult    true
blockHeight        11343081
confirmations      695
timestamp          1789310561593 (2026-09-13T14:42:41.593Z)
format             basic
sender             NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ (basic)
recipient          NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH (basic)
value              11000000000 Luna = 110000.00000 NIM
fee                5 Luna (feePerByte 0.03597122302158273)
network            testalbatross
data (hex)         (empty)
data (utf8)        ""
proof.type         standard
```

Mainnet, from `runs/mainnet-1.txt` — a coinbase-style reward to the staker address:

```
transactionHash    797f0f87567bf9f486b147405829923fcb35d102c716771109125884824a4e71
state              confirmed
executionResult    true
blockHeight        61503840
sender             NQ81 C01N BASE 0000 0000 0000 0000 0000 0000 (basic)
recipient          NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M (basic)
value              9621120 Luna = 96.21120 NIM
fee                0 Luna
network            mainalbatross
proof.type         raw
```

Addresses used: testnet the **faucet**, `NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ` (the
busiest address on the testnet); mainnet `NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M`, taken
from the real payload recorded in `spikes/server-tx/README.md`. I deliberately did **not** use
`NQ77 0000 … 0001` — that is the staking contract and its history is far too large for a
light-client history query.

---

## 5. The real testnet send

Full output: [`runs/send-1.txt`](runs/send-1.txt). Sender is the burner in `.env.local`
(gitignored, `chmod 600`, generated by `gen-key.mjs`, never printed); recipient is the faucet.

```
sender               NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH
recipient            NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ
consensus            established in 5962 ms after Client.create()
networkId            5 (testnet, verified before signing)
head height          11343840
sender balance       11000000000 Luna = 110000.00000 NIM

value                100000 Luna = 1.00000 NIM
fee                  189 Luna (1 Luna/byte, feePerByte 1)
data (utf8)          "rewind:lc:1789311303205"
data (hex)           726577696e643a6c633a31373839333131333033323035
data bytes           23 / 64
format               extended
validityStartHeight  11343840 (valid through 11351040)
serializedSize       189 bytes
local verify()       PASS (protocol_version 2, networkId 5)
local tx hash        fb0b3d61ba105a6fa747085b351c3dd55664176559c5c18b7e5dc452f6fb7ae2
round-trip hash      fb0b3d61ba105a6fa747085b351c3dd55664176559c5c18b7e5dc452f6fb7ae2 (MATCH)

--- client.sendTransaction(tx) — light client broadcast, NO JSON-RPC ---
sendTransaction()    returned in 5776 ms
returned hash        fb0b3d61ba105a6fa747085b351c3dd55664176559c5c18b7e5dc452f6fb7ae2 (MATCHES local)
returned state       included
  blockHeight        11343845
  executionResult    true
  confirmations      1
  data (utf8)        "rewind:lc:1789311303205"

--- polling client.getTransaction(hash) until included ---
  poll  1  +2674 ms   not yet: Transaction not found
  poll  2  +5273 ms   not yet: Transaction not found
  ... (polls 3-9 identical) ...
  poll 10  +26419 ms  state=confirmed blockHeight=11343845

SEND GATE: PASS

sender balance after 10999899811 Luna = 109998.99811 NIM
  delta              -100189 Luna (expected -100189)
```

Explorer: <https://test.nimiq.watch/#fb0b3d61ba105a6fa747085b351c3dd55664176559c5c18b7e5dc452f6fb7ae2>

**Independent third-party confirmation** (not the light client, not this code):

```
$ curl https://test-api.nimiq.watch/transaction/fb0b3d61ba105a6fa747085b351c3dd55664176559c5c18b7e5dc452f6fb7ae2
{"block_height":11343845,
 "hash":"fb0b3d61ba105a6fa747085b351c3dd55664176559c5c18b7e5dc452f6fb7ae2",
 "sender_address":"NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH",
 "value":100000,"fee":189,"validity_start_height":11343840,"executed":true,
 "timestamp":1789311313,
 "receiver_address":"NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ",
 "data":"cmV3aW5kOmxjOjE3ODkzMTEzMDMyMDU=","confirmations":223}
```

`cmV3aW5kOmxjOjE3ODkzMTEzMDMyMDU=` base64-decodes to `rewind:lc:1789311303205`. The balance
delta of exactly −100189 Luna matches value + fee to the Luna.

Two things worth carrying forward:

1. **`sendTransaction()` blocks until inclusion.** It returned after 5.8 s already carrying
   `state: "included"`, `blockHeight`, and `executionResult: true`. It is not fire-and-forget,
   and the separate polling loop in `send.mjs` was redundant. Budget for a call that can sit
   for the better part of a block.
2. The `send.mjs` fee-convergence loop and the Windows `process.exit` caveat are both carried
   over from `spikes/server-tx/build-tx.mjs`. The exit caveat still applies: the WASM worker
   thread keeps the event loop alive forever, so the process never exits on its own. All output
   is flushed before the hard `process.exit()`, so nothing is hidden.

---

## 6. `getTransaction` reports "Transaction not found" for transactions that exist

This is the finding that matters most for Rewind and it is not a timing curiosity.

`server/domain/ports.ts` requires `ChainReader.getTransactionByHash` to return **`null`** for
"the chain has never seen this hash" and to **throw `ChainUnavailableError`** for "we could not
find out". The comment in that file is explicit that this distinction is what keeps the API
returning 503 rather than a false mismatch.

The light client collapses both into a throw — **and its throw for a real, already-mined
transaction carries the message `"Transaction not found"`.** From `runs/send-1.txt`:

- t=0: `sendTransaction()` returns `state:"included"`, `blockHeight:11343845`.
- t=+2.7 s through t=+23.8 s: nine consecutive `getTransaction(<that same hash>)` calls throw
  `Transaction not found`.
- t=+26.4 s: the same call finally returns `state:"confirmed"`.

So for ~24 seconds the client actively asserted that a transaction it had itself just broadcast
and reported as included did not exist. Any adapter mapping that string to `null` would tell
Rewind that a real, mined payment never happened — the single worst answer this system can
give.

**Consequence:** treat every throw as `CHAIN_UNAVAILABLE`, never as `null`. Absence must be
decided by the caller's own validity-window timeout, not by the client's error string. This is
encoded in `chain-reader-lightclient.mjs`, where the not-found heuristic is present but off by
default and annotated to be deleted rather than fixed.

Reproduced live by the sketch's own demo (`runs/chain-reader-demo.txt`), on a hash of 64 zeroes:

```
unknown hash -> THREW ChainUnavailableError: Transaction not found
   ^ this is the semantic gap: indistinguishable from a peer failure.
```

### Other `ChainReader` mismatches

| domain `RpcTransaction` | light client `PlainTransactionDetails` |
|---|---|
| `hash` | `transactionHash` |
| `blockNumber` | `blockHeight` — `undefined` while pending, not `null` |
| `from` / `to` | `sender` / `recipient` |
| `recipientData` (hex string) | `data.raw` — `data` is an object `{type:'raw', raw:'…'}` |
| `executionResult` (boolean) | `executionResult` — **`undefined` until included**; must not be coerced to `false` |
| `networkId` (number 5/24) | `network` — a **string**, `'testalbatross'`/`'mainalbatross'` |
| *(absent)* | `state`: `new\|pending\|included\|confirmed\|invalidated\|expired` |

`state` is strictly more information than the RPC gives; `invalidated` and `expired` are answers
the RPC path can only infer from a timeout. Worth adding to `RpcTransaction` if this adapter is
adopted.

Two more signature differences:

- `getTransactionsByAddress` takes a **`minPeers`** argument with no RPC equivalent. Below that
  many peers it **throws** rather than returning a short answer — a new failure mode, and one
  that must map to `ChainUnavailableError`, never to an empty list. An empty list would read as
  "this address has no transactions".
- Unlike the RPC, the returned transactions are **verified against the chain proof** by the
  client before being returned. That is the actual argument for this path being a trustworthy
  fallback rather than merely a second opinion.

### Reliability

`getTransactionsByAddress` failed **1 call in 27**: `testnet-2`, after 3 ms, `Outbound error:
Couldn't send request`. Broken down — 1 failure in 11 cold calls (5 testnet, 6 mainnet), 0
failures in 16 warm calls (8 + 8). The single failure was on a cold client, which is weak
evidence that the risk concentrates right after consensus, on too few samples to claim it.
Non-fatal peer errors were logged in several other runs and recovered:

```
ERROR consensus_proxy | There was an error requesting transaction proof from peer … error=Inbound error: No receiver for request
```

Budget for retries on the history path. A single call is not reliable.

---

## 7. Vercel serverless: **no** for this app, and here is the arithmetic

### What the platform allows (Vercel docs, fetched 2026-09-13)

| | |
|---|---|
| Max duration | Hobby 300 s default and max; Pro/Ent 300 s default, 800 s max |
| Max memory | Hobby 2 GB, Pro/Ent 4 GB |
| Bundle size, uncompressed | 250 MB (5 GB with the large-functions beta) |

So the **platform ceiling is not the blocker.** The blockers are these:

**1. The app's own budget is 15 seconds.** `vercel.json` in the repo root sets
`"maxDuration": 15` for `api/**/*.ts`. Measured mainnet cold consensus was 8.4–32.1 s. Two of
six runs would have hit `FUNCTION_INVOCATION_TIMEOUT` before consensus, before a single byte of
answer. Raising `maxDuration` fixes the timeout and not the latency: a user-facing endpoint that
sometimes takes 32 s to start working is not a fallback, it is an outage with extra steps.

**2. Nothing can be cached between invocations.** The client logs its storage as `Volatile`
under Node:

```
consensus: ConsensusConfig { sync_mode: Pico, min_peers: 3, … }, network_id: TestAlbatross, storage: Volatile
```

There is no IndexedDB in Node, and the client says so loudly on every boot
(`bls_cache | idb: Couldn't create database`, `couldn't load keys from idb`, `can't store keys
in idb`). Every cold instance re-syncs from zero. A frozen Fluid instance's WebSockets are dead
on thaw and consensus must be re-established.

**3. The cost model punishes it.** Vercel bills provisioned memory time. Consensus is 5–32 s of
a ~166 MB-peak process sitting mostly idle on I/O. Active-CPU billing spares you the idle CPU,
but the provisioned-memory clock runs the whole time, on every cold invocation, to answer one
read that the RPC answers in tens of milliseconds.

**4. `min_peers: 3`.** A pico node needs three peers before it will call consensus established.
A function instance starts with none.

### What is *not* a blocker

- **No native module is needed.** `@nimiq/core` depends on `websocket`, which pulls optional
  native `bufferutil` and `utf-8-validate` — but `nodejs/worker.mjs` only installs that polyfill
  when `global.WebSocket` is missing, which on Node ≥ 22 it is not. The string
  `Polyfilling WebSocket` appears **0 times in all 11 run logs**. Node's own built-in WebSocket
  is what got used. (Both optional packages do ship `linux-x64` prebuilds anyway.)
- **Transport is plain outbound WebSocket over TCP.** libp2p's `websocket-websys` transport,
  through the browser `WebSocket` API. Observed peer multiaddrs look like
  `/ip4/5.161.205.204/tcp/8444/ws`. **No WebRTC** — the string `webrtc` appears 0 times in all
  11 run logs. No inbound listener is opened (`listen_addresses: []`), so no inbound
  connectivity is needed. Outbound WebSocket from a function is fine.
- **Size.** `@nimiq/core` unpacks to 28 MB (worker WASM 7.7 MB, main WASM 1.1 MB) against a
  250 MB limit.
- **Memory.** 166 MB peak against a 2 GB floor.

### Verdict

**No** as a per-invocation serverless read path for Rewind, at the app's current
`maxDuration: 15` and for anything user-facing.

**With conditions**, it could run as a Vercel *background* job — a cron or queue consumer with
`maxDuration` raised well above 60 s, doing a batch of reads per boot so the 5–32 s consensus is
amortised over many transactions instead of one. That is a different architecture from a
`ChainReader` fallback and it should be argued on its own merits, not smuggled in as one.

**Yes** in a long-lived process — a container, a VM, `vercel dev`, a small always-on worker.
Boot once, keep one client, share it. `getHeadHeight` then costs ~1 ms and `getAccount` ~0.6 s.
This is the only shape in which the light client is a genuine RPC fallback, and it is why
`LightClientChainReader` in the sketch takes an already-consensed client and refuses to boot one
itself.

### As a `ChainReader` fallback specifically

Workable, in a long-lived process, **if** three things are done first:

1. Every throw maps to `ChainUnavailableError`. Never `null`. §6.
2. `getTransactionsByAddress` gets a retry — 1 call in 27 failed outright, and it also carries a
   `minPeers` throw the RPC path has no equivalent for.
3. `networkId` is remapped from the client's string to the domain's number, and
   `executionResult: undefined` is not coerced to `false`.

`withLightClientFallback(rpcReader, lightReader)` in the sketch shows the wiring. Note that it
deliberately does **not** boot a client on demand: adding 5–32 s to a request that is already
failing makes the outage worse, not better.

---

## 8. Files

| file | what it does |
|---|---|
| `gen-key.mjs` | Generates a testnet burner, writes `.env.local` (mode 600, `O_EXCL`, refuses to overwrite), prints only the address |
| `faucet.mjs` | `GET /info` + `POST /tapit` against the public testnet faucet |
| `sync.mjs` | The measurement harness. `--network testnet\|mainnet`, prints a `RESULT {...}` JSON line |
| `send.mjs` | Build → sign → `verify()` → `sendTransaction` → poll. Testnet only, networkId re-checked against the live client before signing |
| `warm.mjs` | Boot once, then repeated reads, to measure the warm path |
| `chain-reader-lightclient.mjs` | The `ChainReader` sketch. `--demo --network testnet` runs it for real |
| `runs/` | Raw output of every run cited above |
| `.env.local` | **gitignored.** The burner private key. Never printed by any script |

Secret hygiene, checked: `git check-ignore` confirms `.env.local` is ignored via this folder's
own `.gitignore`; `git status` shows the folder untracked and nothing staged; and grepping the
64-char key against `README.md`, every `.mjs`, and all of `runs/` returns **no match** — it
exists only in `.env.local`. Caveat: `gen-key.mjs` requests mode `0600`, but on Windows the file
lands as `644` — the POSIX mode bits are not enforced here.

`.gitignore` in this folder covers `.env.local` and `node_modules/`. Nothing here has been
committed.

### Faucet request format (observed 2026-09-13)

```
GET https://faucet.pos.nimiq-testnet.com/info
-> {"network":"test","address":"NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ",
    "balance":875480223.943,"dispenseAmount":110000,"dispensesRemaining":7958,
    "availableInRegion":true}

POST https://faucet.pos.nimiq-testnet.com/tapit
Content-Type: application/x-www-form-urlencoded
address=NQ17+XYLE+5FBG+M0A2+Q7TC+Y82U+A7M6+AS0D+G6VH
-> 200 {"success":true,"msg":"Your NIM are on it's way!","expectedBlocks":1}
```

Note: `dispenseAmount` is **110000 NIM**, not the 10,000 the docs page states. The `amount`
parameter documented on the page was **not** used or tested. The payout landed in one block
(tx `e6c108b9…`, block 11343081).

---

## 9. Owner steps for a testnet rehearsal on the phone

**UNVERIFIED — from the Nimiq docs, not observed on a device by this spike.** No phone was
touched here.

1. Open Nimiq Pay on the Android phone.
2. **Long-press the settings icon for ~10 seconds** to reveal the hidden developer menu.
3. Switch the network to **testnet**.
4. Use **"Get free NIM"**, which the docs say dispenses **110,000 testnet NIM**.
5. The burner address funded by this spike is `NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH`
   and had **109,998.99811 NIM** after the send; the testnet faucet
   (`NQ37 7C3V VMN8 FRPN FXS9 PLAG JMRE 8SC6 KUSQ`) can top it up again with `node faucet.mjs`,
   with no rate limit per its own `/info`.
6. Verify anything the phone does at <https://test.nimiq.watch>.

Switching Nimiq Pay to testnet has **not** been done, and whether a mini app is served the
testnet network id in that mode is **not known**.

---

## 10. What is unverified, skipped, or assumed

- **Nothing was run on Vercel.** The serverless verdict is arithmetic over locally measured
  timings and Vercel's published limits, not an observed deployment. In particular, whether
  `@vercel/nft` correctly traces the worker entrypoint — `new Worker(new URL('./worker.mjs',
  import.meta.url))` — and the two `.wasm` files into a function bundle is **untested and is a
  real deployment risk**.
- **No mainnet transaction, no mainnet key.** Mainnet was read-only. `send.mjs` hard-codes
  networkId 5 and re-checks the live client before signing.
- **Timings are from one machine, one residential connection, one afternoon (IST).** Six
  mainnet samples is enough to show the spread is large; it is not enough to characterise the
  tail, and a Vercel region would have different network conditions.
- **`syncMode` was never overridden.** All runs used the default `pico`. `light` is selectable
  and was not measured; it may have different cold-start behaviour.
- **`addTransactionListener` was not exercised.** For Rewind's polling replacement this is the
  interesting call and it is untested.
- **The `--amount` faucet parameter** was not used. Only the default dispense was tested.
- **The Nimiq Pay dev-menu steps in §9 are from docs only.**
- **`getTransaction`'s error strings were not enumerated.** "Transaction not found" was observed
  both for a genuinely absent hash and for a real included transaction; no other error message
  was catalogued, which is exactly why the not-found heuristic is off.
- **`chain-reader-lightclient.mjs` is a sketch.** It has no tests, is not wired into `server/`,
  and its `#cached` map has no eviction.
- **The `getTransactionsByAddress` failure rate** is 1 in 27 calls. That establishes the call
  can fail; it does not establish a rate, and 27 samples cannot distinguish a cold-client
  effect from chance.
- **The `warm.mjs` reads all hit the same two addresses**, so peer-side caching may flatter the
  warm numbers. `getHeadHeight` is unaffected — it never leaves the process.
