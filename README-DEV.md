# Rewind — developer notes

The judge-facing walkthrough is `DEMO.md`.

Rewritten 2026-09-15 for `main` after the audit pass (PRs #7–#13). Earlier versions of this file, including the full
2026-09-13 testnet rehearsal evidence, are in git history.

## Status: what is proven, and how

| Claim | Evidence | Environment | Checked |
|---|---|---|---|
| A buyer pays the Demo Store in Nimiq Pay and the server verifies the payment on chain | Order `a002870307c998de`: payment `feafc8a84d5e6c9c0392405080f444debe633c4916217660732740b857d84d7b`, block 61,596,026, from HTLC `NQ66…7M05` (`fromType` 2) to the treasury, `RW1:P:a002870307c998de`; order PAID | Production (Vercel, Neon, `rpc.nimiqwatch.com`), Android Nimiq Pay, mainnet | 2026-09-14; API and RPC re-read 2026-09-15 |
| `sendBasicTransactionWithData` returns the transaction hash | The hint the app stored equals the verified payment hash on orders `a002870307c998de` and `40b14249e86ffff7` | Same | 2026-09-15 |
| The refund destination is the HTLC's funder, and only that wallet's signature is accepted | Same order: refund request signed by `NQ87…MUXR`, the `sender` of HTLC `NQ66…` | Same | 2026-09-14 |
| The treasury builds, signs, pushes and settles a refund | Refund `0989689ee542375659559e5a73196d3f3cf0e622f03785b2de553097e5006507`, block 61,603,650, 1000 Luna + 188 Luna fee, `RW1:R:a002870307c998de`; order REFUNDED; `https://nimiq.watch/#0989689e…` renders it | Same | 2026-09-14; explorer read 2026-09-15 |
| A refund to an HTLC fails on chain | Order `40b14249e86ffff7`: refund `ca84b35565275eb03523bb31c695171e5620d97cd6d4eafd46f9319a095b4db7`, `executionResult` false, REFUND_FAILED (why the destination rule exists) | Same | 2026-09-14 |
| Nimiq Pay signs with the "Nimiq Signed Message" prefix | Device capture: only `nimiq-prefixed-sha256` verified; RPC `verifySignature` agreed | Android, local page over LAN http | 2026-09-13 |
| Neon, the Neon HTTP driver and `schema.sql` work in production | Orders, challenges, refund executions, merchants written and read back through the API | Production | 2026-09-14 |
| A shop registers by signature | Shop `w-nq87t28smdl1tuc77l8l5bedj4hckbm7muxr` exists (`GET /api/merchants/…` 200) | Production | 2026-09-15 |
| Money rules hold under concurrency and restarts | PGlite suite: eight parallel reservations → one winner; eight parallel preparers → one set of bytes; replayed nonces consumed once; a restart adopts stored bytes; mutation checks fail the tests when the SQL guards are removed | Local, PostgreSQL 18.3 (PGlite 0.5.8) | every `npm test` |

**Not proven:** a shop's refund sent from Nimiq Pay and settled by reference (payment-link order `2d5e5d4f107c10d5` is
paid on mainnet; no refund transfer for it was on chain at 2026-09-15 05:12 UTC); what Nimiq Pay returns for a cancelled dialog; iOS; any
second buyer who is not the owner; behaviour while the public RPC is down; the Neon driver's unique-violation shape under
a real race; recovery of a refund interrupted mid-request on Vercel.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 — frontend and api/ in one process, fake chain and fake wallet
npm test           # vitest, offline (the PGlite Postgres suite included)
npm run test:db    # only the Postgres suite
npm run typecheck  # tsc --noEmit
npm run build      # typecheck, then vite build into dist/

RUN_RPC_TESTS=1 npx vitest run server/chain/rpc-chain-reader.integration.test.ts
                   # the only tests that open a socket: four read-only mainnet reads (the 4 skipped otherwise)
```

`vite dev` does not know about `api/`, so `dev-server/dev-api-plugin.ts` mounts the same handler modules in-process and
loads the root `.env.local` without overriding variables already set. In production Vercel routes `api/` itself.

With no Nimiq Pay provider in a **development** build the app uses `FakeWallet`, which drives the server's fake chain
through `/api/dev/fake-chain` (served by `api/_dev/fake-chain.ts` through the dev plugin only; the underscore keeps it out of the deployment, and it also refuses unless `REWIND_CHAIN` is `fake` and `VERCEL_ENV` is not
`production`). A production build never uses the fake wallet: without a provider it says "open Rewind inside the Nimiq
Pay app" and creates no order. The fake wallet has one address, so it cannot pay a shop it registered itself.

To open the local server in Nimiq Pay (Mini Apps → Custom URL), put the phone on the laptop's network; the plugin prints
the LAN URL at the port vite actually bound. A plain `http://` LAN URL was accepted on Android on 2026-09-13.

## Where things are

| Path | What it is |
|---|---|
| `src/` | Vite + React frontend, mobile first, 44 px tap targets |
| `src/screens/DemoStore.tsx`, `Order.tsx`, `Refund.tsx`, `Receipt.tsx` | The Demo Store loop |
| `src/screens/Merchant.tsx`, `Pay.tsx`, `src/pay.ts` | Payment links: register a shop, build a link, pay through it, the shop's refund board |
| `src/wallet.ts` | The only code that talks to a wallet. Every call returns `ok` / `cancelled` / `error` |
| `src/storage.ts` | What this browser remembers: its orders, its shop, refunds it handed to the wallet |
| `api/` | Vercel functions, thin, wired in `api/_lib/deps.ts` |
| `api/orders.ts` | `POST` creates an order. There is no list endpoint |
| `api/orders/[id].ts` | Order status; each poll verifies a pending payment, sends an approved treasury refund, settles a broadcast one |
| `api/orders/[id]/payment.ts`, `refund-challenge.ts`, `refund.ts` | Payment hint, refund challenge, signed refund request (the Demo Store auto-approves) |
| `api/merchant/register.ts`, `api/merchants/[id].ts` | Shop registration by signature; the public shop record a link shows |
| `api/merchant/challenge.ts`, `api/merchant/refunds.ts` | Signed merchant challenges; the shop board (GET, signed and scoped) and approve / reject (POST) |
| `api/health.ts` | Chain reachability, treasury balance and floor, `demoPaused` |
| `api/_tests/`, `api/_dev/fake-chain.ts` | Handler tests and the dev-only fake chain. The underscore keeps them out of the deployment; `api/_tests/deploy-surface.test.ts` pins the deployed functions to the ten handlers |
| `server/domain/` | Framework-free core |
| `server/domain/refund-reservation.ts` | Refund destination, signed request, exactly-once reservation, treasury send, settlement, recovery sweep |
| `server/domain/order-service.ts` | Order creation, payment hint, payment verification (hint, then reference scan) |
| `server/domain/verify.ts` | The chain acceptance predicates |
| `server/domain/challenge.ts`, `merchant-auth.ts`, `merchant-registration.ts` | The three signed texts and their strict parsers |
| `server/domain/demo-treasury.ts` | Treasury caps |
| `server/chain/rpc-chain-reader.ts` | Public-RPC reader: retries, timeouts, not-found is pending |
| `server/chain/treasury-broadcaster.ts` | Treasury signer (`@nimiq/core`) and `pushTransaction` broadcaster |
| `server/chain/network.ts` | `REWIND_NETWORK` → networkId default and explorer |
| `server/crypto/` | Ed25519 signed-message verifier; address check digits |
| `server/db/` | Repository port, in-memory and Postgres implementations, `schema.sql`, PGlite test executor |
| `spikes/sign-verify`, `spikes/server-tx` | The two 2026-09-13 gate spikes; nothing imports them. Their READMEs hold the raw evidence |

## How a refund is kept to exactly one

1. `refund_executions.order_id` is UNIQUE. Concurrent approvals both attempt the insert and the database picks the winner.
2. The serialised transaction is attached with a compare-and-set that fires only while there is none
   (`prepareRefundExecution`). Two preparers a block apart would otherwise build two different transactions.
3. The bytes are stored **before** the broadcast. Recovery re-checks the chain and re-sends the same bytes, until they
   are included or the validity window (7,200 blocks, `Policy.TRANSACTION_VALIDITY_WINDOW_BLOCKS`) has passed.
4. `REFUNDED` is only set from a chain record that satisfies `verifyRefund`.

On Vercel nothing runs on a schedule: steps 3–4 run when the order page or the shop board polls.
`resumeUnsettledRefunds` performs the same sweep for every unsettled refund; the recovery tests use it, production does
not call it yet.

## Where a refund goes, and who may ask for it

`resolveRefundDestination` reads the payer's account when the refund challenge is issued: a basic account is refunded
itself, an HTLC is refunded to its `sender` (the wallet that funded it), any other type is refused. The challenge text
names that address as `refundTo`, and only a signature recovering that address is accepted. Nimiq Pay was seen paying
from an HTLC funded by the signing wallet on mainnet and testnet (2026-09-14).

The payment transaction's `fromType` decides the kind of payer, because an account can change after it pays: a
never-used address reads as `{balance: 0, type: "basic"}`, and Nimiq Pay's HTLCs time out after about two weeks. For an
HTLC the funder comes from the contract while it exists, otherwise from the `sender` in its executed contract-creation
transaction (`toType` 2 and the creation flag; a later transfer with look-alike data is ignored). Verified read-only on
mainnet on 2026-09-15: payment `feafc8a8…` resolves to `NQ87…MUXR` with the live HTLC and with the HTLC made to read as
closed (PR #16). Limit: only the newest 50 transactions of the HTLC are searched; beyond that the request is refused.

## Payment links

A wallet signs `REWIND_MERCHANT_REGISTER_V1` / `name=` / `issued=`; the shop id is `w-` plus the signing address. A link
is `#/pay/<id>?amount=<luna>&label=` (1 Luna to 1 NIM). The buyer's payment is verified like a Demo Store payment. The
shop signs a `list` challenge once to read its board (not consumed, scoped to the shop, filtered by merchant in SQL),
signs each approve or reject (single use), and sends the refund from Nimiq Pay with `RW1:R:<order>`. `settleRefund` finds
it among the last 50 transfers to the refund address with the exact amount and reference, from the shop or an HTLC the
shop funded, and ignores lookalikes from anyone else. Because the buyer pays from an HTLC, one wallet can act as both shop
and buyer.

## Chain and signature facts the code relies on

- JSON-RPC 2.0 POST; results at `result.data`. `getTransactionByHash` takes one parameter; an unknown hash is error
  `-32603 "Transaction not found"`, mapped to pending. Any other RPC failure is `ChainUnavailableError` → 503.
- `getTransactionsByAddress` takes `[address, max, startAt]`. Data comes back hex under `recipientData`.
- Transaction records also carry `fromType` / `toType` (0 basic, 2 HTLC), not read yet.
- Mainnet `networkId` 24. Fee: 1 Luna per signed byte for treasury refunds; Nimiq Pay's payments carried fee 0.
- `TransactionBuilder` does not enforce the 64-byte data cap; `verify()` does, so the builder checks it before and after.
- Signed message: `sha256("\x16Nimiq Signed Message:\n" + byteLength + message)`, Ed25519. The verifier also accepts the
  keyguard's connect-challenge prefix and reports which matched.

## What is still fake, and only in development

| Fake | Stands in for | Proves nothing about |
|---|---|---|
| `FakeSignatureVerifier` | the Ed25519 verifier | signatures |
| `FakeRefundTxBuilder`, `FakeTxBroadcaster` | the treasury signer and `pushTransaction` | serialisation, fees, mempool |
| `FakeChain`, `FakeChainReader` | the chain | timing, reorgs, rate limits, real field values |
| `FakeWallet` | Nimiq Pay's provider | native dialogs, cancellation shapes |
| `InMemoryRepository` | Postgres | isolation; refused when `VERCEL_ENV=production` |

## Open gaps

| # | Gap | Why it matters |
|---|---|---|
| S2 | Rate limiting is per function instance (`api/_lib/ratelimit.ts`) | Not a real limit on Vercel. The chain cache reduces pressure on the public RPC's ~20 tokens / 10 s per IP; nothing bounds it |
| W2 | What Nimiq Pay returns for a cancelled dialog is unobserved | The cancel mapping is proven only against a stub |
| R1 | `REFUND_FAILED` is terminal and has no operator tooling | A failed refund needs a person |
| R2 | A treasury ledger row is written before the broadcast and never removed | Caps count NIM committed, not confirmed |
| R3 | A long RPC outage looks like a stuck order | 503 with `retry-after: 5`; no alert |
| N1 | `merchant_nonces` is purged only when a merchant challenge is issued | Grows slowly otherwise |

## Environment variables

Names only. No values are in this repository.

| Name | Purpose |
|---|---|
| `REWIND_REPO` | `memory` (default, dev only) or `postgres` |
| `DATABASE_URL` | Neon connection string, required when `REWIND_REPO=postgres`. The tests never read it |
| `REWIND_CHAIN` | `fake` (default, dev only) or `rpc`. Any other value is refused |
| `REWIND_NETWORK` | `mainnet` (default, and any unrecognised value) or `testnet`. Decides the default networkId and the explorer. No public testnet RPC is known |
| `NIMIQ_RPC_URL` | Required when `REWIND_CHAIN=rpc` |
| `NIMIQ_RPC_AUTHORIZATION` | Optional credential for a private node. Never logged |
| `REWIND_VERIFIER` | `real` or `fake`. Unset: real in production or with `REWIND_CHAIN=rpc`. `fake` is refused in production |
| `REWIND_MERCHANT_AUTH` | `required` or `off`. Unset: required in production or with `REWIND_CHAIN=rpc`, where `off` is refused |
| `REWIND_TREASURY_PRIVATE_KEY` | **Secret.** 64 hex characters. Read only by `TreasuryTxBuilder.fromEnv`, never logged or returned. Without it the Demo Store cannot send a refund and orders stop at `REFUND_APPROVED` |
| `REWIND_TREASURY_ADDRESS` | The Demo Store address, which is the treasury. Must match the key |
| `REWIND_NETWORK_ID` | Override for the expected networkId (default 24 on mainnet, 5 on testnet). The treasury signs with the same value |
| `REWIND_MIN_CONFIRMATIONS` | Confirmations before a transfer counts (default 2) |
| `REWIND_REFUND_FEE_LUNA` | Absolute treasury refund fee; `0` (default) means 1 Luna per signed byte |
| `REWIND_CAP_PER_REFUND_LUNA`, `REWIND_CAP_TOTAL_LUNA` | Overrides for the per-refund cap (default 1 NIM) and the lifetime ceiling (default 50 NIM) |
| `REWIND_TREASURY_FLOOR_LUNA` | Below this balance the Demo Store pauses (default 0.5 NIM) |
| `REWIND_DEMO_AUTO_APPROVE` | `off` makes the Demo Store a two-person flow; anything else leaves automatic approval on, as the store screen discloses |
| `REWIND_EXPLORER_BASE` | Explorer link prefix; default `https://nimiq.watch/#` on mainnet, `https://test.nimiq.watch/#` on testnet |
| `RUN_RPC_TESTS` | Test only. `1` enables the live read-only mainnet tests |
| `REWIND_NO_EMBEDDED_PG` | Test only. `1` skips the Postgres suite |

## Dependencies

`npm audit` on 2026-09-15: 5 findings (1 critical, 1 high, 3 moderate), all in vite, vitest and esbuild. With
`--omit=dev` it still lists vite (high) and esbuild (moderate), because vite is an optional peer dependency of
`@nimiq/core`. Every advisory concerns the Vite / esbuild / Vitest development servers, which production does not run
(Vercel serves the built `dist/` and the `api/` functions). Fixes need major upgrades (vite 8, vitest 5) and were not
applied. Do not expose `npm run dev` (it binds to the LAN) on an untrusted network.

## Evidence for this revision

Commands run on 2026-09-15, Windows 11, node v24.19.0, npm 11.13.0:

- On `main` after PR #16 plus `DEMO.md`: `npm run build` (typecheck, then vite build) → built, main chunk 183.90 kB;
  `npx vitest run` → Test Files 23 passed (23); Tests 406 passed | 4 skipped (410)
- Preview deployment of `main` `dbe867a` (`rewind-5af7nzl9t`, 07:32 UTC): 10 functions, none of them a test or the dev
  fake chain; its `/api/health` answered 200 in fake / memory mode, because `REWIND_REPO` and `REWIND_CHAIN` are
  production-only env vars, so the preview touched no production data
- Read-only mainnet runs with `vite-node` and no key: the RPC wiring's `GET /api/health` → 200, networkId 24, block
  61,645,373 (05:56 UTC, PR #12's branch); the refund destination of payment `feafc8a8…` → `NQ87…MUXR`, both with the
  live HTLC and with the HTLC made to read as closed (07:30 UTC, PR #16's branch)
