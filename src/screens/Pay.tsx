import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type MerchantView } from '../api';
import { navigate } from '../App';
import { Banner, Card, Kv, Mono } from '../components/ui';
import { clampLabel, formatNim, isPayableLuna, MAX_LINK_LUNA, useOrderPayment } from '../pay';

export const PAY_REFUND_LINE =
  'Refunds are approved and sent by the shop, to the wallet that funded the payment.';

/**
 * A payment link, opened by the buyer inside Nimiq Pay.
 *
 * What the link says is not trusted for where the money goes: the address comes from the
 * server's merchant record, looked up by id, and the order the server creates carries that
 * address again. The link only chooses the shop, the amount and the label, and an amount the
 * server would refuse is refused here first, with no Pay button, rather than after the buyer
 * has opened the wallet.
 */
export function PayScreen({
  merchantId,
  amountLuna,
  label,
}: {
  merchantId: string;
  amountLuna: number | null;
  label: string | null;
}) {
  const { phase, error, step, unpaidOrderId, busy, pay } = useOrderPayment();
  const [merchant, setMerchant] = useState<MerchantView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unknownMerchant, setUnknownMerchant] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await api.getMerchant(merchantId);
      // The Demo Store has its own screen, with its disclosure; a link must not bypass it.
      if (response.merchant.isDemoStore) {
        navigate({ name: 'store' });
        return;
      }
      setMerchant(response.merchant);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') setUnknownMerchant(true);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const amountOk = isPayableLuna(amountLuna);
  const canPay = merchant !== null && amountOk;

  return (
    <main className="screen">
      <Card title={merchant?.name ?? 'Payment link'}>
        {merchant === null && loadError === null ? <p>Loading the shop…</p> : null}
        {merchant ? (
          <>
            <dl style={{ margin: 0 }}>
              <Kv label="Pays to">
                <Mono value={merchant.address} max={14} />
              </Kv>
              <Kv label="Amount">{amountOk ? formatNim(amountLuna) : '—'}</Kv>
              <Kv label="For">{label ?? merchant.name}</Kv>
            </dl>
            <p style={{ marginTop: 10 }} data-testid="pay-refund-line">
              {PAY_REFUND_LINE}
            </p>
          </>
        ) : null}
      </Card>

      {!amountOk ? (
        <Banner tone="bad" data-testid="pay-link-error">
          This payment link has no valid amount. A link must ask for between 1 and{' '}
          {MAX_LINK_LUNA} Luna ({formatNim(MAX_LINK_LUNA)}). Ask the shop for a new link.
        </Banner>
      ) : null}
      {loadError ? (
        <Banner tone="bad" data-testid="pay-merchant-error">
          {unknownMerchant ? loadError : `Could not load this shop: ${loadError}`}
        </Banner>
      ) : null}
      {loadError && !unknownMerchant ? (
        <button className="btn" onClick={() => void load()}>
          Try again
        </button>
      ) : null}

      {phase === 'cancelled' ? (
        <Banner tone="warn" data-testid="cancelled-banner">
          You cancelled the wallet dialog, so nothing was sent. No NIM has left your wallet.
        </Banner>
      ) : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {step ? <Banner tone="neutral">{step}</Banner> : null}

      {canPay ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            void pay({
              merchantId: merchant.id,
              amountLuna,
              reference: clampLabel(label ?? merchant.name),
            })
          }
        >
          {busy ? 'Working…' : `Pay ${formatNim(amountLuna)}`}
        </button>
      ) : null}

      {phase === 'cancelled' && unpaidOrderId ? (
        <button className="btn" onClick={() => navigate({ name: 'order', id: unpaidOrderId })}>
          Open the unpaid order
        </button>
      ) : null}
    </main>
  );
}
