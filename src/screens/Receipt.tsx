import { useCallback, useEffect, useState } from 'react';
import { api, type OrderStatus } from '../api';
import { navigate } from '../App';
import { Banner, Card, Disclosure, Kv, Mono, Pill, toneForState } from '../components/ui';

/** The claim, in the only words that are true. Never "reversible", never "guaranteed". */
export const REFUND_CLAIM = 'verified, merchant-approved refund';

function ExplorerLink({ url, label }: { url: string | null; label: string }) {
  if (!url) return <>—</>;
  return (
    <a href={url} target="_blank" rel="noreferrer" data-testid={label}>
      open in explorer
    </a>
  );
}

export function ReceiptScreen({ orderId }: { orderId: string }) {
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [load]);

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
          <p>Loading the receipt…</p>
        </Card>
      </main>
    );
  }

  const { order, signedRequest, execution } = status;
  const complete = order.state === 'REFUNDED' && execution?.refundTxHash;

  return (
    <main className="screen">
      <Card title="Receipt">
        <p>
          <Pill tone={toneForState(order.state)}>{order.stateLabel}</Pill>
        </p>
        {complete ? (
          <Banner tone="ok" data-testid="refund-claim">
            This was a {REFUND_CLAIM}: the merchant approved it, and both transactions are on
            chain below.
          </Banner>
        ) : (
          <p className="muted" data-testid="refund-claim">
            Rewind only ever claims a {REFUND_CLAIM}, and only once the chain agrees. Nothing
            here is reversed; a refund is a second transaction.
          </p>
        )}
        <dl style={{ margin: 0 }}>
          <Kv label="Order">
            <Mono value={order.id} max={24} />
          </Kv>
          <Kv label="Item">{order.itemLabel}</Kv>
          <Kv label="Amount">{order.amountLabel}</Kv>
          <Kv label="Network">{order.networkId}</Kv>
        </dl>
      </Card>

      <Card title="1. Payment">
        {order.paymentTxHash ? (
          <dl style={{ margin: 0 }}>
            <Kv label="Transaction">
              <Mono value={order.paymentTxHash} max={14} />
            </Kv>
            <Kv label="Block">{order.paymentBlockNumber ?? '—'}</Kv>
            <Kv label="From">
              <Mono value={order.payerAddress ?? '—'} max={14} />
            </Kv>
            <Kv label="To">
              <Mono value={order.merchantAddress} max={14} />
            </Kv>
            <Kv label="Reference">
              <Mono value={order.paymentReference} max={24} />
            </Kv>
            <Kv label="Explorer">
              <ExplorerLink url={order.paymentExplorerUrl} label="payment-explorer" />
            </Kv>
          </dl>
        ) : (
          <p>No payment has been verified on chain for this order yet.</p>
        )}
      </Card>

      <Card title="2. Signed refund request">
        {signedRequest?.consumedAt ? (
          <>
            <dl style={{ margin: '0 0 10px' }}>
              <Kv label="Signed by">
                <Mono value={signedRequest.signerAddress ?? '—'} max={14} />
              </Kv>
              <Kv label="Refund to">
                <Mono value={signedRequest.refundTo} max={14} />
              </Kv>
              <Kv label="Amount">{signedRequest.amountLuna} Luna</Kv>
              <Kv label="Nonce">
                <Mono value={signedRequest.nonce} max={12} />
              </Kv>
              <Kv label="Signature">
                <Mono value={signedRequest.signatureHex ?? '—'} max={12} />
              </Kv>
            </dl>
            <Disclosure label="The exact text that was signed" testId="signed-text-toggle">
              <pre className="pre">{signedRequest.message}</pre>
            </Disclosure>
          </>
        ) : (
          <p>No signed refund request yet.</p>
        )}
      </Card>

      <Card title="3. Refund">
        {execution ? (
          <dl style={{ margin: 0 }}>
            <Kv label="Source">
              {execution.source === 'DEMO_TREASURY'
                ? 'Demo Store treasury (capped)'
                : "Merchant's own wallet"}
            </Kv>
            <Kv label="Verified transaction">
              {execution.refundTxHash ? (
                <Mono value={execution.refundTxHash} max={14} />
              ) : (
                'none yet'
              )}
            </Kv>
            <Kv label="Reported transaction">
              {execution.intendedTxHash ? <Mono value={execution.intendedTxHash} max={14} /> : '—'}
            </Kv>
            <Kv label="Block">{execution.refundBlockNumber ?? '—'}</Kv>
            <Kv label="Back to">
              <Mono value={execution.refundTo} max={14} />
            </Kv>
            <Kv label="Reference">
              <Mono value={order.refundReference} max={24} />
            </Kv>
            <Kv label="Explorer">
              <ExplorerLink url={execution.refundExplorerUrl} label="refund-explorer" />
            </Kv>
            {execution.failureReason ? <Kv label="Failure">{execution.failureReason}</Kv> : null}
          </dl>
        ) : (
          <p>No refund has been reserved for this order.</p>
        )}
      </Card>

      {execution && !execution.refundTxHash ? (
        <Banner tone="warn">
          A reported transaction hash is not proof. This receipt only calls a refund verified
          once the chain record matches the recipient, the amount and the reference.
        </Banner>
      ) : null}

      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => navigate({ name: 'order', id: orderId })}>
          Back to order
        </button>
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <button className="btn" onClick={() => navigate({ name: 'store' })}>
        Demo Store
      </button>
    </main>
  );
}
