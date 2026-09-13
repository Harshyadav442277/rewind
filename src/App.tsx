import { useEffect, useState } from 'react';
import { DemoStoreScreen } from './screens/DemoStore';
import { OrderScreen } from './screens/Order';
import { RefundScreen } from './screens/Refund';
import { ReceiptScreen } from './screens/Receipt';
import { MerchantScreen } from './screens/Merchant';
import { isFakeWallet } from './wallet';

/**
 * Routing, without a router. Five screens and one optional id is not worth a dependency.
 * Hash routes so the app works from a static host with no rewrite rules of its own.
 */
export type Route =
  | { name: 'store' }
  | { name: 'order'; id: string }
  | { name: 'refund'; id: string }
  | { name: 'receipt'; id: string }
  | { name: 'merchant' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, id] = path.split('/');
  if (head === 'order' && id) return { name: 'order', id };
  if (head === 'refund' && id) return { name: 'refund', id };
  if (head === 'receipt' && id) return { name: 'receipt', id };
  if (head === 'merchant') return { name: 'merchant' };
  return { name: 'store' };
}

export function navigate(route: Route): void {
  const hash =
    route.name === 'store'
      ? '#/store'
      : route.name === 'merchant'
        ? '#/merchant'
        : `#/${route.name}/${route.id}`;
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
          Merchant
        </button>
        {route.name === 'order' || route.name === 'refund' || route.name === 'receipt' ? (
          <button className="tab tab-active">{route.name}</button>
        ) : null}
      </nav>

      {walletResolved && isFakeWallet() ? (
        <div style={{ padding: '8px 16px 0' }}>
          <div className="banner banner-warn">
            Development mode. No Nimiq Pay provider is present, so a fake wallet and a fake
            chain are in use. Nothing on this screen is real NIM.
          </div>
        </div>
      ) : null}

      {route.name === 'store' ? <DemoStoreScreen /> : null}
      {route.name === 'order' ? <OrderScreen orderId={route.id} /> : null}
      {route.name === 'refund' ? <RefundScreen orderId={route.id} /> : null}
      {route.name === 'receipt' ? <ReceiptScreen orderId={route.id} /> : null}
      {route.name === 'merchant' ? <MerchantScreen /> : null}

      <footer className="foot">
        A refund here is a new, verified transaction that a merchant approved. NIM payments are
        not reversible, and Rewind does not pretend otherwise.
      </footer>
    </div>
  );
}
