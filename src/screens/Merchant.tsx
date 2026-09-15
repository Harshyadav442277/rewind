import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type MerchantRequestRow,
  type MerchantSession,
  type RegisteredMerchant,
} from '../api';
import { hashFor } from '../App';
import { Banner, Card, Disclosure, Kv, Mono, Pill, timeAgo, toneForState } from '../components/ui';
import {
  isPayableLuna,
  MAX_LABEL_LENGTH,
  MAX_LINK_LUNA,
  formatNim,
  nimToLuna,
  paymentLinkFor,
} from '../pay';
import { readSavedMerchant, readSentRefunds, rememberSentRefund, saveMerchant } from '../storage';
import { messageOf } from '../errors';
import { getWallet } from '../wallet';

/** Must match `server/domain/merchant-registration.ts`, byte for byte. */
export const REGISTRATION_HEADER = 'REWIND_MERCHANT_REGISTER_V1';
export const MAX_SHOP_NAME_LENGTH = 40;
export const SHARE_NOTE = 'Share it. The buyer opens it inside Nimiq Pay.';
export const REFUND_SENT_NOTE = 'Sent. Rewind marks it refunded once the chain shows it.';

/**
 * A refund this device handed to the wallet is not offered again for this long, so a second tap
 * while the chain catches up cannot send the merchant's NIM twice. After it, the button comes
 * back with a warning, because a wallet that said "ok" and never broadcast must not leave the
 * buyer stuck.
 */
const RESEND_AFTER_MS = 10 * 60_000;

export function registrationMessage(name: string, issuedAtSec: number): string {
  return [REGISTRATION_HEADER, `name=${name}`, `issued=${issuedAtSec}`].join('\n');
}

/** The server's rules for a shop name, checked before the wallet is asked to sign it. */
export function shopNameProblem(name: string): string | null {
  if (name.length === 0) return 'Enter a shop name.';
  if (name.length > MAX_SHOP_NAME_LENGTH) {
    return `Keep the shop name to ${MAX_SHOP_NAME_LENGTH} characters.`;
  }
  // A control character could forge an extra line in the signed text.
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    return 'The shop name can only contain printable characters.';
  }
  return null;
}

/**
 * Payment links: any wallet becomes a shop, shares a link, and handles its own refunds.
 *
 * Three parts. Setup signs one registration text, and the shop IS the wallet that signed it —
 * the server takes the address from the signature, never from this screen. The link builder is
 * arithmetic only and talks to nobody. The refund board signs in once, polls, signs each
 * approval, and sends each approved refund from the merchant's own wallet with the order's
 * `RW1:R:` reference; the server finds that transfer on chain by the reference, so nothing
 * the wallet reports back is needed or trusted.
 */
export function MerchantScreen() {
  const [merchant, setMerchant] = useState<RegisteredMerchant | null>(readSavedMerchant);

  // Setup.
  const [shopName, setShopName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);

  // Link builder.
  const [amountNim, setAmountNim] = useState('0.01');
  const [label, setLabel] = useState(() => readSavedMerchant()?.name ?? '');
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const linkRef = useRef<HTMLPreElement>(null);

  // Refund board.
  const [rows, setRows] = useState<MerchantRequestRow[] | null>(null);
  const [session, setSession] = useState<MerchantSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [sentRefunds, setSentRefunds] = useState<Record<string, number>>(readSentRefunds);

  const load = useCallback(async (current: MerchantSession) => {
    try {
      const response = await api.listMerchantRequests(current);
      // The server scopes every read to the signed-in merchant. Filtering again costs nothing.
      setRows(response.requests.filter((row) => row.order.merchantId === current.merchantId));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
      // A refused sign-in (expired, or a different wallet) will not start working by polling
      // it again. A network error might, so only a refusal stops the board.
      if (err instanceof ApiError && err.code === 'bad_request') {
        setSession(null);
        setRows(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void load(session);
    const timer = setInterval(() => void load(session), 5_000);
    return () => clearInterval(timer);
  }, [load, session]);

  async function register() {
    const name = shopName.trim();
    setSetupError(null);
    setSetupNote(null);
    const problem = shopNameProblem(name);
    if (problem) {
      setSetupError(problem);
      return;
    }
    setRegistering(true);
    try {
      // The server refuses a registration signed more than five minutes ago.
      const message = registrationMessage(name, Math.floor(Date.now() / 1000));
      const signature = await getWallet().sign(message);
      if (signature.status === 'cancelled') {
        setSetupNote('You cancelled the signature. No payment link was created.');
        return;
      }
      if (signature.status === 'error') {
        setSetupError(signature.message);
        return;
      }
      const response = await api.registerMerchant({
        message,
        publicKey: signature.value.publicKey,
        signature: signature.value.signature,
      });
      saveMerchant(response.merchant);
      setMerchant(response.merchant);
      setLabel(response.merchant.name);
    } catch (err) {
      setSetupError(messageOf(err));
    } finally {
      setRegistering(false);
    }
  }

  function forgetMerchant() {
    saveMerchant(null);
    setMerchant(null);
    setSession(null);
    setRows(null);
    setShopName('');
    setLabel('');
    setError(null);
    setNote(null);
    setSetupError(null);
    setSetupNote(null);
    setCopyNote(null);
  }

  const amountLuna = nimToLuna(amountNim);
  const amountProblem =
    amountLuna === null
      ? 'Enter the amount in NIM, with at most 5 decimals.'
      : !isPayableLuna(amountLuna)
        ? `A link can ask for 0.00001 to ${formatNim(MAX_LINK_LUNA)}.`
        : null;
  const trimmedLabel = label.trim();
  const labelProblem =
    trimmedLabel.length > MAX_LABEL_LENGTH
      ? `Keep the label to ${MAX_LABEL_LENGTH} characters.`
      : null;
  const link =
    merchant && amountLuna !== null && !amountProblem && !labelProblem
      ? paymentLinkFor(window.location.origin, merchant.id, amountLuna, trimmedLabel || null)
      : null;

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopyNote('Copied.');
    } catch {
      // No clipboard API, or the WebView refused it. Selecting the text is the next best thing.
      const box = linkRef.current;
      const selection = window.getSelection();
      if (box && selection) {
        const range = document.createRange();
        range.selectNodeContents(box);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyNote('This browser would not copy it. The link is selected: copy it from there.');
    }
  }

  /**
   * Signs one `list` challenge and keeps it. A `list` challenge is not consumed, so one
   * wallet dialog backs the board's polling for the life of the challenge — a dialog every
   * five seconds would be unusable.
   */
  async function signIn(current: RegisteredMerchant) {
    setSigningIn(true);
    setError(null);
    setNote(null);
    try {
      const { challenge } = await api.merchantChallenge(current.id, 'list');
      const signature = await getWallet().sign(challenge.message);
      if (signature.status === 'cancelled') {
        setNote('You cancelled the sign-in. Nothing changed.');
        return;
      }
      if (signature.status === 'error') {
        setError(signature.message);
        return;
      }
      setSession({
        merchantId: current.id,
        message: challenge.message,
        publicKey: signature.value.publicKey,
        signature: signature.value.signature,
        expiresAtSec: challenge.expiresAtSec,
      });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSigningIn(false);
    }
  }

  /**
   * Approve and reject both sign first. The challenge is issued by the server, bound to this
   * action on this order, and single use — so a signature captured off the wire cannot be
   * replayed, and a signature for "approve" cannot be re-used for "reject".
   */
  async function act(current: RegisteredMerchant, orderId: string, action: 'approve' | 'reject') {
    setBusyId(orderId);
    setNote(null);
    setError(null);
    try {
      const { challenge, required } = await api.merchantChallenge(current.id, action, orderId);
      let signed: { message: string; publicKey: string; signature: string } | undefined;
      const signature = await getWallet().sign(challenge.message);
      if (signature.status === 'cancelled') {
        setNote(`You cancelled the ${action} signature. Nothing was ${action}d.`);
        return;
      }
      if (signature.status === 'ok') {
        signed = {
          message: challenge.message,
          publicKey: signature.value.publicKey,
          signature: signature.value.signature,
        };
      } else if (required) {
        setError(signature.message);
        return;
      }

      await api.merchantAction(orderId, action, signed);
      setNote(
        action === 'approve'
          ? 'Approved. Now send the refund from your wallet.'
          : 'Rejected. No NIM moves.',
      );
      if (session) await load(session);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The refund leaves the merchant's own wallet. The reference is the whole link to the order:
   * the server scans the refund address for `RW1:R:<orderId>` with the exact amount, so this
   * screen reports nothing back and a wallet that returns no usable hash still settles.
   */
  async function sendRefund(row: MerchantRequestRow) {
    const execution = row.execution;
    if (!execution) return;
    const orderId = row.order.id;
    setBusyId(orderId);
    setNote(null);
    setError(null);
    try {
      const sent = await getWallet().sendPayment({
        recipient: execution.refundTo,
        value: execution.amountLuna,
        data: `RW1:R:${orderId}`,
      });
      if (sent.status === 'cancelled') {
        setNote('You cancelled the wallet dialog, so nothing was sent. The refund is still waiting.');
        return;
      }
      if (sent.status === 'error') {
        setError(sent.message);
        return;
      }
      const atMs = Date.now();
      rememberSentRefund(orderId, atMs);
      setSentRefunds((current) => ({ ...current, [orderId]: atMs }));
      setNote(REFUND_SENT_NOTE);
      if (session) await load(session);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!merchant) {
    return (
      <main className="screen">
        <Card title="Payment links">
          <p>
            Take NIM with a link, and refund it properly. Your shop is your wallet: payments go
            to it, and refunds are approved and sent from it.
          </p>
          <label className="field">
            <span>Shop name</span>
            <input
              className="input"
              value={shopName}
              aria-label="Shop name"
              placeholder="e.g. Corner Coffee"
              onChange={(e) => setShopName(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={() => void register()}
            disabled={registering}
          >
            {registering ? 'Waiting for your wallet…' : 'Create my payment link'}
          </button>
          <Disclosure label="What do I sign, and why?" testId="register-why-sign">
            <p className="muted">
              Your wallet signs a short text with your shop name and the time. It proves the
              shop belongs to this wallet. It moves no NIM and costs no fee.
            </p>
          </Disclosure>
        </Card>
        {setupNote ? <Banner tone="warn">{setupNote}</Banner> : null}
        {setupError ? <Banner tone="bad">{setupError}</Banner> : null}
      </main>
    );
  }

  return (
    <main className="screen">
      <Card title={merchant.name}>
        <dl style={{ margin: 0 }}>
          <Kv label="Payments go to">
            <Mono value={merchant.address} max={14} />
          </Kv>
        </dl>
        <p className="muted" style={{ marginTop: 10 }}>
          Sign-ins, approvals and refunds must come from this wallet.
        </p>
        <button className="btn" onClick={forgetMerchant}>
          Use a different wallet
        </button>
      </Card>

      <Card title="Your payment link">
        <label className="field">
          <span>Amount in NIM (up to {formatNim(MAX_LINK_LUNA)})</span>
          <input
            className="input"
            inputMode="decimal"
            value={amountNim}
            aria-label="Amount in NIM"
            onChange={(e) => {
              setAmountNim(e.target.value);
              setCopyNote(null);
            }}
          />
        </label>
        <label className="field">
          <span>Label the buyer sees (optional)</span>
          <input
            className="input"
            value={label}
            aria-label="Label"
            placeholder={merchant.name}
            onChange={(e) => {
              setLabel(e.target.value);
              setCopyNote(null);
            }}
          />
        </label>
        {amountProblem ? (
          <Banner tone="bad" data-testid="amount-problem">
            {amountProblem}
          </Banner>
        ) : null}
        {labelProblem ? <Banner tone="bad">{labelProblem}</Banner> : null}
        {link ? (
          <div className="stack">
            <pre className="pre" ref={linkRef} data-testid="payment-link">
              {link}
            </pre>
            <button className="btn btn-primary" onClick={() => void copyLink()}>
              Copy link
            </button>
            {copyNote ? <p className="muted">{copyNote}</p> : null}
            <p className="muted">{SHARE_NOTE}</p>
          </div>
        ) : null}
      </Card>

      <Card title="Refund requests">
        <p>
          Approving reserves exactly one refund for the order. Then you send it from your wallet,
          and Rewind marks it refunded once the chain shows it.
        </p>
        <p className="muted" data-testid="session-state">
          {session
            ? 'Signed in with your wallet. This list shows only your shop.'
            : 'Sign once with your wallet to see refund requests for your shop.'}
        </p>
        <button className="btn" onClick={() => void signIn(merchant)} disabled={signingIn}>
          {signingIn ? 'Waiting for your wallet…' : session ? 'Sign in again' : 'Sign in with wallet'}
        </button>
        <Disclosure label="What do I sign, and why?" testId="merchant-why-sign">
          <p className="muted">
            Each approval and rejection is signed by your wallet over a text that names the shop,
            the action and the order, and expires in two minutes. The server issued that text
            and will accept it exactly once, so it cannot be replayed.
          </p>
        </Disclosure>
      </Card>

      {error ? <Banner tone="bad">{error}</Banner> : null}
      {note ? <Banner tone="neutral">{note}</Banner> : null}
      {session && rows === null ? (
        <Card>
          <p>Loading…</p>
        </Card>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <Card>
          <p>No refund requests for your shop yet.</p>
        </Card>
      ) : null}

      {(rows ?? []).map((row) => {
        const { order, execution } = row;
        const refundTo = execution?.refundTo ?? row.signedRequest?.refundTo ?? null;
        const sentAtMs = sentRefunds[order.id];
        const sentRecently = sentAtMs !== undefined && Date.now() - sentAtMs < RESEND_AFTER_MS;
        const busy = busyId === order.id;
        const settled =
          order.state === 'REFUND_BROADCAST' ||
          order.state === 'REFUNDED' ||
          order.state === 'REFUND_FAILED';
        return (
          <section className="card" key={order.id} data-testid={`refund-row-${order.id}`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <Pill tone={toneForState(order.state)}>{order.stateLabel}</Pill>
            </div>
            <dl style={{ margin: 0 }}>
              <Kv label="Order">
                <Mono value={order.id} max={20} />
              </Kv>
              <Kv label="Label">{order.itemLabel}</Kv>
              <Kv label="Amount">{order.amountLabel}</Kv>
              <Kv label="Refund goes to">{refundTo ? <Mono value={refundTo} max={14} /> : '—'}</Kv>
              <Kv label="Signed by">
                <Mono value={row.signedRequest?.signerAddress ?? '—'} max={14} />
              </Kv>
              {execution?.refundTxHash ? (
                <Kv label="Refund tx">
                  <Mono value={execution.refundTxHash} max={14} />
                </Kv>
              ) : null}
            </dl>

            {order.state === 'REFUND_REQUESTED' ? (
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void act(merchant, order.id, 'approve')}
                >
                  Approve
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(merchant, order.id, 'reject')}
                >
                  Reject
                </button>
              </div>
            ) : null}

            {order.state === 'REFUND_APPROVED' && execution?.source === 'MERCHANT_WALLET' ? (
              <div className="stack" style={{ marginTop: 12 }}>
                {sentAtMs !== undefined && !sentRecently ? (
                  <p className="muted">
                    Sent from this device {timeAgo(sentAtMs)} and not seen on chain yet. Check
                    your wallet history before sending it again.
                  </p>
                ) : null}
                <button
                  className="btn btn-primary"
                  disabled={busy || sentRecently}
                  onClick={() => void sendRefund(row)}
                >
                  {busy
                    ? 'Waiting for your wallet…'
                    : sentRecently
                      ? 'Sent. Waiting for the chain…'
                      : sentAtMs !== undefined
                        ? `Send refund again (${execution.amountLabel})`
                        : `Send refund (${execution.amountLabel})`}
                </button>
              </div>
            ) : null}

            {settled ? (
              <a
                className="btn"
                style={{ marginTop: 12 }}
                href={hashFor({ name: 'receipt', id: order.id })}
              >
                Receipt
              </a>
            ) : null}
          </section>
        );
      })}
    </main>
  );
}
