# Spike: Nimiq Pay `sign()` → server-side verification (gate N11)

> **Result, added 2026-09-15.** Gate N11 passed on 2026-09-13 at 17:48 UTC: on an Android phone, Nimiq Pay's `sign()`
> produced a signature that verified only as the "Nimiq Signed Message" variant, the derived address was the wallet's
> first account, and the public RPC's `verifySignature` agreed. The app's verifier
> (`server/crypto/nimiq-signature-verifier.ts`) has since verified refund signatures in production. The text below is the
> spike as written before that run, kept as its record; its "NOT verified" lines are historical.

**Question.** Can a message signed by `window.nimiq.sign(message)` inside Nimiq Pay be verified
server-side in Node with `@nimiq/core`, and can the signer's address be derived from the returned
public key?

**Status, 2026-09-13.**

| Claim | Evidence | Status |
|---|---|---|
| The Nimiq signed-message scheme is prefix + byte-length + message, SHA-256, then Ed25519 | `core-rs-albatross :: wallet/src/wallet_account.rs` (cited below) | **verified against source** |
| `@nimiq/core` 2.21.0 verifies such a signature in Node 24 on Windows, with no `init()` | `selftest.mjs` output below, 7/7 variants identified, 4/4 negative tests | **verified by running it** |
| The user-friendly address derives from the returned public key | `PublicKey.fromHex(pk).toAddress().toUserFriendlyAddress()`, asserted in the selftest | **verified by running it** |
| A public mainnet node agrees with our verifier | live `verifySignature` calls to `rpc.nimiqwatch.com`, accept + reject, in the selftest output | **verified against the live endpoint** |
| Nimiq Pay's *native* `sign()` actually uses this scheme | — | **NOT verified. Needs the phone test.** |

The spike proves the tooling. It does **not** prove the wallet. Gate N11 is not closed until the
phone test in [Owner steps](#owner-steps-the-phone-test) has run.

---

## 1. What the source says

### 1.1 The JS provider does not hash anything

`nimiq/trust-web3-provider`, branch `nimiq`, commit `49cfe535b90c` (2026-05-26),
`packages/nimiq/NimiqProvider.ts` line 104:

```ts
sign(message: string | { message: string, isHex?: boolean }): Promise<SignatureResult | ErrorResponse> {
  return this.#internalRequest<SignatureResult>({
    method: 'sign',
    params: typeof message === 'string' ? { message } : message,
  });
}
```

It forwards the raw string to the native handler and returns `{ publicKey, signature }` as hex
(`SignatureResult`, same file, lines 8-11 — `publicKey: string, signature: string`). **All prefixing and hashing happens natively inside
Nimiq Pay, not in JavaScript** — so the provider repo cannot answer the question on its own. Note
the undocumented second form: `sign({ message, isHex: true })`, which tells the wallet to decode
the string as hex bytes first.

`sign` is in `NimiqProvider.WALLET_METHODS` (lines 47-58), so it is always routed to the native
handler and never to a JSON-RPC node.

### 1.2 The scheme, from the Rust implementation

`nimiq/core-rs-albatross`, branch `albatross`, commit `ea372ecbc784` (2026-09-10),
`wallet/src/wallet_account.rs`:

```rust
// line 9
pub const NIMIQ_SIGN_MESSAGE_PREFIX: &[u8] = b"\x16Nimiq Signed Message:\n";

// lines 60-79
fn prepare_message_for_signature(message: &[u8]) -> Sha256Hash {
    let mut buffer = NIMIQ_SIGN_MESSAGE_PREFIX.to_vec();
    // Append length of message as encoded string.
    let mut encoded_len = message.len().to_string().into_bytes();
    buffer.append(&mut encoded_len);
    // Append actual message.
    buffer.extend_from_slice(message);
    // Hash and sign.
    buffer.hash::<Sha256Hash>()
}

// lines 81-84
pub fn sign_message(&self, message: &[u8]) -> (Ed25519PublicKey, Ed25519Signature) {
    let hash = Self::prepare_message_for_signature(message);
    (self.key_pair.public, self.key_pair.sign(hash.as_bytes()))
}
```

So, precisely:

```
preimage  = "\x16Nimiq Signed Message:\n" || ascii_decimal(byteLength(message)) || message
digest    = SHA-256(preimage)                        // 32 bytes
signature = Ed25519_sign(privateKey, digest)         // the 32-byte digest IS the Ed25519 message
```

Three details that are easy to get wrong:

- `\x16` is a real 0x16 byte, not the two characters `\` and `x16`. It is the length of the rest of
  the prefix (`Nimiq Signed Message:\n` is 22 = 0x16 bytes) — the same self-describing trick as
  EIP-191, which the source comment cites.
- The length field is the **byte** length of the message, rendered as ASCII decimal digits
  (`"66"`, not a varint, not a 4-byte integer).
- Ed25519 signs the 32-byte SHA-256 digest **as its message**. It is not a pre-hash variant
  (`Ed25519ph`); Ed25519 then does its own internal hashing over those 32 bytes.

The comment on lines 61-68 gives the reason: the prefix makes a signature recognisable as
Nimiq-specific and prevents a malicious mini app from getting a valid *transaction* signed by
handing it to `sign()`.

### 1.3 A second prefix exists

`nimiq/keyguard`, commit `99bf5ae57a3b`, `client/src/SignMessagePrefix.ts` lines 10-13:

```ts
export enum SignMessagePrefix {
    SIGNED_MESSAGE = '\x16Nimiq Signed Message:\n',
    CONNECT_CHALLENGE = '\x19Nimiq Connect Challenge:\n', // blind signed, thus must be distinct
}
```

Nimiq Pay is a different codebase from Keyguard, and it is *possible* the mini-app `sign()` bridge
uses the connect-challenge prefix instead. `verify.mjs` therefore tries both, and reports which one
matched rather than assuming.

### 1.4 The JSON-RPC method uses the same scheme

`core-rs-albatross :: rpc-interface/src/wallet.rs` lines 60-67 — **positional** params:

```rust
/// Verifies the signature based on the provided public key and message.
async fn verify_signature(
    &self,
    message: String,
    public_key: Ed25519PublicKey,
    signature: Ed25519Signature,
    is_hex: bool,
) -> RPCResult<bool, (), Self::Error>;
```

`core-rs-albatross :: rpc-server/src/dispatchers/wallet.rs` lines 182-191 shows it is the *same*
code path we reimplemented:

```rust
let message = message_from_maybe_hex(message, is_hex)?;
Ok(WalletAccount::verify_message(&public_key, &message, &signature).into())
```

Wire format, confirmed live against `https://rpc.nimiqwatch.com`:

```jsonc
// request
{"jsonrpc":"2.0","id":1,"method":"verifySignature",
 "params":["<message>", "<publicKeyHex>", "<signatureHex>", false]}
// response
{"jsonrpc":"2.0","result":{"data":true,"metadata":null},"id":1}
```

Results are wrapped in `result.data`. Rate limit is 20 tokens / 10 s / IP; the selftest spends 2.

### 1.5 `@nimiq/core` 2.21.0 API actually used

From `node_modules/@nimiq/core/types/wasm/bundler.d.ts` after install:

| Need | Call |
|---|---|
| parse public key | `PublicKey.fromHex(hex)` (line 1979) |
| parse signature | `Signature.fromHex(hex)` (line 2094) |
| verify | `publicKey.verify(signature, data: Uint8Array): boolean` (line 2013) |
| derive address | `publicKey.toAddress()` (line 2005) → `.toUserFriendlyAddress()` (line 724) |
| SHA-256 | `Hash.computeSha256(data): Uint8Array` (line 1430) |
| test keypair | `KeyPair.generate()` (1484), `.sign(data)` (1493), `.toAddress()` (1501) |

The Node export **does** load the WASM synchronously with no `init()` — `typeof Nimiq.init` is
`undefined` and the classes are usable on the first tick after `import`. Measured import cost:
**165 ms** on this machine.

---

## 2. Selftest output (real, verbatim)

`node selftest.mjs`, run 2026-09-13 07:54 UTC on Windows 11, node v24.19.0, exit code 0:

```
=== Rewind spike selftest: sign/verify variant identification ===
node v24.19.0  platform win32  2026-09-13T07:54:11.024Z

generated keypair -> address NQ92 8RT9 E7YX C8DV 9HAF 8P4S K5MD GYTC TB4V
public key 2d7c82fc258dc4d03bb4ef3bad46db34bc8c8111e8037b1b3c58728e075bf62e
(private key intentionally never printed)

challenge: REWIND_SPIKE_V1 nonce=1ff995e47ecee924 ts=2026-09-13T07:54:11.028Z
challenge byte length: 66

--- 7 variants under test ---
PASS  variant "nimiq-prefixed-sha256"  -> matched=nimiq-prefixed-sha256 verifiedCount=1 addrMatch=true
PASS  variant "raw-utf8"  -> matched=raw-utf8 verifiedCount=1 addrMatch=true
PASS  variant "sha256"  -> matched=sha256 verifiedCount=1 addrMatch=true
PASS  variant "nimiq-prefixed-raw"  -> matched=nimiq-prefixed-raw verifiedCount=1 addrMatch=true
PASS  variant "nimiq-prefixed-nolen-sha256"  -> matched=nimiq-prefixed-nolen-sha256 verifiedCount=1 addrMatch=true
PASS  variant "connect-challenge-sha256"  -> matched=connect-challenge-sha256 verifiedCount=1 addrMatch=true
PASS  variant "sha256-of-sha256"  -> matched=sha256-of-sha256 verifiedCount=1 addrMatch=true

--- negative tests ---
PASS  tampered message verifies under no variant  ok=false
PASS  wrong public key verifies under no variant  ok=false
PASS  valid signature but foreign account fails gate N11  ok=true addrMatch=false gate=false
PASS  malformed hex is rejected cleanly  publicKey unusable: not a hex string: "zz"

--- address derivation ---
PASS  PublicKey.toAddress().toUserFriendlyAddress() == KeyPair address  NQ92 8RT9 E7YX C8DV 9HAF 8P4S K5MD GYTC TB4V
PASS  derived address is user-friendly IBAN form  NQ92 8RT9 E7YX C8DV 9HAF 8P4S K5MD GYTC TB4V
PASS  Signature hex round-trips
PASS  signature is 64 bytes  128 hex chars
PASS  public key is 32 bytes  64 hex chars

--- live RPC cross-check (nimiqwatch, read-only) ---
  request : verifySignature ["<challenge>", "<pubkey>", "<sig>", false]
  response: {"jsonrpc":"2.0","result":{"data":true,"metadata":null},"id":1789286051043}
PASS  RPC verifySignature accepts a nimiq-prefixed-sha256 signature  ok=true error=null
  response (raw-utf8 signature): {"jsonrpc":"2.0","result":{"data":false,"metadata":null},"id":1789286051688}
PASS  RPC verifySignature rejects a raw-utf8 signature (confirms the prefix scheme)  ok=false

=== ALL PASS ===
```

The last two lines are the load-bearing ones: an independent mainnet node accepts a signature we
built with `nimiq-prefixed-sha256` and rejects one over the raw UTF-8 bytes. That confirms the
scheme end-to-end against something we do not control.

### Server loop, also exercised without a phone

`node server.mjs`, then POST a synthetic payload (`node mkpayload.mjs` writes one):

```
$ curl -sS -X POST http://localhost:8787/verify -H 'Content-Type: application/json' \
    --data-binary @payload.sample.json
{
  "ok": true,
  "matchedVariant": "nimiq-prefixed-sha256",
  "derivedAddress": "NQ26 08YN T62D 3QBM 4RYR 6Y8C G4X3 46FG YTGC",
  "addressMatchesAccount": true,
  "rpcOk": true,
  "gateN11": { "variantVerified": true, "addressMatchesAccount": true, "pass": true },
  "verifiedVariants": ["nimiq-prefixed-sha256"]
}
```

CORS preflight returns `204` with `Access-Control-Allow-Origin: *`, so the phone can POST across
the LAN origin boundary.

---

## 3. Node 24 / Windows notes

**Install.** `npm install` for `@nimiq/core@2.21.0` and for the Vite page both succeeded with no
warnings worth acting on, no native build step, no postinstall. `npm run build` for the page:
`tsc --noEmit && vite build`, 4 modules, 143 ms, clean.

**WASM.** No `init()` needed, no top-level-await gymnastics, no `--experimental-*` flag. The
`nodejs/index.mjs` export loads the WASM synchronously (165 ms).

**One real defect found — process abort at exit.** With both the `@nimiq/core` WASM worker and a
live `fetch()` connection open, Node 24.19.0 on Windows aborts during teardown:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

Exit code `127`, reproducible 3/3. It happens strictly **after** all output — every assertion had
already passed — but a script that is checked by exit code would read it as a failure. Neither
`process.exit()` nor `process.exitCode` avoids it; minimal repros with one WASM object plus one
fetch do *not* trigger it, so it needs both the WASM worker and a pool of live sockets. The fix in
`selftest.mjs` is to close undici's keep-alive pool before teardown:

```js
try { await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close(); } catch {}
```

Exit code `0`, no assertion, 3/3 runs. **Anything in the real app that mixes `@nimiq/core` with
`fetch` in a short-lived Node process needs this, or it will exit 127 in CI.** That relies on an
undocumented Node internal symbol; treat it as a workaround with a shelf life, not a fact about
Node.

---

## 4. Files

| File | What it is |
|---|---|
| `verify.mjs` | The verifier. Exports `verifySigned()`, `buildVariants()`, `rpcVerifySignature()`. Also a CLI. |
| `selftest.mjs` | Proves the verifier with a generated keypair, no phone. `--no-rpc` skips the network. |
| `server.mjs` | Node `http` server, `0.0.0.0:8787`, CORS open, `POST /verify`, writes `captures/`. LAN-only throwaway. |
| `mkpayload.mjs` | Dev helper: writes a `payload.sample.json` shaped exactly like the phone's POST body. |
| `page/` | Vite + vanilla TypeScript mini app for the phone. No dependencies beyond vite + typescript. |

`captures/`, `payload*.json`, `server.log`, `dist/`, `node_modules/` and `.env.local` are
gitignored. No secrets exist in this spike: it never handles a private key, and the selftest's
throwaway key is generated in memory and never printed.

**Safety of the page.** It calls only `listAccounts()` and `sign()`. It never calls
`sendBasicTransaction*` or any other write method, so no transaction and no spend can originate
from it. `sign()` still raises the wallet's own confirmation sheet.

---

## Owner steps: the phone test

Two terminals on the laptop, phone on the **same Wi-Fi**.

**Terminal 1 — verify server**

```powershell
cd C:\Users\hyada\dev\rewind\spikes\sign-verify
node server.mjs
```

It prints its LAN addresses. On this machine, at the time of writing, the Wi-Fi one was
**`http://172.16.38.108:8787`** — `192.168.56.1` is the VirtualBox adapter, ignore it. Re-read the
printout each time; DHCP moves it.

**Terminal 2 — page**

```powershell
cd C:\Users\hyada\dev\rewind\spikes\sign-verify\page
npm run dev -- --host
```

Vite prints a `Network:` URL, e.g. `http://172.16.38.108:5173/`. Use the address on the *same*
interface as the server.

**Windows Firewall** will likely prompt on first run, or silently drop the connection. Allow node
on **private** networks. If the phone cannot load the page, that is the first thing to check —
from the phone's browser, `http://<lan-ip>:5173` should load before you try Nimiq Pay at all.

**On the phone**

1. Nimiq Pay → **Mini Apps** → **Custom URL**.
2. Enter `http://<lan-ip>:5173` and open it.
   - **Unverified:** whether Nimiq Pay accepts a plain `http://` LAN URL at all. It may demand
     HTTPS. If it refuses, the fallback is `npx localtunnel --port 5173` or a Cloudflare quick
     tunnel for an HTTPS URL — but that is a *public* URL, so treat it as an external action and
     get it authorised first.
3. Card 1 should say `window.nimiq : PRESENT`. **Screenshot card 1.** If it says MISSING, stop —
   the provider is not being injected and nothing below will work.
4. Tap **Connect (listAccounts)**. Addresses appear. **Screenshot card 2.**
5. Read the challenge in card 3. Tap **Sign**. Approve the native confirmation.
6. Card 4 fills with the JSON. **Screenshot card 4** and tap **Copy JSON**.
7. Tap **Send to server**. Card 5 shows the report. **Screenshot card 5**, especially the
   `N11 PASS` / `N11 FAIL` badge and the `matchedVariant` line.
8. **Screenshot the Log card** — it records exactly which provider calls succeeded and how.

**If the server is unreachable** (firewall, wrong IP), the page still works: card 4 holds the full
JSON. Copy it, paste it into `payload.json` on the laptop, and run:

```powershell
cd C:\Users\hyada\dev\rewind\spikes\sign-verify
node verify.mjs --file payload.json --rpc
```

**Paste back into the gate record:** the `matchedVariant` string, the `derivedAddress`, the
`accounts` array, `addressMatchesAccount`, `rpc.ok`, and the whole `gateN11` block. The raw
payload and report are also saved automatically to `captures/` on the laptop.

### Expected outcome

`matchedVariant` is `"nimiq-prefixed-sha256"`, exactly one variant verifies, `derivedAddress`
equals one of the `listAccounts()` addresses, and `rpc.ok` is `true`.

If a *different* variant matches, that is still a **pass for the project** — it means Nimiq Pay
uses a different scheme than the Rust wallet, and `verify.mjs` has just told us which one. Record
the variant name; that becomes the pinned fact.

If **no** variant matches, the gate fails and the next step is to capture `sign()` output for a
one-character message (e.g. `"a"`) and brute-force the preimage offline against the 64 bytes.

### PASS criteria for gate N11

Gate N11 passes when, from a real phone in Nimiq Pay, **both** hold:

1. **A variant verifies** — `report.ok === true`, i.e. some entry in `report.variants` has
   `verified: true`. Which variant it is does not decide the gate, only what we pin.
2. **The derived address is the signer** — `report.addressMatchesAccount === true`, i.e.
   `PublicKey.fromHex(publicKey).toAddress().toUserFriendlyAddress()` equals one of the addresses
   `listAccounts()` returned, compared ignoring spaces and case.

`report.gateN11.pass` is exactly that conjunction. The server also logs `GATE_N11=PASS|FAIL` per
request.

Not required for the gate, but recorded: `rpc.ok === true` from `rpc.nimiqwatch.com`, which shows
an independent node agrees.

---

## Open / unverified

1. **Nimiq Pay's actual `sign()` semantics.** Everything above is the Rust wallet and Keyguard.
   The native mini-app bridge is closed source and was not read. Only the phone test settles it.
2. **Whether a plain `http://` LAN URL is accepted by Nimiq Pay's Custom URL.** Nimiq's docs
   describe `npm run dev -- --host` for local testing but do not state the scheme requirement.
3. **Whether `sign()` lets the user pick which account signs**, or always signs with the active
   one. `listAccounts()` can return several; the address check is written against the whole array
   for that reason.
4. **The `isHex: true` form of `sign()`** is in the provider types but is undocumented and was not
   exercised. `verify.mjs` covers the hex-decode variant only when the message happens to be pure
   hex.
5. **The undici-dispatcher workaround** depends on an undocumented Node internal symbol and may
   break on a Node upgrade.
6. **Nothing here was tested on iOS**, or on any phone at all.
7. `@nimiq/core`'s browser/`vite` exports were not exercised — this spike only verifies
   server-side, which is the point of the gate.
