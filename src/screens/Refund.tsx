import { useCallback, useEffect, useState } from 'react';
import { api, type ChallengeView, type OrderStatus } from '../api';
import { ApiError } from '../api';
import { navigate } from '../App';
import { Banner, Card, Disclosure, Kv, Mono } from '../components/ui';
import { getWallet, shortAddress } from '../wallet';

type Phase = 'loading' | 'ready' | 'signing' | 'submitted' | 'cancelled' | 'error';

export function RefundScreen({ orderId }: { orderId: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [challenge, setChallenge] = useState<ChallengeView | null>(null);
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The API's own words for a rejected signature, shown as-is. */
  const [apiDetail, setApiDetail] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [walletAccount, setWalletAccount] = useState<string | null>(null);

  const requestChallenge = useCallback(async () => {
    setPhase('loading');
    setError(null);
    setApiDetail(null);
    try {
      const [response, current] = await Promise.all([
        api.requestChallenge(orderId),
        api.getOrder(orderId).catch(() => null),
      ]);
      setChallenge(response.challenge);
      if (current) setStatus(current);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.detail) setApiDetail(err.detail);
      setPhase('error');
    }
  }, [orderId]);

  useEffect(() => {
    void requestChallenge();
  }, [requestChallenge]);

  useEffect(() => {
    let cancelled = false;
    void getWallet()
      .listAccounts()
      .then((outcome) => {
        if (!cancelled && outcome.status === 'ok' && outcome.value[0]) {
          setWalletAccount(outcome.value[0]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function sign() {
    if (!challenge) return;
    setPhase('signing');
    setError(null);
    setApiDetail(null);
    try {
      const signature = await getWallet().sign(challenge.message);
      if (signature.status === 'cancelled') {
        setPhase('cancelled');
        return;
      }
      if (signature.status === 'error') {
        setError(signature.message);
        setPhase('error');
        return;
      }
      const response = await api.submitRefund(orderId, {
        message: challenge.message,
        publicKey: signature.value.publicKey,
        signature: signature.value.signature,
      });
      setNote(response.note);
      setPhase('submitted');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unavailable') {
        // The signature was accepted and consumed before anything touched the chain — a 503
        // here means the refund could not be CONFIRMED inside this request, not that the
        // request failed. Re-signing would hit "nonce already used" and read as a rejection,
        // so the buyer is sent to the order screen, which polls until the chain answers.
        // The light client makes this common: it throws about transactions that exist for the
        // first half-minute after inclusion.
        setNote(
          'Verified and submitted. The chain could not be read just now, so this is not confirmed yet — the order page keeps checking.',
        );
        setPhase('submitted');
        return;
      }
      // The wrong-signer case is an ApiError, and its message is written to be shown to a
      // buyer. It is rendered verbatim, with the server's detail underneath, because
      // paraphrasing "that wallet did not pay for this order" loses the only useful fact.
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.detail) setApiDetail(err.detail);
      setPhase('error');
    }
  }

  const payer = status?.order.payerAddress ?? challenge?.refundTo ?? null;
  const expiresIn = challenge
    ? Math.max(0, challenge.expiresAtSec - Math.floor(Date.now() / 1000))
    : 0;
  const wrongWallet =
    payer !== null &&
    walletAccount !== null &&
    payer.replace(/\s+/g, '').toUpperCase() !== walletAccount.replace(/\s+/g, '').toUpperCase();

  return (
    <main className="screen">
      <Card title="Request a refund">
        <p>
          <strong>Sign with the wallet that paid.</strong> Signing proves you control that
          wallet. It moves no NIM and costs no fee.
        </p>
        {payer ? (
          <dl style={{ margin: '0 0 12px' }}>
            <Kv label="Paying wallet">
              <Mono value={payer} max={16} />
            </Kv>
            {walletAccount ? (
              <Kv label="This device">{shortAddress(walletAccount)}</Kv>
            ) : null}
            {challenge ? <Kv label="Refund amount">{challenge.amountLuna} Luna</Kv> : null}
            {challenge ? <Kv label="Request valid for">{expiresIn}s</Kv> : null}
          </dl>
        ) : null}

        {challenge ? (
          <Disclosure label="What am I signing?" testId="what-am-i-signing">
            <p className="muted">
              This exact text, byte for byte. Your wallet will show it. It names the order, the
              wallet the refund goes back to, the amount and a one-time nonce, and it expires.
            </p>
            <pre className="pre" data-testid="challenge-text">
              {challenge.message}
            </pre>
          </Disclosure>
        ) : null}
      </Card>

      {wrongWallet ? (
        <Banner tone="warn">
          This device's wallet is not the wallet that paid. Only{' '}
          <Mono value={payer ?? ''} max={16} /> can sign this request.
        </Banner>
      ) : null}

      {phase === 'cancelled' ? (
        <Banner tone="warn" data-testid="cancelled-banner">
          You cancelled the signing dialog. Nothing was sent and nothing changed — the refund
          request has not been made yet.
        </Banner>
      ) : null}

      {error ? (
        <Banner tone="bad" data-testid="refund-error">
          <div data-testid="refund-error-message">{error}</div>
          {apiDetail ? (
            <div className="mono" data-testid="refund-error-detail" style={{ marginTop: 6 }}>
              {apiDetail}
            </div>
          ) : null}
        </Banner>
      ) : null}

      {phase === 'submitted' ? (
        <Banner tone="neutral">{note ?? 'Verified. Waiting for the merchant.'}</Banner>
      ) : null}

      {phase === 'submitted' ? (
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={() => navigate({ name: 'order', id: orderId })}
          >
            Back to order
          </button>
          <button className="btn" onClick={() => navigate({ name: 'receipt', id: orderId })}>
            Receipt
          </button>
        </div>
      ) : (
        <>
          <button
            className="btn btn-primary"
            onClick={() => void sign()}
            disabled={phase === 'signing' || phase === 'loading' || !challenge || expiresIn <= 0}
          >
            {phase === 'signing' ? 'Waiting for your wallet…' : 'Sign refund request'}
          </button>
          <div className="btn-row">
            <button className="btn" onClick={() => void requestChallenge()}>
              Get a fresh request
            </button>
            <button className="btn" onClick={() => navigate({ name: 'order', id: orderId })}>
              Back to order
            </button>
          </div>
        </>
      )}
    </main>
  );
}
