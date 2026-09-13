import { useCallback, useEffect, useState } from 'react';
import { api, type OrderStatus } from '../api';
import { navigate } from '../App';
import {
  Banner,
  Card,
  Kv,
  Mono,
  Pill,
  Timeline,
  timeAgo,
  toneForState,
  type Step,
} from '../components/ui';
import { getWallet } from '../wallet';

const POLL_MS = 3_000;

const FLOW = [
  'CREATED',
  'PAYMENT_PENDING',
  'PAID',
  'REFUND_REQUESTED',
  'REFUND_APPROVED',
  'REFUND_BROADCAST',
  'REFUNDED',
] as const;

const DEAD_ENDS = ['REFUND_FAILED', 'REJECTED', 'EXPIRED'];

/**
 * Three words for three different things, and the screen must never blur them:
 *   pending  — nothing has been found on chain yet,
 *   included — a transaction is in a block but not deep enough to count,
 *   verified — the chain record matched recipient, amount, reference and depth.
 */
export function stepsFor(status: OrderStatus): Step[] {
  const s = status.order.state;
  const index = FLOW.indexOf(s as (typeof FLOW)[number]);
  const failed = DEAD_ENDS.includes(s);

  const mark = (position: number): Step['status'] => {
    if (failed) return position <= 2 ? 'done' : 'bad';
    if (index < 0) return 'todo';
    if (position < index) return 'done';
    if (position === index) return 'now';
    return 'todo';
  };

  const paymentSub = status.order.paymentTxHash
    ? `verified in block ${status.order.paymentBlockNumber ?? '?'}`
    : status.order.claimedPaymentTxHash
      ? 'included or pending — a reported hash is not evidence on its own'
      : 'pending: recipient, amount, reference, execution and depth all have to match';

  return [
    { label: 'Order created', sub: status.order.paymentReference, status: mark(0) },
    {
      label: 'Payment sent',
      sub: status.order.claimedPaymentTxHash
        ? 'The wallet reported a hash. Rewind still checks the chain.'
        : 'Looking for the payment by its reference.',
      status: mark(1),
    },
    { label: 'Payment verified on chain', sub: paymentSub, status: mark(2) },
    {
      label: 'Refund request signed',
      sub: status.signedRequest?.signerAddress
        ? `signed by ${status.signedRequest.signerAddress}`
        : 'You prove you control the paying wallet.',
      status: mark(3),
    },
    {
      label: 'Refund approved',
      sub: 'A refund obligation is reserved once, and only once.',
      status: mark(4),
    },
    {
      label: 'Refund sent',
      sub: status.execution?.intendedTxHash
        ? 'Broadcast. Waiting for the chain to agree.'
        : 'Recorded before it is sent, so a crash cannot lose or repeat it.',
      status: mark(5),
    },
    {
      label: 'Refund verified on chain',
      sub: status.execution?.refundTxHash ?? 'Not yet.',
      status: mark(6),
    },
    ...(failed
      ? [
          {
            label: status.order.stateLabel,
            sub: status.order.lastError ?? undefined,
            status: 'bad' as const,
          },
        ]
      : []),
  ];
}

export function OrderScreen({ orderId }: { orderId: string }) {
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [payCancelled, setPayCancelled] = useState(false);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getOrder(orderId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [orderId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function retryPayment() {
    if (!status) return;
    setPaying(true);
    setPayError(null);
    setPayCancelled(false);
    try {
      const sent = await getWallet().sendPayment({
        recipient: status.order.merchantAddress,
        value: status.order.amountLuna,
        data: status.order.paymentReference,
      });
      if (sent.status === 'cancelled') {
        setPayCancelled(true);
        return;
      }
      if (sent.status === 'error') {
        setPayError(sent.message);
        return;
      }
      await api.submitPayment(orderId, sent.value.txHash);
      await load();
    } catch (err) {
      setPayError(err instanceof Error ? err.message : String(err));
    } finally {
      setPaying(false);
    }
  }

  if (error && !status) {
    return (
      <main className="screen">
        <Banner tone="bad">{error}</Banner>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => void load()}>
            Try again
          </button>
          <button className="btn" onClick={() => navigate({ name: 'store' })}>
            Demo Store
          </button>
        </div>
      </main>
    );
  }
  if (!status) {
    return (
      <main className="screen">
        <Card>
          <p>Loading the order…</p>
        </Card>
      </main>
    );
  }

  const { order } = status;
  const nothingSent = order.state === 'CREATED' && order.claimedPaymentTxHash === null;
  const canRequestRefund = order.state === 'PAID';
  const staleMs =
    status.chainFetchedAtMs === null ? null : status.serverTimeMs - status.chainFetchedAtMs;

  return (
    <main className="screen">
      <Card title={order.itemLabel}>
        <p>
          <Pill tone={toneForState(order.state)}>{order.stateLabel}</Pill>
        </p>
        <dl style={{ margin: 0 }}>
          <Kv label="Order">
            <Mono value={order.id} max={24} />
          </Kv>
          <Kv label="Amount">{order.amountLabel}</Kv>
          <Kv label="Paid to">
            <Mono value={order.merchantAddress} max={14} />
          </Kv>
          <Kv label="Paid from">
            {order.payerAddress ? <Mono value={order.payerAddress} max={14} /> : 'not verified yet'}
          </Kv>
          <Kv label="Chain checked at">
            <span data-testid="checked-at">
              {status.chainFetchedAtMs === null
                ? 'nothing to check right now'
                : `${timeAgo(status.chainFetchedAtMs, status.serverTimeMs)}${
                    staleMs !== null && staleMs > 30_000 ? ' — this reading is stale' : ''
                  }`}
            </span>
          </Kv>
        </dl>
      </Card>

      {nothingSent ? (
        <Banner tone="warn" data-testid="nothing-sent">
          <strong>Nothing was sent yet.</strong> This order exists, but no payment has left your
          wallet — the wallet dialog was cancelled or never finished. You can try the payment
          again, and nothing is charged until you confirm it in the wallet.
        </Banner>
      ) : null}
      {payCancelled ? (
        <Banner tone="warn">You cancelled the wallet dialog again. Still nothing sent.</Banner>
      ) : null}
      {payError ? <Banner tone="bad">{payError}</Banner> : null}
      {status.note ? <Banner tone="warn">{status.note}</Banner> : null}
      {order.lastError ? <Banner tone="bad">{order.lastError}</Banner> : null}
      {error ? <Banner tone="warn">Could not refresh: {error}</Banner> : null}

      <Card title="Status">
        <Timeline steps={stepsFor(status)} />
      </Card>

      {nothingSent ? (
        <button className="btn btn-primary" onClick={() => void retryPayment()} disabled={paying}>
          {paying ? 'Waiting for your wallet…' : `Try the payment again (${order.amountLabel})`}
        </button>
      ) : null}

      {canRequestRefund ? (
        <button
          className="btn btn-primary"
          onClick={() => navigate({ name: 'refund', id: order.id })}
        >
          Request refund
        </button>
      ) : null}

      {DEAD_ENDS.includes(order.state) ? (
        <button className="btn btn-primary" onClick={() => navigate({ name: 'store' })}>
          Start again at the Demo Store
        </button>
      ) : null}

      <div className="btn-row">
        <button className="btn" onClick={() => navigate({ name: 'receipt', id: order.id })}>
          Receipt
        </button>
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
    </main>
  );
}
