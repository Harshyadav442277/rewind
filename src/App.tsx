import { useEffect, useState } from 'react';
import { DemoStoreScreen } from './screens/DemoStore';
import { OrderScreen } from './screens/Order';
import { RefundScreen } from './screens/Refund';
import { ReceiptScreen } from './screens/Receipt';
import { MerchantScreen } from './screens/Merchant';
import { PayScreen } from './screens/Pay';
import { hasNimiqPay, isFakeWallet } from './wallet';

/**
 * What Rewind keeps, said on every screen before anyone pays, signs or registers a shop. The
 * rules disqualify data collection without clear disclosure, and this is the whole of it.
 */
export const DATA_NOTICE =
  'Rewind keeps what links a payment to its refund on its server: order amounts and labels, shop names, wallet addresses, signed requests and transaction hashes. Addresses and transactions are public on the Nimiq chain. This browser also remembers your orders and your shop.';

/**
 * Routing, without a router. Six screens and one optional id is not worth a dependency.
 * Hash routes so the app works from a static host with no rewrite rules of its own.
 *
 * A payment link is `#/pay/<merchantId>?amount=<luna>&label=<text>`. The query sits inside the
 * hash, so the static host never sees it. The route carries what the link said, unchecked
 * beyond "is it a whole number": the Pay screen decides whether the amount is payable and says
 * so, rather than the router silently sending a bad link to the Demo Store.
 */
export type Route =
  | { name: 'store' }
  | { name: 'order'; id: string }
  | { name: 'refund'; id: string }
  | { name: 'receipt'; id: string }
  | { name: 'merchant' }
  | { name: 'pay'; merchantId: string; amountLuna: number | null; label: string | null };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const queryAt = raw.indexOf('?');
  const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
  const [head, id] = path.split('/');
  if (head === 'order' && id) return { name: 'order', id };
  if (head === 'refund' && id) return { name: 'refund', id };
  if (head === 'receipt' && id) return { name: 'receipt', id };
  if (head === 'merchant') return { name: 'merchant' };
  if (head === 'pay' && id) {
    const amount = query.get('amount');
    const amountLuna = amount !== null && /^[0-9]{1,15}$/.test(amount) ? Number(amount) : null;
    const label = query.get('label')?.trim() || null;
    return { name: 'pay', merchantId: id, amountLuna, label };
  }
  return { name: 'store' };
}

export function hashFor(route: Route): string {
  switch (route.name) {
    case 'store':
      return '#/store';
    case 'merchant':
      return '#/merchant';
    case 'pay': {
      const query = new URLSearchParams();
      if (route.amountLuna !== null) query.set('amount', String(route.amountLuna));
      if (route.label !== null) query.set('label', route.label);
      const search = query.toString();
      return `#/pay/${route.merchantId}${search ? `?${search}` : ''}`;
    }
    default:
      return `#/${route.name}/${route.id}`;
  }
}

export function navigate(route: Route): void {
  const hash = hashFor(route);
  if (window.location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = hash;
}

/** Fired once the Nimiq Pay provider has either appeared or definitively not appeared. */
export const WALLET_READY_EVENT = 'rewind:wallet-ready';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  // The provider arrives asynchronously; the app renders before it is known either way, so
  // the "development mode" banner must re-evaluate rather than be decided at first paint.
  const [walletResolved, setWalletResolved] = useState(false);

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    const onWallet = () => setWalletResolved(true);
    window.addEventListener('hashchange', onChange);
    window.addEventListener(WALLET_READY_EVENT, onWallet);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener(WALLET_READY_EVENT, onWallet);
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Rewind
          <span>Verified, merchant-approved refunds for NIM</span>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={route.name === 'store' ? 'tab tab-active' : 'tab'}
          onClick={() => navigate({ name: 'store' })}
        >
          Demo Store
        </button>
        <button
          className={route.name === 'merchant' ? 'tab tab-active' : 'tab'}
          onClick={() => navigate({ name: 'merchant' })}
        >
          Payment links
        </button>
        {route.name === 'order' ||
        route.name === 'refund' ||
        route.name === 'receipt' ||
        route.name === 'pay' ? (
          <button className="tab tab-active">{route.name}</button>
        ) : null}
      </nav>

      {walletResolved && isFakeWallet() ? (
        <div style={{ padding: '8px 16px 0' }}>
          <div className="banner banner-warn" data-testid="dev-wallet-banner">
            Development mode. No Nimiq Pay provider is present, so a fake wallet and a fake
            chain are in use. Nothing on this screen is real NIM.
          </div>
        </div>
      ) : walletResolved && !hasNimiqPay() ? (
        <div style={{ padding: '8px 16px 0' }}>
          <div className="banner banner-warn" data-testid="open-in-nimiq-pay">
            Open Rewind inside the Nimiq Pay app to pay, sign or refund. This browser has no
            Nimiq wallet, so nothing here can send NIM. Orders and receipts still show what the
            chain says.
          </div>
        </div>
      ) : null}

      {route.name === 'store' ? <DemoStoreScreen /> : null}
      {route.name === 'order' ? <OrderScreen orderId={route.id} /> : null}
      {route.name === 'refund' ? <RefundScreen orderId={route.id} /> : null}
      {route.name === 'receipt' ? <ReceiptScreen orderId={route.id} /> : null}
      {route.name === 'merchant' ? <MerchantScreen /> : null}
      {route.name === 'pay' ? (
        <PayScreen
          // Keyed so a second link opened in the same session starts from a clean screen.
          key={hashFor(route)}
          merchantId={route.merchantId}
          amountLuna={route.amountLuna}
          label={route.label}
        />
      ) : null}

      <footer className="foot">
        <p>
          A refund here is a new, verified transaction that a merchant approved. NIM payments are
          not reversible, and Rewind does not pretend otherwise.
        </p>
        <p data-testid="data-notice">{DATA_NOTICE}</p>
      </footer>
    </div>
  );
}
