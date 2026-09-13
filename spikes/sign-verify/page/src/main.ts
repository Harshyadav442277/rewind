/**
 * Rewind spike — phone page for gate N11.
 *
 * Loaded inside Nimiq Pay (Mini Apps -> Custom URL). Calls only the two read-only
 * provider methods: listAccounts() and sign(). Never calls any send* method, so no
 * transaction and no spend is possible from this page.
 *
 * The page is useful even with the verify server down: the JSON payload is always
 * rendered and copyable for manual verification with `node verify.mjs --file payload.json`.
 */

/* ---------- the provider surface we rely on (docs: nimiq.dev/mini-apps/api-reference/nimiq-provider) ---------- */
type SignatureResult = { publicKey: string; signature: string };
type ErrorResponse = { error: { type: string; message: string } };

interface NimiqProvider {
  listAccounts(): Promise<string[] | ErrorResponse>;
  sign(message: string | { message: string; isHex?: boolean }): Promise<SignatureResult | ErrorResponse>;
  isConsensusEstablished?(): Promise<boolean>;
  getBlockNumber?(): Promise<number>;
}

declare global {
  interface Window {
    nimiq?: NimiqProvider;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const els = {
  env: $<HTMLPreElement>('env'),
  connect: $<HTMLButtonElement>('connect'),
  accounts: $<HTMLUListElement>('accounts'),
  challenge: $<HTMLPreElement>('challenge'),
  newChallenge: $<HTMLButtonElement>('newChallenge'),
  sign: $<HTMLButtonElement>('sign'),
  payload: $<HTMLTextAreaElement>('payload'),
  payloadBadge: $<HTMLSpanElement>('payloadBadge'),
  copy: $<HTMLButtonElement>('copy'),
  send: $<HTMLButtonElement>('send'),
  serverUrl: $<HTMLInputElement>('serverUrl'),
  gateBadge: $<HTMLSpanElement>('gateBadge'),
  result: $<HTMLPreElement>('result'),
  log: $<HTMLPreElement>('log'),
};

const lines: string[] = [];
function log(msg: string): void {
  lines.push(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
  els.log.textContent = lines.slice(-40).join('\n');
}

function badge(el: HTMLElement, text: string, kind: 'ok' | 'bad' | 'idle'): void {
  el.textContent = text;
  el.className = `badge ${kind}`;
}

function isError(x: unknown): x is ErrorResponse {
  return typeof x === 'object' && x !== null && 'error' in x;
}

/* ---------- challenge ---------- */

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newChallenge(): string {
  // 16 hex chars = 8 random bytes.
  return `REWIND_SPIKE_V1 nonce=${randomHex(8)} ts=${new Date().toISOString()}`;
}

let challenge = newChallenge();
let accounts: string[] = [];
let payload: Record<string, unknown> | null = null;

function renderChallenge(): void {
  els.challenge.textContent = challenge;
}

/* ---------- environment ---------- */

function describeEnv(): void {
  const p = window.nimiq;
  const methods = p
    ? (['listAccounts', 'sign', 'isConsensusEstablished', 'getBlockNumber', 'sendBasicTransactionWithData'] as const)
        .map((m) => `${m}:${typeof (p as unknown as Record<string, unknown>)[m] === 'function' ? 'yes' : 'no'}`)
        .join('  ')
    : '—';
  els.env.textContent = [
    `window.nimiq  : ${p ? 'PRESENT' : 'MISSING (not inside Nimiq Pay?)'}`,
    `methods       : ${methods}`,
    `origin        : ${location.origin}`,
    `protocol      : ${location.protocol}`,
    `secureContext : ${window.isSecureContext}`,
    `userAgent     : ${navigator.userAgent}`,
  ].join('\n');
  els.connect.disabled = !p;
}

/* ---------- actions ---------- */

async function connect(): Promise<void> {
  const p = window.nimiq;
  if (!p) { log('window.nimiq is missing — open this page inside Nimiq Pay'); return; }
  els.connect.disabled = true;
  try {
    log('calling listAccounts()…');
    const res = await p.listAccounts();
    if (isError(res)) { log(`listAccounts error: ${res.error.type} ${res.error.message}`); return; }
    accounts = res;
    // textContent, not innerHTML: the addresses come from the wallet, but this page must not
    // be able to inject markup from provider output.
    els.accounts.replaceChildren();
    if (accounts.length === 0) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.textContent = 'no accounts returned';
      els.accounts.append(li);
    } else {
      for (const a of accounts) {
        const li = document.createElement('li');
        li.textContent = a;
        els.accounts.append(li);
      }
    }
    log(`listAccounts() -> ${accounts.length} account(s)`);
    els.sign.disabled = accounts.length === 0;
    // Optional, purely informational, both read-only.
    try { if (p.getBlockNumber) log(`getBlockNumber() -> ${await p.getBlockNumber()}`); } catch (e) { log(`getBlockNumber failed: ${String(e)}`); }
    try { if (p.isConsensusEstablished) log(`isConsensusEstablished() -> ${await p.isConsensusEstablished()}`); } catch (e) { log(`isConsensusEstablished failed: ${String(e)}`); }
  } catch (e) {
    log(`listAccounts threw: ${String(e)}`);
  } finally {
    els.connect.disabled = false;
  }
}

async function sign(): Promise<void> {
  const p = window.nimiq;
  if (!p) { log('window.nimiq is missing'); return; }
  els.sign.disabled = true;
  try {
    log(`calling sign() on ${challenge.length}-char challenge…`);
    const res = await p.sign(challenge);
    if (isError(res)) { log(`sign error: ${res.error.type} ${res.error.message}`); return; }
    payload = {
      message: challenge,
      accounts,
      publicKey: res.publicKey,
      signature: res.signature,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };
    els.payload.value = JSON.stringify(payload, null, 2);
    badge(els.payloadBadge, 'captured', 'ok');
    log(`sign() -> publicKey ${res.publicKey.length} chars, signature ${res.signature.length} chars`);
  } catch (e) {
    log(`sign threw: ${String(e)}`);
  } finally {
    els.sign.disabled = accounts.length === 0;
  }
}

/**
 * Copy with a deliberate fallback chain: the mini-app webview may deny the async
 * Clipboard API (needs a secure context and permission) and the SDK has no clipboard
 * bridge, so execCommand('copy') over a selected textarea is the reliable path.
 */
async function copyPayload(): Promise<void> {
  const text = els.payload.value;
  if (!text) { log('nothing to copy'); return; }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      log('copied via navigator.clipboard');
      return;
    }
    throw new Error('clipboard API unavailable');
  } catch (e) {
    log(`clipboard API failed (${String(e)}), falling back to execCommand`);
    els.payload.removeAttribute('readonly');
    els.payload.focus();
    els.payload.setSelectionRange(0, text.length);
    els.payload.select();
    let done = false;
    try { done = document.execCommand('copy'); } catch (e2) { log(`execCommand threw: ${String(e2)}`); }
    els.payload.setAttribute('readonly', 'readonly');
    log(done ? 'copied via execCommand' : 'copy failed — select the textarea and copy by hand');
  }
}

async function sendToServer(): Promise<void> {
  if (!payload) { log('no payload yet — press Sign first'); return; }
  const base = els.serverUrl.value.trim().replace(/\/+$/, '');
  if (!base) { log('no server URL set'); return; }
  els.send.disabled = true;
  badge(els.gateBadge, 'checking…', 'idle');
  try {
    log(`POST ${base}/verify …`);
    const res = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const report = await res.json();
    els.result.textContent = JSON.stringify(report, null, 2);
    const pass = report?.gateN11?.pass === true;
    badge(els.gateBadge, pass ? 'N11 PASS' : 'N11 FAIL', pass ? 'ok' : 'bad');
    log(`server: matched=${report?.matchedVariant} addr=${report?.derivedAddress} accountMatch=${report?.addressMatchesAccount} rpc=${report?.rpc?.ok}`);
  } catch (e) {
    badge(els.gateBadge, 'server unreachable', 'bad');
    els.result.textContent =
      `Server unreachable: ${String(e)}\n\n` +
      `The payload above is still valid evidence. Copy it, save it as payload.json on the laptop and run:\n` +
      `  cd spikes/sign-verify\n  node verify.mjs --file payload.json --rpc`;
    log(`POST failed: ${String(e)}`);
  } finally {
    els.send.disabled = false;
  }
}

/* ---------- wiring ---------- */

els.connect.addEventListener('click', () => { void connect(); });
els.sign.addEventListener('click', () => { void sign(); });
els.copy.addEventListener('click', () => { void copyPayload(); });
els.send.addEventListener('click', () => { void sendToServer(); });
els.newChallenge.addEventListener('click', () => {
  challenge = newChallenge();
  renderChallenge();
  payload = null;
  els.payload.value = '';
  badge(els.payloadBadge, 'empty', 'idle');
  badge(els.gateBadge, 'not run', 'idle');
  log('new challenge generated');
});

// Default the verify server to the same host the page came from, on port 8787.
els.serverUrl.value = `${location.protocol}//${location.hostname}:8787`;
renderChallenge();
describeEnv();
log('page loaded');

// Makes this file a module so the `declare global` block above is legal.
export {};
