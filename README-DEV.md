# Rewind — developer notes

Application skeleton, money-safety core, and the two spike findings folded in.
Written 2026-09-13; crypto and chain adapters landed the same day.

**Read this first: no phone has opened this app, no wallet has ever signed anything for it, and
no database has been provisioned.** What is now real: Ed25519 signature verification, Nimiq
address validation including check digits, the public-RPC reader (exercised against mainnet,
read only), transaction construction and serialisation, and — since the fourth pass on
2026-09-13 — **two complete pay-and-refund loops on Nimiq's TESTNET**, in which a treasury key
signed a real transaction, a light client broadcast it, and `REFUNDED` came from a verified
chain record. That happened locally, on testnet, driven by a script: no phone, no wallet, no
mainnet, no deployment. What is still fake or untested is listed below and the list is not
empty.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 — frontend AND api/, in one process
npm test           # vitest, offline
npm run test:db    # just the Postgres tests, against embedded Postgres
npm run typecheck  # tsc --noEmit
npm run build      # typecheck, then vite build into dist/

RUN_RPC_TESTS=1 npx vitest run server/chain/rpc-chain-reader.integration.test.ts
                   # the only tests that open a socket. Read-only mainnet.

REWIND_NO_EMBEDDED_PG=1 npm test
                   # forces the Postgres suite to skip, which is what a machine without the
                   # embedded engine sees. It prints why and the rest of the suite still runs.
```

```bash
npm run rehearsal:testnet   # the whole app on Nimiq's TESTNET, locally, with free faucet NIM
npm run rehearsal:buyer     # a scripted buyer that walks the loop against it (needs the above)
```

See [Testnet rehearsal](#testnet-rehearsal-the-whole-loop-on-a-phone-with-free-nim) below. It
is dev-only: production is unchanged (public RPC, mainnet), and `REWIND_CHAIN=lightclient` is
refused when `VERCEL_ENV` or `NODE_ENV` is `production`.

`npm run test:db` needs no Docker, no service and no `DATABASE_URL`: the engine is
`@electric-sql/pglite`, a devDependency, which is Postgres compiled to WebAssembly and run
inside the test process. It is part of `npm test` and takes about 0.8 s.

`npm test` runs three groups: the server and API tests in a node environment, and the
frontend tests (`src/**`) in jsdom. `vitest.config.ts` picks the environment per path, so a
server module that reaches for `window` fails in a test rather than in a function.

`vite dev` does not know about `api/`, so `dev-server/dev-api-plugin.ts` mounts the same
handler modules in-process. In production Vercel does that routing itself and the plugin is
never loaded.

With no Nimiq Pay provider present the app uses `FakeWallet`, which drives a server-side fake
chain through `/api/dev/fake-chain`. A banner says so on every screen. That endpoint refuses
to answer when `REWIND_CHAIN=rpc` or `VERCEL_ENV=production`.

---

## Where things are

| Path | What it is |
|---|---|
| `src/` | Vite + React frontend. Five screens, mobile first, 44 px minimum tap targets |
| `src/wallet.ts` | The only place that talks to a wallet. Real provider or `FakeWallet`. Every call returns `ok` / `cancelled` / `error` rather than throwing |
| `src/wallet.test.ts` | 33 tests of the adapter's result mapping against a stubbed `window.nimiq` |
| `src/screens/screens.test.tsx` | 21 jsdom tests, one group per screen |
| `api/health.ts` | Chain reachability, treasury balance, floor and `demoPaused`. The Demo Store reads it |
| `server/domain/` | Framework-free core. No I/O, no crypto, no framework imports |
| `server/domain/states.ts` | The state machine and its two money invariants |
| `server/domain/challenge.ts` | Buyer refund challenge: canonical text, strict parser, strict validator |
| `server/domain/merchant-auth.ts` | Merchant challenge: same shape, bound to one action on one order |
| `server/domain/verify.ts` | The chain acceptance predicates |
| `server/domain/refund-reservation.ts` | Exactly-once reservation, preparation, broadcast, settlement, recovery |
| `server/domain/demo-treasury.ts` | Caps on the Demo Store treasury |
| `server/db/` | Repository port, `InMemoryRepository`, `PostgresRepository`, `schema.sql` |
| `server/db/sql-executor.ts` | The one seam under `PostgresRepository`: `SqlExecutor` (`query(text, params) -> rows`), plus `neonExecutor()` for production. The repository takes either a connection string or an executor |
| `server/db/pglite-executor.ts` | Test-only embedded-Postgres executor. Applies `schema.sql`, truncates between tests, returns `null` when the engine is unavailable |
| `server/db/postgres.integration.test.ts` | 48 tests running the real SQL against a real Postgres engine |
| `server/crypto/nimiq-signature-verifier.ts` | **Real** Ed25519 verification of a Nimiq signed message |
| `server/crypto/nimiq-address.ts` | **Real** address validation via `Address.fromString`, canonical form |
| `server/chain/rpc-chain-reader.ts` | **Real** public-RPC reader: retries, timeouts, not-found-is-pending |
| `server/chain/treasury-broadcaster.ts` | **Real** treasury signer and `pushTransaction` broadcaster. Also the shared `normalizeSerializedTx` / `verifySerializedTx` gate both broadcasters run |
| `server/chain/light-client-chain-reader.ts` | **Real** `@nimiq/core` light-client reader, dev-only. One client per process, testnet seeds set explicitly, every throw is `ChainUnavailableError` |
| `server/chain/light-client-broadcaster.ts` | **Real** broadcast over `client.sendTransaction`, dev-only. Re-verifies the bytes against the configured network first |
| `scripts/` | The two rehearsal scripts. Scripts, not tests: they open sockets and spend testnet NIM |
| `api/` | Vercel serverless handlers, thin, wired in `api/_lib/deps.ts` |
| `api/_lib/merchant-auth.ts` | Joins the merchant challenge to the request, the verifier and the stored nonce |
| `spikes/` | The two spikes. Read only; nothing in `server/` imports from them |

### How a refund is kept to exactly one

1. `refund_executions.order_id` is UNIQUE. Concurrent approvals both attempt the insert and
   the database picks the winner. No read-then-write window.
2. The serialised transaction is attached with a compare-and-set that only fires while there
   is none (`prepareRefundExecution`). Two preparers a block apart would otherwise build two
   different transactions, which is two refunds. `treasury-broadcaster.test.ts` shows exactly
   that: the same key and the same inputs give byte-identical bytes and the same hash, and a
   validity start height one block later gives a different hash.
3. The bytes are stored **before** the broadcast. Recovery re-checks the chain and re-sends
   the same bytes, which is the same transaction. It never builds a second one and never
   re-enters approval.
4. `REFUNDED` is only set from a chain record that satisfies `verifyRefund`.

---

## What the two spikes settled, and what the app now does with it

### Signatures (`spikes/sign-verify` → `server/crypto/nimiq-signature-verifier.ts`)

The preimage is `PREFIX + asciiDecimal(byteLength(message)) + message`, SHA-256'd, then signed
with Ed25519 (core-rs-albatross `wallet/src/wallet_account.rs`). Two prefixes exist in the
keyguard, `"\x16Nimiq Signed Message:\n"` and `"\x19Nimiq Connect Challenge:\n"`, so the
verifier tries both and reports which one matched as `variant`. The length is a **byte** count,
not a character count; there is a test for that specifically.

The spike's Windows/undici teardown workaround (closing undici's global dispatcher through an
undocumented symbol) is **not** in the application. It stays in spike scripts.

### Chain reads and transactions (`spikes/server-tx` → `server/chain/`)

- JSON-RPC 2.0 POST, results wrapped at `result.data`.
- `getTransactionByHash` takes one parameter. An **unknown** hash is a JSON-RPC error
  (`-32603`, `"Transaction not found: <hash>"`), not a null result. That maps to `null`,
  meaning pending. Every other JSON-RPC error maps to `ChainUnavailableError`, not to pending —
  getting this backwards either stalls polling for ever or reports a never-sent transaction.
- `getTransactionsByAddress` takes three parameters, `[address, max, startAt]`.
- The data field comes back hex encoded under `recipientData`; the payment scan decodes it and
  looks for `RW1:P:<orderId>` (`findPaymentByReference` in `order-service.ts`).
- Mainnet `networkId` is `24`.
- `Address.fromString` validates check digits and throws on bad input.
- `TransactionBuilder` does **not** enforce the 64-byte data cap; only `verify()` does. The
  builder checks it itself, before and after.
- Fee: 1 Luna per **signed** byte. The signature proof is ~98 bytes, so the size is measured on
  a signed probe and the fee re-converged.
- Broadcast uses `pushTransaction`, not `sendRawTransaction`, because it validates into the
  mempool.

---

## Testnet rehearsal: the whole loop on a phone, with free NIM

Added 2026-09-13, fourth pass. **Local development only.** Production is exactly as it was:
`REWIND_CHAIN=rpc`, mainnet, the public node. This mode exists so the complete Rewind loop —
pay, prove the wallet, refund, settle — can be walked on a real Android phone in Nimiq Pay's
testnet mode before one Luna of mainnet NIM exists.

### How it works

`REWIND_CHAIN=lightclient` swaps the RPC reader and the RPC broadcaster for an in-process
`@nimiq/core` light client. There is no JSON-RPC anywhere in the path: the client dials the
testnet seed nodes over WebSocket and verifies what it reads against the chain proof.

| File | What it is |
|---|---|
| `server/chain/light-client-chain-reader.ts` | `ChainReader` over the light client. Network and seed selection, the lazy per-process client, the field mapping, and the throw semantics |
| `server/chain/light-client-broadcaster.ts` | `TxBroadcaster` over `client.sendTransaction`. The transaction is still built, signed, fee-converged and `verify()`-gated by `TreasuryTxBuilder`; this file re-verifies the stored bytes against the configured network and sends them |
| `server/chain/light-client-chain-reader.test.ts` | 22 offline tests: the throw mapping, the seed selection, the field mapping. No socket, no WASM |
| `scripts/rehearsal-testnet.mjs` | `npm run rehearsal:testnet`. Key, faucet, balance, then `vite` with the right environment |
| `scripts/rehearsal-buyer.mjs` | `npm run rehearsal:buyer`. A **script**, not a test: it spends testnet NIM and needs the server running |
| `dev-server/dev-api-plugin.ts` | Loads root `.env.local` into `process.env` (vite does not), warms the client at start-up, prints the LAN URL for the phone |

Three decisions in that adapter are worth knowing before trusting it:

1. **A throw is never "absent".** `client.getTransaction(hash)` throws `"Transaction not
   found"` for transactions that exist and are already included — nine consecutive times over
   23.8 s in the spike, for a transaction the same client had just broadcast. So every throw
   maps to `ChainUnavailableError` and absence is decided only by the caller's validity-window
   timeout. The visible cost is real: `POST /api/orders/:id/refund` answers **503** for the
   first half-minute after it broadcasts, and the order settles on a later poll. The refund
   screen now treats a 503 as submitted-but-unconfirmed rather than as a rejection, because
   the signature is consumed before anything reads the chain and re-signing would hit "nonce
   already used".
2. **Payments are found by scanning**, not by hash. `getTransactionsByAddress` works and is
   retried three times (the spike saw 1 call in 27 fail outright); a failure is unavailability,
   never an empty list, because an empty list reads as "this address was never paid".
3. **A half-populated record reads as pending.** `executionResult` is `undefined` until
   inclusion, and the domain treats `executionResult !== true` on a transaction that has a
   block number as `execution_failed`, which is FATAL and reverts the order. So a record with
   a height but no execution result is reported with `blockNumber: null` — the non-fatal
   "keep polling" answer.

### Owner steps, on the phone

**The Nimiq Pay steps are from the docs and are UNVERIFIED — no phone was touched here.**

1. Laptop and phone on the same wifi. Run `npm run rehearsal:testnet` and read the URL it
   prints (`http://<laptop-lan-ip>:5173`, or whatever port vite actually bound — it walks
   forward if 5173 is busy, and the plugin prints the real one).
2. Open Nimiq Pay. **Long-press the settings icon for about 10 seconds** to reveal the hidden
   developer menu.
3. Switch the network to **testnet**.
4. Use **"Get free NIM"**. The docs say it dispenses **110,000 testnet NIM** (the faucet's own
   `/info` agrees: `dispenseAmount 110000`).
5. **Mini Apps → Custom URL**, and type the LAN URL from step 1.
6. Check anything the phone does at <https://test.nimiq.watch>.

Unknown, and it is the first thing the phone run will settle: **whether Nimiq Pay accepts a
plain `http://` custom URL at all**, and whether a mini app is served the testnet network id in
that mode. If http is refused, the fallback is a TLS tunnel to the dev server, which nothing
here sets up.

### What the rehearsal proved on this machine

Two full end-to-end runs on **Nimiq PoS testnet**, 2026-09-13, driven by
`scripts/rehearsal-buyer.mjs` against `npm run rehearsal:testnet`. Both hashes below are
confirmed by **test-api.nimiq.watch**, which is a third party and not this code. No phone and
no wallet were involved: the buyer is a script holding a faucet-funded testnet burner.

Run 2 (final code), 45.4 s end to end:

| Step | Observed |
|---|---|
| `GET /api/health` | `mode lightclient`, `network testnet`, `networkId 5`, block `11345630`, treasury `NQ17 XYLE…G6VH` holding `109998.99623 NIM`, `demoPaused false`. **This is the first live `getAccountByAddress` this repository has ever done** — against the light client, not the RPC |
| order | `9badf825847a2ddc`, 0.01 NIM, reference `RW1:P:9badf825847a2ddc` |
| buyer light client | consensus in **5126 ms**, networkId 5, head `11345637` |
| payment | `d6aafba47d2d73b6c6cd63aac540e6e0a415cae19075787c144f54ad8132b9b8`, fee 188 Luna, 188 bytes, **included in block 11345641**, `sendTransaction` returned in 5240 ms already carrying `state=included` |
| `POST /api/orders/:id/payment` with an **empty body** | `202`, `status paid` — the server found the payment by scanning the merchant address for the reference, with no hash hint at all |
| challenge | 7 lines, nonce `ae7e07bd41633b45610cfeda800667f0`, signed with the buyer key under the real preimage (`sha256("\x16Nimiq Signed Message:\n" + byteLen + text)`, Ed25519) |
| `POST /api/orders/:id/refund` | **503** `light client getTransaction(e14aa961…)` — the documented semantics, after the refund had already been broadcast |
| polling | 6 × 503, then `REFUNDED` |
| refund | `e14aa9617109b3ef1887201bc8d6896b4bde43a37cd21086be77501b082056e3`, **block 11345650**, treasury → buyer, 1000 Luna, data `RW1:R:9badf825847a2ddc` |
| buyer balance | `10999999812` → `10999999624` Luna. −188, which is exactly the payment fee: the 1000 Luna went out and came back |

Run 1 was the same walk with a cold faucet tap: payment
`2788a1d156b42b1ce9d0d05a0b7c00ff0715dd512b87059411214ce44ee8b4a6` (block 11345461), refund
`4afd4b276e50a89bfa04844a83d18efd0effce348d3e50efdf1bd05c97f0c0ed` (block 11345472), 5 × 503
while settling. The dev server's own light client reached consensus in **9880 ms** and served
every read for both runs.

What that does and does not prove is in the tables below. In one line: **the server's
transaction path is real now** — a treasury key signed, a real transaction was broadcast and
included, and `REFUNDED` came from a verified chain record — but it happened on testnet, from
a script, with no wallet and no phone anywhere in it.

## What changed on 2026-09-13, second pass

- **`DEFAULT_CONFIG.networkId` is 24.** It was 42, the pre-Albatross id, which matches nothing
  on the current chain — a mainnet build that forgot `REWIND_NETWORK_ID` failed every payment
  verification. The default is now correct with no environment variable at all, and
  `REWIND_NETWORK_ID` stays as an override. Gap A2 is closed.
- **`src/wallet.ts` returns outcomes, not exceptions.** `cancelled` is a first-class result,
  distinct from `error`, because cancelling is the most likely thing a person does at a wallet
  dialog and it is not a failure. A resolved `ErrorResponse`, a rejection carrying an `Error`
  and a rejection carrying a bare `{error:{...}}` object all land on the same outcome. The
  adapter also exposes `listAccounts()`, which is how the UI says "you are paying from NQ…".
- **The transaction hash is not derived client side.** If the provider returns 64 hex
  characters it is used as a hint; anything else is reported as `serialized` and NO hint is
  sent, so the server scans the merchant address for `RW1:P:<orderId>`. Deriving the hash
  properly means Blake2b over the transaction's content, which means `@nimiq/core`'s WASM in
  the phone bundle for a hint the server does not need.
- **`GET /api/health`** exists, and the Demo Store will not offer to take a payment when it
  cannot confirm it is able to refund.
- **`GET /api/merchant/refunds` is authenticated** with the same signature scheme as POST,
  carried in headers, and the answer is scoped to the merchant named in the challenge.
  Gap S1 is closed for both verbs.
- **Merchant challenges are stored and single use** (`merchant_nonces`). Gap S3 is closed.
- **The Demo Store approves its own refunds**, which is what the disclosure on the store
  screen says in as many words, and it is what lets one person walk the whole flow.
  `REWIND_DEMO_AUTO_APPROVE=off` turns it back into a two-person flow.
- **Every tap target is 44 px.** The tab strip was 36.

## What changed on 2026-09-13, third pass — Postgres actually runs

`PostgresRepository` used to call `neon(connectionString)` in its constructor, so the only way
to execute one of its statements was to reach a Neon endpoint. Everything below the tagged
template now sits behind `SqlExecutor` (`query(text, params) -> rows`), and the repository
takes either a connection string — production, unchanged — or an executor. The SQL itself was
not rewritten to make it testable: the tag is preserved by a nine-line adapter that turns
a tagged `sql` call into `("… $1", [id])`, so the text that runs in the tests is the text that
will run on Neon.

Two real bugs came out of the first run, both now covered by a test that fails when the fix is
removed:

1. **BIGINT was silently rounded.** `num()` was `Number(value)`, so an int8 above
   `Number.MAX_SAFE_INTEGER` — arriving as a bigint from one driver or a string from another —
   came back rounded. `9007199254740993` read back as `9007199254740992`. These columns hold
   Luna. It now refuses the value with an explicit error rather than moving a wrong amount, and
   `ms()` likewise throws on an unparseable timestamp instead of returning `0`, which would
   have made an order look expired.
2. **A second consumed challenge on one order was a 500, not a refusal.** `schema.sql` carries
   `refund_challenges_one_consumed_per_order`, a partial unique index the in-memory repository
   has no equivalent of, and `checkChallengeAgainstOrder` does not look at the order's state. A
   buyer who asks for two challenges while the order is PAID, signs both and presents them in
   turn consumed the first and hit that index with the second — 23505 escaped
   `submitSignedRefundRequest` as a thrown error. `consumeChallenge` now reports that as the
   replay it is (`nonce_already_used`). No money could move either way; the difference is a
   handled 409 instead of an unhandled 500.

Nothing else in `postgres.ts` or `schema.sql` was wrong. The other two flagged areas —
unique-violation surfacing (`code === '23505'` plus `constraint`) and the compare-and-set WHERE
clauses — behaved exactly as written on a real engine, and each is now pinned by a test that
was checked against a deliberately broken build (see Evidence).

## What is real now

| Component | Proved by | Not proved |
|---|---|---|
| `NimiqSignatureVerifier` | `nimiq-signature-verifier.test.ts`, 29 offline tests: generated keypairs, both prefixes, preimage byte-length, and negatives for tampered text, wrong key, raw-utf8 and unhashed signatures, flipped bits and malformed hex | That Nimiq Pay's `sign()` produces either preimage. No device signature has ever been checked |
| Address validation (`hasValidCheckDigits`, `parseAddress`) | `nimiq-address.test.ts`, 20 tests: two known-valid mainnet addresses, a transposed-character corruption, all 99 wrong check digits, 200 generated addresses, agreement with `Address.fromString` | Nothing outstanding. Gap A1 is closed |
| `RpcChainReader` | `rpc-chain-reader.test.ts`, 22 offline tests against an injected fetch, plus 4 live mainnet reads under `RUN_RPC_TESTS=1` | Behaviour under sustained load or at the rate limit. One endpoint, one moment |
| `TreasuryTxBuilder` | `treasury-broadcaster.test.ts`, 27 offline tests: build, sign, `verify()`, serialisation round trip, fee convergence on the signed size, determinism and every refusal — **plus two real testnet refunds it built and signed, included in blocks 11345472 and 11345650** | Mainnet. Every transaction it has ever signed was networkId 5, worth 0.01 NIM, and sent by a script |
| `RpcTxBroadcaster` | The same 27 tests cover it against a fake RPC | That a node accepts the transaction. **`pushTransaction` has still never been called from this repository**; the two real broadcasts went through the light client, not this class |
| `LightClientChainReader` and `LightClientTxBroadcaster` | `light-client-chain-reader.test.ts`, 22 offline tests (throw mapping, seed selection, field mapping), plus two full testnet loops on 2026-09-13 in which it read the head, read the treasury balance, found a payment by reference scan, broadcast a refund and settled it from a verified record. Both transactions confirmed by test-api.nimiq.watch | Mainnet, where cold consensus was 8.4-32.1 s in the spike. Any deployment: it is refused in production. Behaviour over hours, reorgs, or with the phone as the payer |
| Merchant authentication | `api/_lib/merchant-auth.test.ts`, 33 offline tests, run against both the fake and the real verifier | No merchant has ever signed anything in a wallet |
| `PostgresRepository` and `schema.sql` | `server/db/postgres.integration.test.ts`, 48 tests against **PostgreSQL 18.3 (PGlite 0.5.8)**, WASM, in process: the schema applies and re-applies, every statement runs, eight parallel reservations give one winner, eight parallel preparers give one winner, a replayed challenge nonce and a replayed merchant nonce are each consumed exactly once, a restart adopts the stored bytes, the caps hold, BIGINT and TIMESTAMPTZ round-trip, and every unique violation arrives as `UniqueViolationError` under the constraint name the application catches | The Neon driver itself (`neonExecutor`), Neon's own type parsing and error shape, multi-session lock contention, connection failure and pooling, and Vercel bundling |

---

## What is still fake

| Fake | Stands in for | What it does NOT prove |
|---|---|---|
| `FakeSignatureVerifier` | The real verifier above | Anything about signatures. It accepts a digest a real verifier would reject. Used only when `REWIND_VERIFIER` resolves to `fake` |
| `FakeRefundTxBuilder` / `FakeTxBroadcaster` | The real builder and broadcaster above | Serialisation, fees, validity windows, hashing, mempool behaviour |
| `FakeChain` / `FakeChainReader` | The Nimiq chain | Reorgs, timing, rate limits, real field values. Still the default for `npm run dev`; the testnet rehearsal replaces it with a real chain |
| `FakeWallet` | `window.nimiq` inside Nimiq Pay | The native confirmation dialog, real cancellation, address format from a real wallet. It has outcome parity with the real adapter and a `cancelNext()` hook, which is how the cancelled screens are exercised without a phone |
| `InMemoryRepository` | Postgres | Transaction isolation, real constraint behaviour, connection failures. Since 2026-09-13 the Postgres path has its own tests, so this is no longer the only evidence for the money rules |
| `FakeChain.balanceOf` | `getAccountByAddress` | Nothing about the real RPC method. It answers `defaultBalanceLuna` for any address nobody set |

## What is UNTESTED

- **`neonExecutor` and the Neon drivers.** The SQL in `server/db/postgres.ts` and the whole of
  `schema.sql` now run in the test suite, but against an embedded engine. No Neon endpoint has
  ever been contacted from this repository, and no database has been provisioned. What that
  leaves unproved is the driver layer, not the SQL: whether `@neondatabase/serverless` returns
  int8 as a string (assumed and handled), whether it hands back `Date` for TIMESTAMPTZ
  (assumed and handled), whether its error object carries `code: '23505'` and `constraint`
  (assumed — if it does not, every race turns into a 500), and how it behaves on a dropped
  connection or a cold start. The WebSocket `Pool`/`Client` driver is not used at all.
- **Multi-session behaviour.** PGlite runs a single Postgres backend, so the tests interleave
  at await points rather than across connections. Every guarantee here is decided inside one
  statement, which Postgres executes atomically regardless, but real lock contention,
  serialisation failures and long transactions are untested.
- **Vercel bundling of the database path.** `@neondatabase/serverless` has never been bundled
  into a deployed function.
- **`getAccountByAddress` over JSON-RPC** — still the only RPC method in this codebase whose
  live response shape has NOT been observed. The LIGHT CLIENT's `getAccount` has now been read
  live (the health endpoint reported the treasury's real testnet balance, 109998.99623 NIM),
  which says nothing about the RPC method's envelope. `RpcChainReader.getAccountByAddress`
  validates `balance` defensively and raises `ChainUnavailableError` rather than reporting a
  fabricated zero, because a zero would pause the demo for the wrong reason.
- **Any MAINNET broadcast, and any broadcast over JSON-RPC.** `RpcTxBroadcaster.broadcast`
  has still never been called against a real node. Two real refunds have now been broadcast —
  on testnet, through the light client, from a faucet-funded burner whose key is in a
  gitignored root `.env.local`. No mainnet key exists on this machine.
- **The real wallet path** — `NimiqPayWallet` has never run inside Nimiq Pay, and no signature
  produced by a real wallet has been fed to `NimiqSignatureVerifier`.
- **The whole app on a phone** — never opened on a device.
- **`vercel.json`** — never deployed, so the rewrite rule and the function runtime pin are
  unverified. The two new function files (`api/merchant/challenge.ts`, and `@nimiq/core` being
  pulled into the merchant and refund functions) have never been bundled by Vercel; the WASM
  payload is the obvious risk there and it is untested.
- **No real wallet has signed a merchant challenge.** The merchant screen now does the whole
  dance — `POST /api/merchant/challenge`, sign, then the authenticated call — and it is
  covered by jsdom tests with a mocked wallet. Nothing has run in Nimiq Pay.
- **The Demo Store's automatic approval has only ever run against the fake chain.** No
  treasury key is configured on this machine, so the refund stops at `REFUND_APPROVED` for
  want of a signer in any configuration that is not the fake one.

---

## Open gaps

| # | Gap | Why it matters |
|---|---|---|
| W1 | `sendBasicTransactionWithData` is documented in the SDK typings as returning **"the serialized transaction"**, not a hash. | Handled and kept: the client sends a hash only when the returned string looks like one, and the server otherwise finds the payment by scanning the merchant address for `RW1:P:<orderId>`. Both paths work against the fake chain; neither has been run against a wallet. |
| W2 | Provider calls resolve to `Result \| ErrorResponse`, so a cancelled dialog may be a resolved promise rather than a throw. | `unwrap()` collapses both. Unverified against a real dialog. |
| W3 | Which of the two signing prefixes Nimiq Pay uses is unknown. | The verifier accepts either and reports which matched. Harmless: the signed bytes are still the exact challenge text. Pin it on the first real device signature and consider narrowing. |
| A2 | ~~The default `networkId` was 42.~~ **Closed.** | `DEFAULT_CONFIG.networkId` is 24, so a mainnet build is correct without an environment variable. The comparison stays a string comparison; it fails closed either way. |
| S1 | ~~`api/merchant/refunds.ts` has no authentication.~~ **Closed for both verbs.** | POST requires a signature over an action-bound challenge in the body. GET requires the same over an `action=list` challenge, carried as `x-rewind-merchant-challenge` (base64 of the text), `-publickey` and `-signature`, and the answer is scoped to the merchant named in it. An unsigned GET is answered, unscoped, only while `merchantAuthRequired()` is false — the fake-chain developer loop. |
| S3 | ~~The merchant challenge is stateless and replayable.~~ **Closed, untested against Postgres.** | `merchant_nonces` stores every challenge at the moment it is issued, keyed by the SHA-256 of the exact text, and a state-changing challenge is consumed when its signature is accepted. A replay of the same bytes finds a consumed row and is refused; a signature over text the server never issued is refused as `unknown_nonce`. A `list` challenge is deliberately NOT consumed, so a merchant board polls with one signature instead of a wallet dialog every five seconds. **Both** implementations are now tested, the Postgres one against a real engine. |
| H1 | `getAccountByAddress`'s live response shape is unverified. | Only `GET /api/health` reads it, nothing in the money path does, and a malformed answer raises `ChainUnavailableError` rather than a zero balance. Worst case the health card says "unknown" and the demo pauses. Pin it on the first live read. |
| D1 | The Demo Store approves its own refunds. | Deliberate and published: the disclosure on the store screen says so in as many words, the buyer still had to prove they own the paying wallet, the treasury caps still apply, and `REFUNDED` still comes only from a verified chain record. It is the merchant's own policy, not an authentication bypass. Turn it off with `REWIND_DEMO_AUTO_APPROVE=off`. |
| N1 | `merchant_nonces` grows until something deletes it. | `POST /api/merchant/challenge` purges expired rows best-effort on every issue. That is the only cleanup. The DELETE now runs in the test suite (it removes only expired rows and reports the count); it has still never run against Neon, and nothing purges when no challenge is being issued. |
| S2 | Rate limiting is a per-instance stub. On Vercel that is not a limit. | Needs shared state before anything is public. Also needed to stay inside the public node's ~20 tokens / 10 s / IP with shared egress addresses. The `CachingChainReader` in front of the RPC reader is the other half of that defence. |
| R1 | `REFUND_FAILED` is terminal, with no automatic retry. | Deliberate: no path may re-enter `REFUND_APPROVED`. A failed refund needs a person, and there is no operator tooling for that yet. |
| R2 | A treasury ledger row is written before the broadcast and is never removed if the refund later fails. | Caps count NIM committed, not NIM confirmed. Conservative on purpose; it under-reports available allowance after a failure. |
| R3 | `ChainUnavailableError` returns 503 and the order does not move. | Correct, but there is no operator alert and no backoff visible to the buyer beyond `retry-after: 5`. A long node outage looks like a stuck order. |
| E1 | The explorer URL shape has not been checked from this repository. | The spike opened one in a browser and it rendered. The testnet base (`https://test.nimiq.watch/#`) is now what the rehearsal emits, and the two rehearsal hashes were confirmed through `test-api.nimiq.watch`, which is the API and not the page. Links may still 404 for an unincluded transaction. Nothing else breaks. |
| L1 | The light client answers 503 about transactions that exist, for roughly the first half-minute after inclusion. | Deliberate and unavoidable: its `getTransaction` throws "Transaction not found" for included transactions, so a throw can never be read as absence. `POST /refund` therefore returns 503 after a successful broadcast and the order settles on a later poll; the refund screen shows that as submitted-but-unconfirmed. Observed 5 and 6 times in the two rehearsal runs. |
| L2 | Whether Nimiq Pay accepts a plain `http://` custom URL, and whether a mini app sees the testnet network id in developer mode, is unknown. | Everything in the rehearsal below the phone works; the phone step itself is unproved. If http is refused the rehearsal needs a TLS tunnel, which nothing here sets up. |
| L3 | The rehearsal uses `InMemoryRepository`. | Orders die with the dev server. Fine for a walkthrough, and it keeps the rehearsal independent of Neon; it means a mid-demo restart loses the order rather than recovering it, which is exactly the path `resumeUnsettledRefunds` exists for and which is therefore still unexercised against a real chain. |
| P1 | `InMemoryRepository` is per-instance and is refused when `VERCEL_ENV=production`. | Without that guard a deployment would look like it worked and lose every order. |

---

## Environment variables

Names only. No values are in this repository and none should be.

| Name | Purpose |
|---|---|
| `REWIND_REPO` | `memory` (default, dev only) or `postgres` |
| `DATABASE_URL` | Neon connection string, required when `REWIND_REPO=postgres`. Read only by `api/_lib/deps.ts`, which passes it to `new PostgresRepository(url)`; that constructor builds the Neon HTTP executor. **The tests never read it** — they hand the repository an embedded-Postgres executor instead, so no database is needed to run them and no connection string belongs in this repository |
| `REWIND_CHAIN` | `fake` (default, dev only), `lightclient` (LOCAL testnet rehearsal, refused in production) or `rpc` |
| `REWIND_NETWORK` | `testnet` or `mainnet` (default, and what any unrecognised value means). Decides the light client's seed nodes, the default `networkId` the domain checks, the networkId the treasury signs with, and the explorer prefix. Reported by `GET /api/health` so the frontend never guesses |
| `NIMIQ_RPC_URL` | Public or private Nimiq RPC endpoint, required when `REWIND_CHAIN=rpc` |
| `NIMIQ_RPC_AUTHORIZATION` | Optional credential for a private node. Never logged |
| `REWIND_VERIFIER` | `real` or `fake`. Unset means real in production or with `REWIND_CHAIN=rpc`, fake otherwise. `fake` is refused in production |
| `REWIND_MERCHANT_AUTH` | `required` or `off`. Unset means required in production or with `REWIND_CHAIN=rpc`. `off` is refused in either |
| `REWIND_TREASURY_PRIVATE_KEY` | **Secret.** 64 hex characters, the Demo Store treasury signing key. Read only by `TreasuryTxBuilder.fromEnv`, never logged, never returned. For the rehearsal it lives in a gitignored root `.env.local` and is a TESTNET burner funded by a faucet; `npm run rehearsal:testnet` writes it there and never prints it. Without it the Demo Store cannot send a refund and orders stop at `REFUND_APPROVED` |
| `REWIND_NETWORK_ID` | Override for the expected `networkId`. **The default follows `REWIND_NETWORK`: 24 on mainnet, 5 on testnet**, so the rehearsal needs no override. `TreasuryTxBuilder.fromEnv` derives its signing networkId from the same two variables, so the checked id and the signed id cannot drift apart |
| `REWIND_MIN_CONFIRMATIONS` | Confirmations before a transfer counts |
| `REWIND_REFUND_FEE_LUNA` | Absolute fee for a treasury refund. `0` (the default) means 1 Luna per signed byte |
| `REWIND_TREASURY_ADDRESS` | Demo Store address, which is also the capped treasury. Must be the address of `REWIND_TREASURY_PRIVATE_KEY` |
| `REWIND_SAMPLE_MERCHANT_ADDRESS` | The non-treasury merchant used to exercise the merchant-signs path |
| `REWIND_CAP_PER_REFUND_LUNA` | Override for the per-refund cap |
| `REWIND_CAP_TOTAL_LUNA` | Override for the lifetime treasury ceiling |
| `REWIND_TREASURY_FLOOR_LUNA` | Treasury balance below which the Demo Store stops taking payments. Default 50000 Luna (0.5 NIM). Read by `GET /api/health`, which turns it into `demoPaused` |
| `REWIND_DEMO_AUTO_APPROVE` | `off` turns off the Demo Store's automatic approval of its own refunds, making it a two-person flow. Anything else, including unset, leaves it on — which is what the store screen's disclosure describes |
| `REWIND_EXPLORER_BASE` | Explorer link prefix. Default follows the network: `https://nimiq.watch/#` on mainnet, `https://test.nimiq.watch/#` on testnet. Every link in a view is built server-side from this, so the frontend needs no network knowledge to link correctly |
| `RUN_RPC_TESTS` | Test-only. `1` enables the live mainnet integration tests |
| `REWIND_NO_EMBEDDED_PG` | Test-only. `1` forces the Postgres suite to skip, which is what a machine without the embedded engine sees |

Secret handling: `REWIND_TREASURY_PRIVATE_KEY` is the only secret this codebase reads. It is
loaded once in `TreasuryTxBuilder`, converted to a `KeyPair`, and never echoed — the
constructor's rejection message deliberately says nothing about the value it saw, and there is
a test asserting that.

---

## Dependency audit — 2026-09-13

`@electric-sql/pglite` was added as a devDependency on 2026-09-13 (`added 1 package`). It is
dev only, it is imported by one test-support file and one test, it never appears in
`dependencies`, and the audit count did not change.

`npm audit` reports **five findings, all five dev-only**, all in the vite/vitest build chain.
None of them ships: nothing here is in `dependencies`, and none of this code runs in a
deployed function or in the browser bundle.

| Package | Severity | Runtime or dev | Advisory | Fix |
|---|---|---|---|---|
| `vitest` (direct dev dep) | **critical** | dev only | GHSA-5xrq-8626-4rwp — arbitrary file read/execute while the Vitest **UI server** is listening | `vitest@5`, a major bump |
| `vite` (direct dev dep) | **high** | dev only | GHSA-fx2h-pf6j-xcff `server.fs.deny` bypass on Windows alternate paths, plus GHSA-4w7w-66w2-5vf9 and GHSA-v6wh-96g9-6wx3 | `vite@8`, a major bump |
| `esbuild` (via vite) | moderate | dev only | GHSA-67mh-4wv8-2f99 — any website can send requests to the dev server and read the response | `vite@8`, a major bump |
| `@vitest/mocker` (via vitest) | moderate | dev only | GHSA-82fw-gwwq-j7x9 — path traversal / arbitrary file read via a redirect mock | `vitest@5`, a major bump |
| `vite-node` (via vitest) | moderate | dev only | inherits the `vite` advisories above | `vitest@5`, a major bump |

`npm audit fix` was run and **changed nothing**: every remaining fix is a major bump
(`vite@5 → 8`, `vitest@2 → 5`) and `--force` was not used. What that leaves open, honestly:
the dev server and the Vitest UI must not be exposed beyond localhost on an untrusted
network. The Vitest UI is never started here (`npm test` is `vitest run`), and `npm run dev`
binds with `host: true`, which does put it on the LAN — worth knowing before running it on
shared wifi. Upgrading both majors is its own task, with its own regression run.

## Evidence

Commands run on this machine on 2026-09-13 (Windows 11, node v24.19.0, npm 11.13.0).

- `npm install @nimiq/core@2.21.0` → `added 21 packages`
- `npm install -D jsdom` → `added 39 packages`, for the frontend test environment. Dev only,
  and it did not change the audit count
- `npm run typecheck` → clean
- `npm test` → **314 passed, 4 skipped (16 files)**, offline, after the Postgres work; it was
  266 passed in 15 files before it (itself up from 205 in 12: 33 wallet-adapter tests, 21 jsdom
  screen tests, 3 health-endpoint tests, 4 merchant-nonce tests). The 48 new ones are the
  Postgres file
- `npm run build` → typecheck clean, then `41 modules transformed`, `built in 610ms`, main
  chunk `176.55 kB` (gzip 55.54 kB) — byte for byte what it was before the database work, so
  neither the executor seam nor the dev-only engine reached the browser bundle. It grew 12.5 kB against 164.03 kB, which is the new
  screens and the wallet adapter; `@nimiq/core` is still server-side only and still not in
  the bundle
- `npm install -D @electric-sql/pglite` → `added 1 package, and audited 175 packages`; the
  audit still reports the same `5 vulnerabilities (3 moderate, 1 high, 1 critical)`
- `npm run test:db` → `48 passed`, engine line printed by the suite itself:
  `[postgres.integration] engine: PostgreSQL 18.3 (PGlite 0.5.8)`, 737 ms
- `REWIND_NO_EMBEDDED_PG=1 npx vitest run server/db/postgres.integration.test.ts` →
  `1 skipped (1)`, `48 skipped (48)`, with the reason printed. That is what a machine without
  the engine sees; the rest of `npm test` is unaffected
- **The Postgres tests were checked against deliberately broken builds**, one mutation at a
  time, and each was reverted immediately:
  - deleting `AND serialized_tx IS NULL` from `prepareRefundExecution` → **3 failed**, including
    "gives exactly one winner when eight callers prepare the same execution at once" and
    "restarts: a second process adopts the stored bytes"
  - deleting `AND state = ${expectedState}` and `AND consumed_at IS NULL`, and changing the
    unique-violation test from `23505` to a code that never matches → **11 failed**, across
    reservation, nonce replay, the ledger and the constraint-name assertions
  - restoring the old `Number(value)` coercion → **1 failed**: "refuses, rather than rounds, a
    BIGINT too large for a JS number"
  - removing the new `refund_challenges_one_consumed_per_order` catch → **1 failed**: "refuses a
    second signed challenge for an order that already has one"
- **End-to-end walk against the dev server and the fake chain**, `http://localhost:5199`,
  with no hash hint at all, so the server had to find the payment by scanning for its
  reference:
  - `GET /api/health` → `chain.reachable true`, `blockNumber 1000000`, `networkId "24"`,
    treasury `100 NIM`, floor `0.5 NIM`, `demoPaused false`
  - `POST /api/orders` → `201`, `networkId "24"` with **no `REWIND_NETWORK_ID` set**, which is
    the point of the default change
  - `POST /api/orders/:id/payment` with an empty body → `202`, and the order reached `PAID`
    with `payerAddress NQ64 P4YR …0001` found by reference scan alone
  - `POST /api/orders/:id/refund` with a valid signature → `200`, `autoApproved true`,
    state `REFUND_BROADCAST`
  - the same signature replayed → `409 conflict`
  - polling → `REFUNDED`, refund tx `19a4d4b4b031323d…`, block `1000010`, explorer
    `https://nimiq.watch/#19a4d4b4b031323d8a5…`
  - `GET /api/merchant/refunds` with a signed `list` challenge → `200`, `scopedToMerchantId
    "demo-store"`, and every row belonged to that merchant; the same signature reused for a
    second read → `200`, because a list challenge is not consumed
  - the same challenge signed by the buyer's wallet instead → `400`
    `not_the_merchant_wallet: NQ64 P4YR …`
  - a garbage sign-in header → `400`, and an unsigned GET in the developer loop → `200`,
    unscoped
  - `POST /api/orders` with `amountLuna 999999999` → `400`
    `Enter an amount between 1 and 100000 Luna.`
  - `POST /api/orders` with `amountLuna 2500, reference "table 4"` → `201`, `0.025 NIM`,
    label `table 4`
- Live, read-only, `RUN_RPC_TESTS=1` against `https://rpc.nimiqwatch.com` at 08:33 UTC:
  - `getBlockNumber` → `61480679`
  - `getTransactionByHash("90fca75b…7616")` → `blockNumber 61420752`, `confirmations 59931`,
    `value 1565`, `fee 0`, `networkId 24`, `executionResult true`,
    `recipientData "0620ab2a68a72e2d86cd45134bd9815703f2742ad6"`
  - `getTransactionByHash(<random 32 bytes>)` → `null` (the node answered
    `-32603 "Transaction not found"`, which the reader maps to pending)
  - `getTransactionsByAddress("NQ77 0000 … 0001", 3, null)` → 3 rows, all `networkId 24`
- Earlier, against fakes: end-to-end walk of the API with `npm run dev` — order created →
  payment verified → reuse of that payment by a second order refused (409) → challenge issued →
  wrong signer refused (400) → correct signer accepted → replay refused (409) → two concurrent
  approvals producing one reservation → refund verified on chain → order `REFUNDED`.

The concurrency and recovery tests were checked against a deliberately broken build to confirm
they fail when the protection is removed: replacing `prepareRefundExecution` with a plain
update makes "two concurrent sends produce one transaction" report 2 sends instead of 1.

### Fourth pass, 2026-09-13: the testnet rehearsal, run on this machine

Commands and their real output. Node v24.19.0, npm 11, Windows 11.

- `npm run typecheck` → clean
- `npm test` → **337 passed, 4 skipped (17 files)**, offline. The 22 new ones are
  `server/chain/light-client-chain-reader.test.ts`; one more is the refund screen's 503 case
- `npm run build` → typecheck clean, then `41 modules transformed`, `built in 934ms`, main
  chunk `176.86 kB` (gzip 55.64 kB). It grew 0.31 kB against 176.55 kB — the network row on
  the store screen and the 503 branch. `@nimiq/core` is still server-side only and still not
  in the browser bundle
- `node scripts/rehearsal-testnet.mjs --no-server` →
  `treasury address NQ17 XYLE 5FBG M0A2 Q7TC Y82U A7M6 AS0D G6VH`,
  `balance 10999899811 Luna = 109998.99811 NIM (test-api.nimiq.watch)`, key reused from
  `spikes/light-client/.env.local` and copied into a new root `.env.local` (the spike file was
  not written to). `git status` shows neither file: `.gitignore`'s `.env.*` covers both
- `npm run rehearsal:testnet` → dev server up; the plugin printed the LAN URLs at the port vite
  actually bound, then `[lightclient] booting testnet (TestAlbatross)` and
  **`[lightclient] consensus on testnet in 9880 ms, networkId 5`**. Note 5173 was already in
  use on this machine, vite took 5174, and the printed URL followed it — that fix exists
  because a URL typed into a phone from the wrong port is a silent dead end
- `GET /api/health` against it →
  `{"chain":{"reachable":true,"mode":"lightclient","network":"testnet","explorerBase":"https://test.nimiq.watch/#","networkId":"5","blockNumber":11345319,...},"treasury":{"address":"NQ17 XYLE …","balanceLuna":10999899811,"balanceLabel":"109998.99811 NIM"},"demoPaused":false,"repo":"memory"}`
- `node scripts/rehearsal-buyer.mjs` → **REHEARSAL: PASS**, twice. Run 1 (with a cold faucet
  tap for the buyer) took 169.9 s of which 120 s was waiting for the faucet; run 2 took 45.4 s.
  Both transactions of both runs were then fetched from `test-api.nimiq.watch`, a third party:

  | | run 1 | run 2 |
  |---|---|---|
  | order | `dcc3a089eb8d6c3b` | `9badf825847a2ddc` |
  | payment tx | `2788a1d156b42b1ce9d0d05a0b7c00ff0715dd512b87059411214ce44ee8b4a6` | `d6aafba47d2d73b6c6cd63aac540e6e0a415cae19075787c144f54ad8132b9b8` |
  | payment block | 11345461 | 11345641 |
  | refund tx | `4afd4b276e50a89bfa04844a83d18efd0effce348d3e50efdf1bd05c97f0c0ed` | `e14aa9617109b3ef1887201bc8d6896b4bde43a37cd21086be77501b082056e3` |
  | refund block | 11345472 | 11345650 |
  | buyer light client, cold consensus | 8988 ms | 5126 ms |
  | `sendTransaction` returned in | 5512 ms, already `state=included` | 5240 ms, already `state=included` |
  | 503s while settling | 5 | 6 |

  The third party's own answer for run 2's payment, verbatim:
  `{"block_height":11345641,"hash":"d6aafba4…b9b8","sender_address":"NQ67 P1JF APL7 QJLJ XVUH JGSV FLK2 M7V8 CUK0","value":1000,"fee":188,"executed":true,"receiver_address":"NQ17 XYLE …","data":"UlcxOlA6OWJhZGY4MjU4NDdhMmRkYw==","confirmations":36}`
  — that base64 is `RW1:P:9badf825847a2ddc`, and the refund's is `RW1:R:9badf825847a2ddc`.
  The buyer's balance went `10999999812` → `10999999624` Luna across run 2: −188, the payment
  fee, because the 1000 Luna came back.

- Deliberately NOT hinted: `POST /api/orders/:id/payment` was called with an **empty body** in
  both runs, so the server had to find the payment by scanning the merchant address for
  `RW1:P:<orderId>`. It answered `202 status=paid` within ~3 s of the transaction landing.

### Still unverified, after this pass

Nothing above involved a real wallet, a real device, a database, mainnet, or a deployment.
Specifically:

- **A real wallet.** `NimiqPayWallet` has never run inside Nimiq Pay. Its result mapping is
  tested against a stub built from the SDK's own type declarations, which are a declaration,
  not an observation. Which of `sendBasicTransactionWithData`'s two documented return shapes
  is real (gap W1), and whether a cancelled dialog rejects or resolves (gap W2), are both
  still open. No signature produced by a real wallet has ever been verified.
- **A phone.** No screen in `src/` has been opened on a device. The 44 px rule is enforced in
  CSS and read in review; it has not been thumbed.
- **Neon.** `server/db/postgres.ts` and `server/db/schema.sql` now run in the test suite, but
  against embedded Postgres. No Neon endpoint has been contacted, no database has been
  provisioned, and `neonExecutor` — the ten lines that actually talk to Neon — is executed by
  nothing.
- **Vercel.** Never deployed. `api/health.ts` is a new function file that has never been
  bundled, and `vercel.json` is still unverified.
- **Any mainnet broadcast.** `pushTransaction` — the JSON-RPC path the deployment would use —
  has still never been called from this repository. The only transactions this repository has
  ever sent are the four testnet ones above, through the light client, from a faucet-funded
  burner. No mainnet key exists on this machine.
- **`getAccountByAddress`.** The one RPC method here whose live response has never been seen.

Not evidence of anything on a phone, on Neon, on mainnet, or on Vercel. The testnet loop is
evidence of exactly what it says: this code, on this machine, moved 0.01 testnet NIM out and
back, twice, and refused to call it refunded until the chain said so.
