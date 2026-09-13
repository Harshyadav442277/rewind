/**
 * Rewind spike — gate N11: server-side verification of a Nimiq Pay `window.nimiq.sign()` result.
 *
 * Message semantics (primary source, see README.md):
 *   nimiq/core-rs-albatross :: wallet/src/wallet_account.rs
 *     const NIMIQ_SIGN_MESSAGE_PREFIX: &[u8] = b"\x16Nimiq Signed Message:\n";   (line 9)
 *     fn prepare_message_for_signature(message) -> Sha256Hash                    (lines 60-79)
 *       buffer = PREFIX || ascii(message.len()) || message
 *       digest = sha256(buffer)
 *     fn sign_message(message) -> (pk, ed25519_sign(digest))                     (lines 81-84)
 *
 * This module does not assume that is what Nimiq Pay does. It tries every plausible
 * variant and reports which one actually verified.
 */

import {
  Address,
  Hash,
  PublicKey,
  Signature,
} from '@nimiq/core';

const enc = new TextEncoder();

/** Prefixes from nimiq/keyguard :: client/src/SignMessagePrefix.ts */
export const SIGN_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n';
export const CONNECT_CHALLENGE_PREFIX = '\x19Nimiq Connect Challenge:\n';

export function normalizeHex(s) {
  if (typeof s !== 'string') throw new TypeError('hex value must be a string');
  const h = s.trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error(`not a hex string: ${JSON.stringify(s.slice(0, 32))}`);
  return h.toLowerCase();
}

export function hexToBytes(hex) {
  const h = normalizeHex(hex);
  if (h.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Build the exact byte string that `prepare_message_for_signature` hashes.
 * NOTE: the length is the byte length of the message, rendered as ASCII decimal.
 */
export function nimiqSignedMessagePreimage(messageBytes, prefix = SIGN_MESSAGE_PREFIX) {
  return concat(enc.encode(prefix), enc.encode(String(messageBytes.length)), messageBytes);
}

/**
 * Every candidate interpretation of "what bytes did the wallet actually Ed25519-sign".
 * Each returns the Uint8Array handed to Ed25519 as its message.
 */
export function buildVariants(message, { treatMessageAsHex = 'auto' } = {}) {
  const utf8 = enc.encode(message);

  const variants = [
    {
      name: 'nimiq-prefixed-sha256',
      description: 'sha256("\\x16Nimiq Signed Message:\\n" + byteLen + utf8(message)) — albatross WalletAccount::sign_message',
      data: Hash.computeSha256(nimiqSignedMessagePreimage(utf8, SIGN_MESSAGE_PREFIX)),
      preimage: nimiqSignedMessagePreimage(utf8, SIGN_MESSAGE_PREFIX),
    },
    {
      name: 'raw-utf8',
      description: 'raw utf8(message) bytes, no prefix, no hash',
      data: utf8,
      preimage: utf8,
    },
    {
      name: 'sha256',
      description: 'sha256(utf8(message)), no prefix',
      data: Hash.computeSha256(utf8),
      preimage: utf8,
    },
    {
      name: 'nimiq-prefixed-raw',
      description: 'prefix + byteLen + utf8(message), NOT hashed',
      data: nimiqSignedMessagePreimage(utf8, SIGN_MESSAGE_PREFIX),
      preimage: nimiqSignedMessagePreimage(utf8, SIGN_MESSAGE_PREFIX),
    },
    {
      name: 'nimiq-prefixed-nolen-sha256',
      description: 'sha256(prefix + utf8(message)) — prefix but no length field',
      data: Hash.computeSha256(concat(enc.encode(SIGN_MESSAGE_PREFIX), utf8)),
      preimage: concat(enc.encode(SIGN_MESSAGE_PREFIX), utf8),
    },
    {
      name: 'connect-challenge-sha256',
      description: 'sha256("\\x19Nimiq Connect Challenge:\\n" + byteLen + utf8(message)) — keyguard CONNECT_CHALLENGE prefix',
      data: Hash.computeSha256(nimiqSignedMessagePreimage(utf8, CONNECT_CHALLENGE_PREFIX)),
      preimage: nimiqSignedMessagePreimage(utf8, CONNECT_CHALLENGE_PREFIX),
    },
    {
      name: 'sha256-of-sha256',
      description: 'sha256(sha256(utf8(message))) — paranoia check for double hashing',
      data: Hash.computeSha256(Hash.computeSha256(utf8)),
      preimage: utf8,
    },
  ];

  // The provider accepts sign({ message, isHex: true }); if the challenge happens to be
  // pure hex, the wallet may have decoded it to bytes first.
  const looksHex = /^(0x)?[0-9a-fA-F]+$/.test(message.trim()) && normalizeHex(message).length % 2 === 0;
  if (treatMessageAsHex === true || (treatMessageAsHex === 'auto' && looksHex)) {
    const raw = hexToBytes(message);
    variants.push({
      name: 'hexdecoded-nimiq-prefixed-sha256',
      description: 'message decoded from hex first, then prefix + byteLen + bytes, sha256 (provider isHex:true path)',
      data: Hash.computeSha256(nimiqSignedMessagePreimage(raw, SIGN_MESSAGE_PREFIX)),
      preimage: nimiqSignedMessagePreimage(raw, SIGN_MESSAGE_PREFIX),
    });
  }

  return variants;
}

/**
 * Verify a Nimiq Pay signature against every variant.
 *
 * @param {object} input
 * @param {string} input.message    the exact challenge string that was signed
 * @param {string} input.publicKey  32-byte Ed25519 public key, hex
 * @param {string} input.signature  64-byte Ed25519 signature, hex
 * @param {string[]} [input.accounts] user-friendly addresses from listAccounts(), for the address check
 * @param {string|null} [input.rpcUrl] optional JSON-RPC endpoint for an independent cross-check
 * @returns {Promise<object>} result report (plain JSON, safe to send over the wire)
 */
export async function verifySigned({ message, publicKey, signature, accounts = [], rpcUrl = null }) {
  const report = {
    ok: false,
    matchedVariant: null,
    message,
    messageByteLength: enc.encode(String(message ?? '')).length,
    publicKey: null,
    signature: null,
    derivedAddress: null,
    accounts,
    addressMatchesAccount: null,
    variants: [],
    rpc: null,
    errors: [],
  };

  if (typeof message !== 'string') {
    report.errors.push('message must be a string');
    return report;
  }

  let pk, sig;
  try {
    report.publicKey = normalizeHex(publicKey);
    pk = PublicKey.fromHex(report.publicKey);
  } catch (e) {
    report.errors.push(`publicKey unusable: ${e.message}`);
    return report;
  }
  try {
    report.signature = normalizeHex(signature);
    sig = Signature.fromHex(report.signature);
  } catch (e) {
    report.errors.push(`signature unusable: ${e.message}`);
    return report;
  }

  try {
    report.derivedAddress = pk.toAddress().toUserFriendlyAddress();
  } catch (e) {
    report.errors.push(`address derivation failed: ${e.message}`);
  }

  for (const v of buildVariants(message)) {
    let verified = false;
    let error = null;
    try {
      verified = pk.verify(sig, v.data);
    } catch (e) {
      error = e.message;
    }
    report.variants.push({
      name: v.name,
      description: v.description,
      verified,
      signedBytesHex: bytesToHex(v.data),
      signedBytesLength: v.data.length,
      ...(error ? { error } : {}),
    });
    if (verified && !report.matchedVariant) {
      report.matchedVariant = v.name;
      report.ok = true;
    }
  }

  if (report.derivedAddress && Array.isArray(accounts) && accounts.length) {
    const norm = (a) => String(a).replace(/\s+/g, '').toUpperCase();
    report.addressMatchesAccount = accounts.some((a) => norm(a) === norm(report.derivedAddress));
  }

  // Free the WASM-backed objects: leaving many of them to the finalizer has been observed
  // to abort the process at teardown on Windows (see README, "Node 24 Windows notes").
  try { pk.free(); } catch { /* already freed */ }
  try { sig.free(); } catch { /* already freed */ }

  if (rpcUrl) {
    report.rpc = await rpcVerifySignature({ rpcUrl, message, publicKey: report.publicKey, signature: report.signature });
  }

  // Gate N11 passes only when a variant verifies AND the derived address is one of the accounts.
  report.gateN11 = {
    variantVerified: report.ok,
    addressMatchesAccount: report.addressMatchesAccount,
    pass: report.ok === true && report.addressMatchesAccount === true,
  };

  return report;
}

/**
 * Independent cross-check against a Nimiq Albatross JSON-RPC node.
 *
 * Params are POSITIONAL: [message, publicKey, signature, isHex]
 * Source: nimiq/core-rs-albatross :: rpc-interface/src/wallet.rs lines 60-67
 *   async fn verify_signature(&self, message: String, public_key: Ed25519PublicKey,
 *                             signature: Ed25519Signature, is_hex: bool) -> RPCResult<bool, ...>
 * Implementation: rpc-server/src/dispatchers/wallet.rs lines 182-191, which calls
 *   WalletAccount::verify_message(...) — i.e. exactly the prefixed+sha256 scheme above.
 * Result envelope is {"jsonrpc":"2.0","result":{"data":<bool>,"metadata":null},"id":n}
 */
export async function rpcVerifySignature({ rpcUrl, message, publicKey, signature, isHex = false, timeoutMs = 8000 }) {
  const out = { url: rpcUrl, requested: true, ok: null, raw: null, error: null };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'verifySignature',
        params: [message, normalizeHex(publicKey), normalizeHex(signature), isHex],
      }),
      signal: ac.signal,
    });
    const json = await res.json();
    out.raw = json;
    if (json?.error) out.error = json.error.message || JSON.stringify(json.error);
    else out.ok = json?.result?.data ?? null;
  } catch (e) {
    out.error = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message;
  } finally {
    clearTimeout(t);
  }
  return out;
}

/* ------------------------------- CLI ------------------------------- */

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify.mjs')) {
  const args = parseArgv(process.argv.slice(2));
  let payload;

  if (args.file) {
    const { readFile } = await import('node:fs/promises');
    payload = JSON.parse(await readFile(args.file, 'utf8'));
  } else if (args.message && args.publicKey && args.signature) {
    payload = { message: args.message, publicKey: args.publicKey, signature: args.signature };
    if (args.accounts) payload.accounts = String(args.accounts).split(',').map((s) => s.trim());
  } else {
    const stdin = (await readStdin()).trim();
    if (!stdin) {
      console.error('usage: node verify.mjs --message "<challenge>" --publicKey <hex> --signature <hex> [--accounts "NQ.. ,NQ.."] [--rpc https://rpc.nimiqwatch.com]');
      console.error('   or: node verify.mjs --file payload.json');
      console.error('   or: cat payload.json | node verify.mjs');
      process.exit(2);
    }
    payload = JSON.parse(stdin);
  }

  if (args.rpc) payload.rpcUrl = args.rpc === true ? 'https://rpc.nimiqwatch.com' : args.rpc;

  const report = await verifySigned(payload);
  console.log(JSON.stringify(report, null, 2));
  // process.exit() aborts with a libuv assertion on Windows after fetch(); set the code instead.
  process.exitCode = report.ok ? 0 : 1;
}
