import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, WALLET_READY_EVENT } from './App';
import './styles.css';

/**
 * `init()` polls for Nimiq Pay to inject `window.nimiq` and rejects on a timeout. Outside
 * Nimiq Pay that timeout always fires, so the app must NOT wait for it before rendering —
 * waiting means a blank screen for the whole timeout, on a phone, on first load.
 *
 * So: render now, resolve the provider alongside, and tell the app when the answer is in.
 */
function initMiniApp(): void {
  void import('@nimiq/mini-app-sdk')
    .then((sdk) => sdk.init({ timeout: 3_000 }))
    .then(() => {
      console.info('[rewind] Nimiq Pay provider ready');
    })
    .catch((err: unknown) => {
      console.info('[rewind] no Nimiq Pay provider:', err);
    })
    .finally(() => {
      window.dispatchEvent(new Event(WALLET_READY_EVENT));
    });
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initMiniApp();
