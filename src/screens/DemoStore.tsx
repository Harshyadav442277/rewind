import { useCallback, useEffect, useState } from 'react';
import { api, type HealthView } from '../api';
import { hashFor, navigate } from '../App';
import { Banner, Card, Kv, Mono, timeAgo } from '../components/ui';
import { formatNim, useOrderPayment } from '../pay';
import { readOrders } from '../storage';

const ITEM = { label: 'Refund Test — 0.01 NIM', amountLuna: 1_000 };

/**
 * The disclosure, verbatim and non-negotiable. The Demo Store really does approve its own
 * refunds (`api/orders/[id]/refund.ts`), so this sentence is a description of behaviour, not
 * marketing, and it is why one person can walk the whole flow.
 */
export const AUTO_APPROVE_DISCLOSURE =
  'Demo Store automatically approves valid 0.01 NIM refund requests so you can test the complete flow without another person';

/**
 * Where a refund lands, in the buyer's terms. Nimiq Pay has been seen paying out of a payment
 * contract (an HTLC) funded by the user's wallet, and an HTLC cannot receive a refund, so the
 * server resolves the destination from the chain (`resolveRefundDestination`): a basic account
 * is refunded itself, an HTLC's funder is refunded instead. Neither is known before the payment
 * is on chain, so no screen names an address before then.
 */
export const REFUND_DESTINATION_NOTE =
  'The refund goes to the wallet that funded the payment, read from the chain. When Nimiq Pay pays out of a payment contract, that is the wallet that funded the contract.';

export function DemoStoreScreen() {
  const { phase, error, step, unpaidOrderId, busy, pay } = useOrderPayment();
  const [health, setHealth] = useState<HealthView | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
      setHealthError(null);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const paused = health?.demoPaused ?? false;

  return (
    <main className="screen">
      <Card title="Demo Store">
        <p>
          One item, priced so a whole demo costs almost nothing. Pay it, ask for the money
          back, and watch both transactions get verified on chain.
        </p>
        <dl style={{ margin: 0 }}>
          <Kv label="Item">{ITEM.label}</Kv>
          <Kv label="Price">0.01 NIM ({ITEM.amountLuna} Luna)</Kv>
          <Kv label="Refund policy">Full refund only, to the wallet that funded the payment</Kv>
        </dl>
      </Card>

      <Card title="Refund policy">
        <p data-testid="auto-approve-disclosure">{AUTO_APPROVE_DISCLOSURE}.</p>
        <p className="muted" data-testid="refund-destination">
          {REFUND_DESTINATION_NOTE} A refund is a new transaction from the Demo Store, and
          Rewind only calls it done once the chain says so. The Demo Store pays the network fee
          on it, so the full 0.01 NIM comes back to you.
        </p>
      </Card>

      {paused ? (
        <Banner tone="bad">
          <strong>Demo paused.</strong>{' '}
          {health?.demoPausedReason ?? 'The Demo Store is not taking payments right now.'}{' '}
          {health?.treasury.balanceLabel
            ? `Treasury holds ${health.treasury.balanceLabel}; the floor is ${health.treasury.floorLabel}.`
            : null}
        </Banner>
      ) : null}
      {healthError ? (
        <Banner tone="warn">
          The Demo Store could not check its own status: {healthError}
        </Banner>
      ) : null}

      {phase === 'cancelled' ? (
        <Banner tone="warn" data-testid="cancelled-banner">
          You cancelled the wallet dialog, so nothing was sent. No NIM has left your wallet.
        </Banner>
      ) : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {step ? <Banner tone="neutral">{step}</Banner> : null}

      <button className="btn btn-primary" onClick={() => void pay()} disabled={busy || paused}>
        {busy ? 'Working…' : paused ? 'Demo paused' : 'Pay 0.01 NIM'}
      </button>

      {phase === 'cancelled' && unpaidOrderId ? (
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => navigate({ name: 'order', id: unpaidOrderId })}
          >
            Open the unpaid order
          </button>
          <button className="btn" onClick={() => void loadHealth()}>
            Refresh status
          </button>
        </div>
      ) : null}

      <Card title="Status">
        <dl style={{ margin: 0 }}>
          <Kv label="Chain">
            {health === null
              ? 'checking…'
              : health.chain.reachable
                ? `readable, block ${health.chain.blockNumber ?? '?'}`
                : 'could not be read'}
          </Kv>
          <Kv label="Network">
            {health === null
              ? '—'
              : `${health.chain.network} (id ${health.chain.networkId}), via ${health.chain.mode}`}
          </Kv>
          <Kv label="Checked">
            {health?.chain.checkedAtMs
              ? timeAgo(health.chain.checkedAtMs, health.serverTimeMs)
              : 'not yet'}
          </Kv>
          <Kv label="Treasury">
            {health ? <Mono value={health.treasury.address} max={14} /> : '—'}
          </Kv>
          <Kv label="Treasury balance">{health?.treasury.balanceLabel ?? 'unknown'}</Kv>
          <Kv label="Floor">{health?.treasury.floorLabel ?? '—'}</Kv>
        </dl>
      </Card>

      <YourOrders />
    </main>
  );
}

/**
 * Orders this device created, from the Demo Store or a payment link, so a buyer can get back
 * to one without keeping the tab open. Read once per visit; hidden when there are none or
 * when storage cannot be read at all.
 */
export function YourOrders() {
  const [orders] = useState(readOrders);
  if (orders.length === 0) return null;
  return (
    <Card title="Your orders on this device">
      <p className="muted">Remembered by this browser only. The order page shows what the chain says.</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="your-orders">
        {orders.map((order) => (
          <li key={order.id} className="kv">
            <a className="tap-link" href={hashFor({ name: 'order', id: order.id })}>
              {order.label}
            </a>
            <span>
              {formatNim(order.amountLuna)}
              <span className="muted"> · {timeAgo(order.createdAtMs)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
