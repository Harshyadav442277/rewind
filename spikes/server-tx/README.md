# Rewind spike — server-side Nimiq mainnet transaction (gate N12)

Proves that a plain Node process can build, sign, serialise and round-trip a Nimiq **mainnet**
basic-with-data transaction with `@nimiq/core@2.21.0`, and packages the exact broadcast +
confirmation path so the owner can run the one funded step.

**Nothing has been broadcast. No wallet has been funded. No key in this folder has ever held value.**
Everything below marked "observed" was run on this machine on 2026-09-13; everything marked
UNVERIFIED has not.

---

## 1. What is proven, and what is not

| Claim | Evidence | Status |
|---|---|---|
| `@nimiq/core@2.21.0` imports in Node 24.19.0 ESM on Windows, WASM loads synchronously, no `init()` | §2 | **observed** |
| Mainnet Albatross network id is `24` | §3 | **observed**, two independent ways |
| A basic-with-data transaction builds, signs, passes `verify()` and serialises | §6 dry-run | **observed** |
| The serialised hex decodes back to identical fields (24/24 comparisons, both decode paths) | §6 dry-run | **observed** |
| `sendRawTransaction` takes exactly 1 param, a raw-tx hex string | §4 | **observed** (arity probe + source) |
| `getTransactionByHash` takes exactly 1 param, a hash string, and returns `executionResult` + `recipientData` | §4 | **observed** on a real mainnet tx |
| `getMinFeePerByte` is 0 right now | §5 | **observed** 2026-09-13T07:43:56Z |
| Explorer URL format `https://nimiq.watch/#<txhash>` renders a transaction page | §4 | **observed** in a real browser |
| A transaction **built by this script** is accepted by the mempool and included in a block | — | **UNVERIFIED — this is the funded run in §7** |
| The 64-byte data field survives the chain and reads back through `getTransactionByHash` | — | **UNVERIFIED for a tx we built** (observed on someone else's staking tx) |
| Anything at all about Nimiq Pay, the mini-app runtime, or the wallet | — | **out of scope, untouched** |

---

## 2. Install and import (observed)

```
npm init -y            # package.json then set "type": "module"
npm install @nimiq/core@2.21.0
```

The working import is the bare package specifier, from an **ESM** file (`.mjs`, or `"type":"module"`):

```js
import { KeyPair, PrivateKey, Address, Transaction, TransactionBuilder, Policy } from '@nimiq/core';
```

`package.json` `exports["."].node.import` resolves to `./nodejs/index.mjs`.

Observed behaviour on Node **v24.19.0**, npm 11.13.0, Windows 11:

- **No `init()` and no `await` are needed.** The WASM is loaded synchronously by the module body.
  Cold import measured at **102 ms**.
- 36 packages installed, 0 vulnerabilities. One deprecation warning (`yaeti`, a transitive
  dependency of `websocket`), harmless for this use.
- Named exports available: `AccountType, Address, ArrayUtils, BLSKeyPair, BLSPublicKey, BLSSecretKey,
  BufferUtils, Client, ClientConfiguration, Commitment, CommitmentPair, CryptoUtils, ES256PublicKey,
  ES256Signature, Entropy, ExtendedPrivateKey, Hash, HashedTimeLockedContract, KeyPair, MerklePath,
  MerkleTree, MnemonicUtils, NumberUtils, PartialSignature, Policy, PrivateKey, PublicKey,
  RandomSecret, Secret, SerialBuffer, Signature, SignatureProof, StakingContract, StakingDataBuilder,
  StringUtils, Transaction, TransactionBuilder, TransactionFlag, TransactionFormat, VestingContract`
  (plus a `module.exports` CJS-interop artifact — ignore it).
- **We never construct `Client`.** Key handling and transaction building are pure WASM calls; only
  `Client` spawns worker threads and opens network sockets. That is why this spike needs no node,
  no consensus and no sync.

### Windows caveat you must not lose

Calling `process.exit()` while `@nimiq/core`'s WASM objects are still live aborts the process:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

with exit code **127**, *after* all the real output has already printed — so a successful run looks
like a crash. Reproduced deterministically here. `import` + `KeyPair.generate()` + `process.exit()`
alone does **not** reproduce it; the full build/sign/round-trip path does. Every script in this
folder therefore sets `process.exitCode` and lets the event loop drain. Do the same in the app.

---

## 3. Network id (observed, two ways)

`TransactionBuilder` takes `network_id` as a bare number. There is no exported `NetworkId` enum in
`@nimiq/core@2.21.0`'s type definitions, so the value was pinned empirically:

| network_id | `tx.toPlain().network` | `tx.verify(2, id)` |
|---|---|---|
| 1 / 2 / 3 / 4 | test / dev / bounty / dummy | throws (pre-Albatross format) |
| 5 / 6 / 7 | testalbatross / devalbatross / unitalbatross | OK |
| **24** | **mainalbatross** | **OK** |
| 42 | main | throws (pre-Albatross) |
| 23, 25, 8 | — | `Error: Unknown network ID` at build time |

Cross-checked against the chain: the real mainnet transaction
`90fca75b3a3bc3e35c0d8e74144df323e12c80914b497c51aa78f2fb1ede7616` returns `"networkId": 24` from
`getTransactionByHash`. **Mainnet = 24.** (Testnet Albatross = 5, if a testnet rehearsal is ever wanted.)

Other constants read straight off `Policy` (not from memory):
`GENESIS_BLOCK_NUMBER = 3456000`, `BLOCKS_PER_BATCH = 60`,
`TRANSACTION_VALIDITY_WINDOW_BLOCKS = 7200`, `TRANSACTION_VALIDITY_WINDOW = 120` (batches),
`MAX_SUPPORTED_VERSION = 2`.

---

## 4. RPC shapes confirmed

Endpoint `https://rpc.nimiqwatch.com`, JSON-RPC 2.0 over POST. Envelope (unchanged from the E0
evidence file): `{"jsonrpc":"2.0","result":{"data":<value>,"metadata":<obj|null>},"id":N}`.

**Source 1 — the `rpc-interface` crate** (`nimiq/core-rs-albatross`, branch `albatross`), verbatim:

```rust
// rpc-interface/src/consensus.rs
async fn send_raw_transaction(&self, raw_tx: String) -> RPCResult<Blake2bHash, (), Self::Error>;

// rpc-interface/src/mempool.rs
async fn push_transaction(&self, raw_tx: String) -> RPCResult<Blake2bHash, (), Self::Error>;
async fn push_high_priority_transaction(&self, raw_tx: String) -> RPCResult<Blake2bHash, (), Self::Error>;
async fn get_min_fee_per_byte(&self) -> RPCResult<f64, (), Self::Error>;

// rpc-interface/src/blockchain.rs
async fn get_transaction_by_hash(&self, hash: Blake2bHash) -> RPCResult<ExecutedTransaction, (), Self::Error>;
async fn get_account_by_address(&self, address: Address) -> RPCResult<Account, BlockchainState, Self::Error>;
async fn get_transactions_by_address(&self, address: Address, max: Option<u16>, start_at: Option<Blake2bHash>)
    -> RPCResult<Vec<ExecutedTransaction>, (), Self::Error>;
```

**Source 2 — live arity probes against the endpoint** (empty `params`, so nothing was submitted).
Observed 2026-09-13T07:43:56Z:

```
sendRawTransaction    -> -32602 "invalid length 0, expected struct ServiceArgs_ConsensusDispatcher_send_raw_transaction with 1 element"
pushTransaction       -> -32602 "invalid length 0, expected struct ServiceArgs_MempoolDispatcher_push_transaction with 1 element"
getTransactionByHash  -> -32602 "invalid length 0, expected struct ServiceArgs_BlockchainDispatcher_get_transaction_by_hash with 1 element"
```

So: `params: ["<raw tx hex>"]` and `params: ["<hash hex>"]`. Both return the tx hash / the tx object
under `result.data`.

**`sendRawTransaction` vs `pushTransaction`** — the migration guide states `sendRawTransaction`
"doesn't push to the local mempool, it only broadcasts the transaction to all peers." `pushTransaction`
puts it in the node's own mempool, so it validates locally and returns a useful error for a malformed
or unfunded transaction. `build-tx.mjs` uses `sendRawTransaction` as specified; `pushTransaction` is
exported from `rpc.mjs` as the fallback to try if `sendRawTransaction` returns a hash but nothing ever
confirms. **UNVERIFIED: which of the two this particular public node actually accepts from an
anonymous caller.**

**`getTransactionByHash` on a real mainnet transaction** — full observed payload
(2026-09-13T07:43:58Z), which is exactly what the poller reads:

```json
{"hash":"90fca75b3a3bc3e35c0d8e74144df323e12c80914b497c51aa78f2fb1ede7616",
 "blockNumber":61420752,"timestamp":1789229039990,"confirmations":56911,"size":187,
 "from":"NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M","fromType":0,
 "to":"NQ77 0000 0000 0000 0000 0000 0000 0000 0001","toType":3,
 "value":1565,"fee":0,"senderData":"","recipientData":"0620ab2a68a72e2d86cd45134bd9815703f2742ad6",
 "flags":0,"validityStartHeight":61420752,"proof":"008e2126...","networkId":24,"executionResult":true}
```

The data field arrives as **`recipientData`, hex-encoded** — not `data`, not utf8. Decode with
`Buffer.from(details.recipientData, 'hex').toString('utf8')`.

**Unknown hash is an error, not a null.** Observed 2026-09-13T07:45:08Z:

```
{"code":-32603,"message":"Internal error","data":"Transaction not found: 0000...0000"}
```

The poller must treat `-32603 / "Transaction not found"` as *still pending* and keep going. Anything
else is a real failure. `rpc.mjs` exports `isNotFound(err)` for exactly this.

**`getAccountByAddress`** returns `{data:{address,balance,type}, metadata:{blockNumber,blockHash}}`;
`balance` is in Luna. An unfunded address is not an error — it returns `balance: 0, type: "basic"`.

**Explorer.** `https://nimiq.watch/#<txhash>` was loaded in a real browser on 2026-09-13 and rendered
`TRANSACTION INFO` with hash, sender, recipient, date, block number, value, fee, **Message** (the data
field), validity start height and confirmations. That is the correct current format and it is what the
scripts print. (`nimiq.watch` is a client-side SPA — `curl` on the fragment URL returns the shell, so
verify it in a browser, not with curl.)

---

## 5. Live chain readings (observed)

| Reading | Value | Timestamp (UTC) |
|---|---|---|
| `getBlockNumber` | 61,477,660 | 2026-09-13T07:43:55.522Z |
| `getMinFeePerByte` | `0` | 2026-09-13T07:43:56.153Z |
| `getBlockNumber` (later, same session) | 61,478,096 | 2026-09-13T07:51:07Z |

Consistent with the E0 evidence (61,420,705 at 2026-09-12T16:03Z) and with ~1 s blocks:
57,391 blocks over 15 h 47 m ≈ 1.01 s/block.

Rate limit on this endpoint is 20 tokens per 10 s per IP, and the operator says "Uptime is not
guaranteed." The 2 s poll interval in `build-tx.mjs` is well inside that.

### The fee, and why

**Default: 1 Luna per *signed* serialised byte.** For the dry-run below that is 195 Luna
(0.00195 NIM); for a full 64-byte data field, 230 Luna (0.0023 NIM).

Reasoning:

1. `getMinFeePerByte` returns `0`, and the E0 evidence has a real mainnet transaction with `fee: 0`
   that was included. Zero would very likely work.
2. But that is a **mempool policy**, not a consensus rule, and it can change under load with no
   notice. A run that stalls at the gate costs far more than 0.0023 NIM.
3. 1 Luna/byte is the smallest non-zero integer rate, and it puts the transaction strictly above
   every zero-fee transaction in any fee-ordered mempool. It is 0.0023 NIM at the worst case — three
   ten-thousandths of one percent of a 5 NIM float.

**The size must be measured on the *signed* transaction.** An unsigned transaction has an empty
proof and is ~98 bytes smaller; sizing the fee before signing under-pays by about half (a first cut
of this script produced 97 Luna for a 195-byte transaction, `feePerByte 0.497`). `chooseFee()` signs
a probe, measures, sets the fee, and re-measures to convergence. The fee value itself does not change
the size — it is a fixed-width u64 — which the loop asserts rather than assumes.

Override with `--fee-per-byte 0` (free, if you want to test mempool policy) or `--fee <luna>`.

### Observed transaction sizes

| data field | format | signed serialised size |
|---|---|---|
| 0 bytes | basic | 139 bytes |
| 10 bytes | extended | 176 bytes |
| 29 bytes | extended | 195 bytes |
| 64 bytes | extended | 230 bytes |

Any non-empty data field makes the transaction **extended**, not basic. Both are ordinary transfers
to a basic account; only the encoding differs.

### Validity rules `verify()` actually enforces (observed)

`tx.verify(Policy.MAX_SUPPORTED_VERSION, 24)` throws on all of these. `build-tx.mjs` calls it before
printing anything, so a bad transaction never reaches the broadcast path:

| Condition | Message |
|---|---|
| data field 65+ bytes | `Error: Overflow` |
| sender == recipient | `Error: Sender same as recipient` |
| value == 0 | `Error: The value must be zero for signaling transactions and cannot be zero for others.` |

**Trap:** `TransactionBuilder.newBasicWithData` **does not** enforce the 64-byte limit — it happily
builds a 65- or 100-byte data field and only `verify()` (or the network) rejects it. Any app code
that skips `verify()` will construct transactions that silently fail on chain. `build-tx.mjs` also
checks the byte length up front so the error is legible.

---

## 6. Dry run — verbatim output

Run on 2026-09-13 with an **ephemeral in-memory key that was never written to disk and holds nothing**.
No `sendRawTransaction` call was made.

```
$ node build-tx.mjs --ephemeral --to "NQ04 E0AE 1VAY JEFV ULN0 63H2 KM9Y H9FR 2EAX" \
      --luna 100000 --data "rewind:v1:8f3a2c1d:2026-09-13"

=== rewind spike N12 — build-tx ===
built at             2026-09-13T07:51:07.938Z
rpc                  https://rpc.nimiqwatch.com
network              mainalbatross (networkId 24)
chain head           61478096
getMinFeePerByte     0
key source           EPHEMERAL (in-memory, not persisted)

sender               NQ76 03N6 6VJA MLNN KPJ4 U16P ATVU T5TA 4RHS
recipient            NQ04 E0AE 1VAY JEFV ULN0 63H2 KM9Y H9FR 2EAX
value                100000 Luna  =  1.00000 NIM
fee                  195 Luna  (1 Luna/byte), feePerByte 1
data (utf8)          "rewind:v1:8f3a2c1d:2026-09-13"
data (hex)           726577696e643a76313a38663361326331643a323032362d30392d3133
data bytes           29 / 64
format               extended (TransactionFormat 1)
validityStartHeight  61478096  (valid through 61485296)
serializedSize       195 bytes
tx hash              740648e524b8dc13615b37d2aa9250e5f5f8d3623dfd8ee540dae83c6ac082d7
explorer             https://nimiq.watch/#740648e524b8dc13615b37d2aa9250e5f5f8d3623dfd8ee540dae83c6ac082d7

raw hex (sendRawTransaction param):
0100ec63764aad2d69de44e04d756fbcd976a2663a00007014e0f55f939fde52c030e229d53f8a5f91395e001d726577696e643a76313a38663361326331643a323032362d30392d313300000000000186a000000000000000c303aa14d018006200c6d8d5783bd28492ff089ca893e0b93406f675b8b1f45a46d57db86c6d0c600400f784e29dd0d045993168fb4c010f2acb95bd66750fdd7843aaa4e8853715ccbfac7ae7e4607ba6d73175a659e79e754e5fd23bb40241f12ae3feff1731d29b0b

round-trip           PASS (24/24 field comparisons)
local verify()       PASS (protocol_version 2, networkId 24)

DRY RUN — sendRawTransaction was NOT called. Nothing was broadcast.
Re-run with --broadcast to submit (requires a funded sender).

$ echo $?
0
```

The round-trip decodes the hex **two** ways — `Transaction.deserialize(tx.serialize())` and
`Transaction.fromAny(hex)` — and compares 12 fields each (hash, sender, recipient, value, fee,
validityStartHeight, networkId, data as hex, data as utf8, proof, serializedSize, and the re-encoded
hex). 24/24 identical. This is the part of the sign-and-serialise path the funded run does not need
to re-prove.

Error paths, all exercised and all exiting 2 before any network write:

```
--data 65 bytes            ERROR: --data is 65 UTF-8 bytes; the data field allows 64
--to == sender             ERROR: sender and recipient are the same address; mainnet rejects that
--ephemeral --broadcast    ERROR: --ephemeral is dry-run only; an ephemeral key holds no funds
missing key file           ERROR: no key. <path> does not exist. Run "node gen-key.mjs" first...
gen-key over existing file REFUSING TO OVERWRITE: <path> already exists.
```

---

## 7. The funded run — owner steps

You run all of this. I have not funded anything and will not.

**Before you start:** decide the two addresses. You need a **treasury** address (the sender, created
in step 1) and a **destination** address you also control (your own Nimiq wallet is fine). They must
be different.

### 1. Generate the treasury key

```
cd C:\Users\hyada\dev\rewind\spikes\server-tx
node gen-key.mjs
```

Prints **only** the new address. Writes `REWIND_TREASURY_PRIVATE_KEY=<hex>` to `.env.local` in this
folder. `.env.local` and `node_modules/` are in `.gitignore` here. The script refuses to overwrite an
existing `.env.local`.

This is a **burner**. It is a mainnet key sitting in a plaintext file on a dev machine. Put in ~5 NIM,
never more, never reuse it, and log it in the project's wallet register with its purpose and date.

### 2. Fund it

Send about **5 NIM** from your own wallet to the address step 1 printed. 5 NIM covers the gate
transaction plus retries with a wide margin (the transaction itself costs 1 NIM + 0.0023 NIM fee, and
the 1 NIM goes to an address you also own, so the only real cost is the fee).

### 3. Confirm the money arrived

```
node check-balance.mjs "NQxx XXXX XXXX ..."     # the address from step 1
```

Expect `balance 500000 Luna = 5.00000 NIM`. Do not go on until you see it.

### 4. Dry run against the real key first

```
node build-tx.mjs --to "<YOUR SECOND ADDRESS>" --luna 100000 --data "rewind:n12:<anything, <=64 bytes>"
```

Still sends nothing. Check the printed `sender` matches step 1's address and `recipient` matches your
second address.

### 5. Broadcast

```
node build-tx.mjs --to "<YOUR SECOND ADDRESS>" --luna 100000 --data "rewind:n12:<same string>" --broadcast
```

It calls `sendRawTransaction`, compares the hash the node returns against the locally computed hash,
then polls `getTransactionByHash` every 2 s for up to 90 s (`--timeout` to change), printing a dot per
poll while the node reports "Transaction not found".

### 6. Paste back

- The **entire terminal output** of step 5, from `=== rewind spike N12` to the last line.
- The `nimiq.watch` link, and whether the page shows your data string under **Message**.
- If it did not confirm in 90 s: the tx hash, and what `node -e` / the explorer shows a few minutes
  later. The transaction stays valid for 7,200 blocks (~2 h) from `validityStartHeight`, so it is not
  dead just because the poll window closed.

### PASS criteria for gate N12

All four, or it is not a pass:

1. `sendRawTransaction` returns a hash and it **equals** the locally computed `tx hash`.
2. `getTransactionByHash` returns the transaction with a **`blockNumber`** (it is in a block).
3. **`executionResult: true`**.
4. **`recipientData` hex-decodes to exactly the `--data` string that was sent** — the script prints
   `data round-trips YES`.

The script prints `GATE N12: PASS` only when 3 and 4 both hold, and exits non-zero otherwise.

---

## 8. Files

| File | What it does |
|---|---|
| `rpc.mjs` | JSON-RPC client. Unwraps `result.data`, raises `RpcError` with code/message/data, exports `isNotFound()`. Method signatures cited inline. |
| `gen-key.mjs` | Fresh keypair → `.env.local` (mode 600, `O_EXCL`). Prints only the address. Refuses to overwrite. |
| `build-tx.mjs` | Build, sign, `verify()`, serialise, round-trip; `--broadcast` to send and poll. Default dry-run. |
| `check-balance.mjs` | `getAccountByAddress` → Luna and NIM, with the block it was read at. |
| `.gitignore` | `.env.local`, `node_modules/` |

`.env.local` does not exist yet — nothing in this folder holds a key.

---

## 9. Unverified — read this before quoting any of the above

1. **No transaction built by this code has ever been broadcast.** The mempool has never seen one.
   Everything about acceptance, inclusion, `executionResult` and data round-tripping *for our own
   transaction* is an expectation, not a result. That is the whole point of §7.
2. **Which write method the public node honours.** The `sendRawTransaction` arity is confirmed, but
   the endpoint has never been asked to accept a real transaction from us. It may rate-limit, reject
   anonymous writes, or accept and not propagate. `pushTransaction` is the fallback and is equally
   untested.
3. **Whether 1 Luna/byte is enough under load.** Observed min fee is 0 today; that is not a promise.
4. **Confirmation latency.** 90 s is a guess based on ~1 s blocks and 60-block batches. The history
   index behind `getTransactionByHash` may lag block production by an unknown amount — the E0 note
   says mempool transactions are not discoverable through it at all, so there may be a window where
   the transaction is broadcast, valid, and still "not found".
5. **`validityStartHeight = current head`.** If the node's head is ahead of what the network accepts,
   or the transaction sits unbroadcast past 7,200 blocks, it expires. Not exercised.
6. **Nothing about Nimiq Pay.** No mini-app runtime, no wallet dialog, no provider, no signature
   request, no deep link, no catalog. This spike is a *server* holding its own key — it does not test
   the path where the user's wallet signs. If Rewind needs user-signed transfers, that is a different
   gate on a different surface.
7. **One endpoint, one machine, one moment.** `rpc.nimiqwatch.com` is a single public history node
   whose operator states "Uptime is not guaranteed". No second endpoint was tried.
8. **Windows only.** Everything was observed on Windows 11 / Node 24.19.0. The `process.exit()`
   libuv abort is a Windows-specific symptom; the Linux/serverless behaviour of this package (which
   is what a deployed Rewind backend would run on) is untested.
9. **`--key <hex>` puts a private key in the process argument list**, where it is visible to other
   processes and to shell history. It exists for scripted use; prefer `.env.local`.
10. **No testnet rehearsal was run.** Testnet Albatross is network id 5 and `test.nimiq.watch` exists,
    so a free rehearsal is available if the owner would rather not spend mainnet NIM first.
