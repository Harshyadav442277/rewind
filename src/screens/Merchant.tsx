import { useCallback, useEffect, useState } from 'react';
import { api, type MerchantRequestRow, type MerchantSession, type OrderView } from '../api';
import { navigate } from '../App';
import { Banner, Card, Disclosure, Kv, Mono, Pill, toneForState } from '../components/ui';
import { getWallet } from '../wallet';

const MERCHANTS = [
  { id: 'demo-store', label: 'Rewind Demo Store (treasury funded)' },
  { id: 'sample-merchant', label: 'Sample Merchant (signs their own refunds)' },
];

/**
 * A canned row, shown ONLY when there are no real requests, and labelled as an example on the
 * row itself. It exists so the screen is legible before anything has happened; it is never
 * counted, never actionable, and never presented as a real refund.
 */
const EXAMPLE_ORDER: OrderView = {
  id: 'example00',
  state: 'REFUND_REQUESTED',
  stateLabel: 'Refund requested, signature verified',
  merchantId: 'demo-store',
  merchantAddress: 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001',
  itemLabel: 'Refund Test — 0.01 NIM',
  amountLuna: 1_000,
  amountLabel: '0.01 NIM',
  networkId: 'example',
  createdAt: 0,
  updatedAt: 0,
  expiresAt: 0,
  paymentTxHash: null,
  paymentExplorerUrl: null,
  payerAddress: 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001',
  paidAt: 0,
  paymentBlockNumber: null,
  claimedPaymentTxHash: null,
  refundSource: 'DEMO_TREASURY',
  refunderAddress: 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001',
  lastError: null,
  paymentReference: 'RW1:P:example00',
  refundReference: 'RW1:R:example00',
};

const EXAMPLE_ROW: MerchantRequestRow = {
  order: EXAMPLE_ORDER,
  signedRequest: null,
  execution: null,
};

function shareLinkFor(orderId: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/order/${orderId}`;
}

export function MerchantScreen() {
  const [merchantId, setMerchantId] = useState(MERCHANTS[0]?.id ?? 'demo-store');
  const [rows, setRows] = useState<MerchantRequestRow[] | null>(null);
  const [session, setSession] = useState<MerchantSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // Create-order form.
  const [amountLuna, setAmountLuna] = useState('1000');
  const [reference, setReference] = useState('');
  const [created, setCreated] = useState<OrderView | null>(null);

  const load = useCallback(
    async (current: MerchantSession | null) => {
      try {
        const response = await api.listMerchantRequests(current);
        setRows(response.requests);
        setError(null);
      } catch (err) {
        setRows([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  useEffect(() => {
    void load(session);
    const timer = setInterval(() => void load(session), 5_000);
    return () => clearInterval(timer);
  }, [load, session]);

  /**
   * Signs one `list` challenge and keeps it. A `list` challenge is not consumed, so one
   * wallet dialog backs the board's polling for the life of the challenge — a dialog every
   * five seconds would be unusable.
   */
  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      const { challenge } = await api.merchantChallenge(merchantId, 'list');
      const signature = await getWallet().sign(challenge.message);
      if (signature.status === 'cancelled') {
        setNote('You cancelled the sign-in. Nothing changed.');
        return;
      }
      if (signature.status === 'error') {
        setError(signature.message);
        return;
      }
      const next: MerchantSession = {
        merchantId,
        message: challenge.message,
        publicKey: signature.value.publicKey,
        signature: signature.value.signature,
        expiresAtSec: challenge.expiresAtSec,
      };
      setSession(next);
      await load(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  }

  async function createOrder() {
    setError(null);
    setCreated(null);
    try {
      const parsed = Number(amountLuna);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        setError('Enter the amount in whole Luna. 1 NIM is 100000 Luna.');
        return;
      }
      const { order } = await api.createOrder({
        merchantId,
        amountLuna: parsed,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      setCreated(order);
      setNote(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Approve and reject both sign first. The challenge is issued by the server, bound to this
   * action on this order, and single use — so a signature captured off the wire cannot be
   * replayed, and a signature for "approve" cannot be re-used for "reject".
   */
  async function act(orderId: string, action: 'approve' | 'reject') {
    setBusyId(orderId);
    setNote(null);
    setError(null);
    try {
      const { challenge, required } = await api.merchantChallenge(merchantId, action, orderId);
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

      const response = await api.merchantAction(orderId, action, signed);
      setNote(
        action === 'approve'
          ? `Approved${response.alreadyReserved ? ' (already reserved — no second refund)' : ''}. ${response.settleStatus ?? ''}`
          : 'Rejected. No NIM moves.',
      );
      await load(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const real = rows ?? [];
  const showExample = rows !== null && real.length === 0;
  const display = showExample ? [EXAMPLE_ROW] : real;

  return (
    <main className="screen">
      <Card title="Merchant">
        <label className="field">
          <span>Acting as</span>
          <select
            className="input"
            value={merchantId}
            onChange={(e) => {
              setMerchantId(e.target.value);
              setSession(null);
            }}
          >
            {MERCHANTS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted" data-testid="session-state">
          {session
            ? 'Signed in with your merchant wallet. This list is scoped to you.'
            : 'Not signed in. Sign once with the merchant wallet to see only your own orders.'}
        </p>
        <button className="btn" onClick={() => void signIn()} disabled={signingIn}>
          {signingIn ? 'Waiting for your wallet…' : session ? 'Sign in again' : 'Sign in with wallet'}
        </button>
      </Card>

      <Card title="New order">
        <label className="field">
          <span>Amount in Luna (1 NIM = 100000 Luna)</span>
          <input
            className="input"
            inputMode="numeric"
            value={amountLuna}
            aria-label="Amount in Luna"
            onChange={(e) => setAmountLuna(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Your reference (invoice number, table number…)</span>
          <input
            className="input"
            value={reference}
            aria-label="Your reference"
            placeholder="optional"
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" onClick={() => void createOrder()}>
          Create order
        </button>
        {created ? (
          <div style={{ marginTop: 12 }} data-testid="created-order">
            <dl style={{ margin: 0 }}>
              <Kv label="Order">
                <Mono value={created.id} max={24} />
              </Kv>
              <Kv label="Amount">{created.amountLabel}</Kv>
              <Kv label="On-chain reference">
                <Mono value={created.paymentReference} max={24} />
              </Kv>
            </dl>
            <p className="muted" style={{ marginTop: 8 }}>
              Send this link to the buyer:
            </p>
            <pre className="pre" data-testid="share-link">
              {shareLinkFor(created.id)}
            </pre>
            <button
              className="btn"
              onClick={() => navigate({ name: 'order', id: created.id })}
            >
              Open the order
            </button>
          </div>
        ) : null}
      </Card>

      <Card title="Refund requests">
        <p>
          Approving reserves exactly one refund obligation for the order. Tapping twice, or two
          people tapping at once, still produces one refund.
        </p>
        <Disclosure label="What do I sign, and why?" testId="merchant-why-sign">
          <p className="muted">
            Each approval and rejection is signed by the merchant wallet over a text that names
            the merchant, the action and the order, and expires in two minutes. The server
            issued that text and will accept it exactly once, so it cannot be replayed.
          </p>
        </Disclosure>
      </Card>

      {error ? <Banner tone="bad">{error}</Banner> : null}
      {note ? <Banner tone="neutral">{note}</Banner> : null}
      {rows === null ? (
        <Card>
          <p>Loading…</p>
        </Card>
      ) : null}

      {display.map((row) => {
        const isExample = showExample;
        return (
          <section className="card" key={row.order.id}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <Pill tone={toneForState(row.order.state)}>{row.order.stateLabel}</Pill>
              {isExample ? <Pill tone="neutral">example</Pill> : null}
            </div>
            <dl style={{ margin: 0 }}>
              <Kv label="Order">
                <Mono value={row.order.id} max={20} />
              </Kv>
              <Kv label="Reference">{row.order.itemLabel}</Kv>
              <Kv label="Amount">{row.order.amountLabel}</Kv>
              <Kv label="Refund to">
                <Mono value={row.order.payerAddress ?? '—'} max={14} />
              </Kv>
              <Kv label="Signed by">
                <Mono value={row.signedRequest?.signerAddress ?? '—'} max={14} />
              </Kv>
              <Kv label="Funded by">
                {row.order.refundSource === 'DEMO_TREASURY'
                  ? 'Demo Store treasury (capped)'
                  : "Merchant's own wallet"}
              </Kv>
              {row.execution?.refundTxHash ? (
                <Kv label="Refund tx">
                  <Mono value={row.execution.refundTxHash} max={14} />
                </Kv>
              ) : null}
            </dl>

            {isExample ? (
              <p className="muted" style={{ marginTop: 10 }}>
                Nothing real is waiting. This row shows what one looks like, and its buttons
                are not here because there is nothing to approve.
              </p>
            ) : (
              <>
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-primary"
                    disabled={busyId === row.order.id || row.order.state !== 'REFUND_REQUESTED'}
                    onClick={() => void act(row.order.id, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    className="btn"
                    disabled={busyId === row.order.id || row.order.state !== 'REFUND_REQUESTED'}
                    onClick={() => void act(row.order.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
                <button
                  className="btn"
                  style={{ marginTop: 10 }}
                  onClick={() => navigate({ name: 'receipt', id: row.order.id })}
                >
                  Receipt
                </button>
              </>
            )}
          </section>
        );
      })}

      <button className="btn" onClick={() => navigate({ name: 'store' })}>
        Back to the Demo Store
      </button>
    </main>
  );
}
