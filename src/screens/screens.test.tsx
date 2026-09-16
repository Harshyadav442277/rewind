/**
 * One DOM test per screen. Offline: `../api` and `../wallet` are both mocked, so nothing
 * opens a socket and no wallet is involved.
 *
 * What these prove: that each screen renders the state the domain can actually be in, that
 * the three wallet outcomes each reach a distinct screen, and that the copy rules hold —
 * the Demo Store disclosure verbatim, "verified, merchant-approved refund" on the receipt,
 * and the API's own words for a wrong signer shown rather than paraphrased.
 *
 * What they do not prove: layout, tap-target size on a real device, or anything about Nimiq
 * Pay. No screen here has been opened on a phone.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeView, ExecutionView, HealthView, OrderStatus, OrderView } from '../api';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- mocks -----------------------------------------------------------------

const { apiMock, walletMock, walletFlags, FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly detail?: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    FakeApiError,
    apiMock: {
      health: vi.fn(),
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      submitPayment: vi.fn(),
      requestChallenge: vi.fn(),
      submitRefund: vi.fn(),
      listMerchantRequests: vi.fn(),
      merchantChallenge: vi.fn(),
      merchantAction: vi.fn(),
      registerMerchant: vi.fn(),
      getMerchant: vi.fn(),
    },
    walletMock: {
      sign: vi.fn(),
      sendPayment: vi.fn(),
    },
    walletFlags: { fake: true, nimiqPay: false },
  };
});

vi.mock('../api', () => ({ api: apiMock, ApiError: FakeApiError }));

vi.mock('../wallet', () => ({
  getWallet: () => walletMock,
  isFakeWallet: () => walletFlags.fake,
  hasNimiqPay: () => walletFlags.nimiqPay,
  NO_WALLET_MESSAGE: 'There is no Nimiq wallet in this browser.',
}));

import { App, DATA_NOTICE, WALLET_READY_EVENT } from '../App';
import { AUTO_APPROVE_DISCLOSURE, DemoStoreScreen, REFUND_DESTINATION_NOTE } from './DemoStore';
import { OrderScreen, stepsFor } from './Order';
import { RefundScreen } from './Refund';
import { REFUND_CLAIM, ReceiptScreen } from './Receipt';
import { MerchantScreen, REFUND_SENT_NOTE, SHARE_NOTE } from './Merchant';
import { PAY_REFUND_LINE, PayScreen } from './Pay';

// --- fixtures --------------------------------------------------------------

const ORDER: OrderView = {
  id: 'abcdef0123456789',
  state: 'CREATED',
  stateLabel: 'Order created',
  merchantId: 'demo-store',
  merchantAddress: 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001',
  itemLabel: 'Refund Test — 0.01 NIM',
  amountLuna: 1_000,
  amountLabel: '0.01 NIM',
  networkId: '24',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  expiresAt: 1_700_001_000_000,
  paymentTxHash: null,
  paymentExplorerUrl: null,
  payerAddress: null,
  paidAt: null,
  paymentBlockNumber: null,
  claimedPaymentTxHash: null,
  refundSource: 'DEMO_TREASURY',
  refunderAddress: 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001',
  lastError: null,
  paymentReference: 'RW1:P:abcdef0123456789',
  refundReference: 'RW1:R:abcdef0123456789',
};

const CHALLENGE: ChallengeView = {
  nonce: 'n0nce000',
  message: 'REWIND_REFUND_V1\norder=abcdef0123456789\nrefund_to=NQ64 P4YR',
  refundTo: 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001',
  amountLuna: 1_000,
  expiresAtSec: Math.floor(Date.now() / 1000) + 120,
  consumedAt: null,
  signerAddress: null,
  signatureHex: null,
};

const EXECUTION: ExecutionView = {
  id: 'exec1',
  source: 'DEMO_TREASURY',
  refundTo: 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001',
  amountLuna: 1_000,
  amountLabel: '0.01 NIM',
  refunderAddress: 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001',
  intendedTxHash: 'b'.repeat(64),
  broadcastAt: 1_700_000_100_000,
  refundTxHash: 'b'.repeat(64),
  refundExplorerUrl: `https://nimiq.watch/#${'b'.repeat(64)}`,
  refundBlockNumber: 42_000,
  confirmedAt: 1_700_000_200_000,
  failureReason: null,
};

function status(over: Partial<OrderStatus> = {}, order: Partial<OrderView> = {}): OrderStatus {
  return {
    order: { ...ORDER, ...order },
    challenge: null,
    signedRequest: null,
    execution: null,
    chainFetchedAtMs: null,
    note: null,
    serverTimeMs: 1_700_000_000_000,
    ...over,
  };
}

const HEALTH: HealthView = {
  chain: {
    reachable: true,
    mode: 'fake',
    network: 'mainnet',
    explorerBase: 'https://nimiq.watch/#',
    networkId: '24',
    blockNumber: 1_000_000,
    checkedAtMs: 1_700_000_000_000,
    error: null,
  },
  treasury: {
    address: 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001',
    balanceLuna: 10_000_000,
    balanceLabel: '100 NIM',
    floorLuna: 50_000,
    floorLabel: '0.5 NIM',
  },
  demoPaused: false,
  demoPausedReason: null,
  repo: 'memory',
  serverTimeMs: 1_700_000_000_000,
};

// --- harness ---------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  walletFlags.fake = true;
  walletFlags.nimiqPay = false;
  window.localStorage.clear();
  window.location.hash = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(node: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  // One more turn so effects that resolve a promise have flushed.
  await act(async () => {
    await Promise.resolve();
  });
}

const text = (): string => container.textContent ?? '';
const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);

function buttonWith(label: string | RegExp): HTMLButtonElement {
  const buttons = [...container.querySelectorAll('button')];
  const match = buttons.find((b) =>
    typeof label === 'string' ? b.textContent?.includes(label) : label.test(b.textContent ?? ''),
  );
  if (!match) throw new Error(`no button matching ${String(label)} in: ${buttons.map((b) => b.textContent).join(' | ')}`);
  return match as HTMLButtonElement;
}

/**
 * React installs its own value setter on inputs and tracks the last value it saw, so setting
 * `.value` directly is invisible to onChange. The native setter plus an input event is the
 * usual way round it.
 */
async function type(selector: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input matching ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Several macrotask turns, for chains of awaits that a single microtask does not cover. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const hasButton = (label: RegExp): boolean =>
  [...container.querySelectorAll('button')].some((b) => label.test(b.textContent ?? ''));

// --- Demo Store -------------------------------------------------------------

describe('Demo Store', () => {
  it('shows the item, the price and the auto-approval disclosure verbatim', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    await render(<DemoStoreScreen />);
    expect(text()).toContain('0.01 NIM');
    expect(byTestId('auto-approve-disclosure')?.textContent).toBe(`${AUTO_APPROVE_DISCLOSURE}.`);
    expect(buttonWith('Pay 0.01 NIM').disabled).toBe(false);
  });

  it('creates no order when this browser has no wallet to pay with', async () => {
    walletFlags.fake = false;
    walletFlags.nimiqPay = false;
    apiMock.health.mockResolvedValue(HEALTH);
    await render(<DemoStoreScreen />);
    await click(buttonWith('Pay 0.01 NIM'));
    expect(apiMock.createOrder).not.toHaveBeenCalled();
    expect(walletMock.sendPayment).not.toHaveBeenCalled();
    expect(text()).toContain('There is no Nimiq wallet in this browser.');
  });

  it('names no paying address before the chain is read, and says where a refund goes', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    await render(<DemoStoreScreen />);
    // Nimiq Pay pays out of a payment contract, not from the first listed account, so the
    // store must not show that account as "paying from".
    expect(text()).not.toContain('paying from');
    expect(byTestId('refund-destination')?.textContent).toContain(REFUND_DESTINATION_NOTE);
  });

  it('pauses the demo when the API says the treasury is below its floor', async () => {
    apiMock.health.mockResolvedValue({
      ...HEALTH,
      demoPaused: true,
      demoPausedReason: 'The Demo Store treasury is below its floor and is not taking payments.',
      treasury: { ...HEALTH.treasury, balanceLuna: 10, balanceLabel: '0.0001 NIM' },
    });
    await render(<DemoStoreScreen />);
    expect(text()).toContain('Demo paused');
    expect(text()).toContain('below its floor');
    expect(buttonWith('Demo paused').disabled).toBe(true);
  });

  it('says nothing was sent when the wallet dialog is cancelled', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    apiMock.createOrder.mockResolvedValue({ order: ORDER });
    walletMock.sendPayment.mockResolvedValue({ status: 'cancelled', message: 'no' });
    await render(<DemoStoreScreen />);
    await click(buttonWith('Pay 0.01 NIM'));
    expect(byTestId('cancelled-banner')?.textContent).toContain('nothing was sent');
    expect(apiMock.submitPayment).not.toHaveBeenCalled();
    // A next action, not a dead end.
    expect(buttonWith('Open the unpaid order')).toBeTruthy();
  });

  it('sends no hash hint when the wallet returned a serialised transaction', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    apiMock.createOrder.mockResolvedValue({ order: ORDER });
    walletMock.sendPayment.mockResolvedValue({
      status: 'ok',
      value: { raw: '0100ab', kind: 'serialized', txHash: null },
    });
    apiMock.submitPayment.mockResolvedValue({ order: ORDER, status: 'waiting', note: null });
    await render(<DemoStoreScreen />);
    await click(buttonWith('Pay 0.01 NIM'));
    expect(apiMock.submitPayment).toHaveBeenCalledWith(ORDER.id, null);
  });
});

// --- Order ------------------------------------------------------------------

describe('Order', () => {
  it('shows a pending payment, when the chain was checked, and a retry', async () => {
    apiMock.getOrder.mockResolvedValue(
      status(
        { chainFetchedAtMs: 1_700_000_000_000 - 5_000 },
        { state: 'PAYMENT_PENDING', stateLabel: 'Waiting for the payment' },
      ),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(text()).toContain('Waiting for the payment');
    expect(byTestId('checked-at')?.textContent).toContain('5s ago');
    expect(text()).toContain('pending');
  });

  it('marks a stale reading as stale rather than implying it is live', async () => {
    apiMock.getOrder.mockResolvedValue(
      status({ chainFetchedAtMs: 1_700_000_000_000 - 120_000 }, { state: 'PAYMENT_PENDING' }),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(byTestId('checked-at')?.textContent).toContain('stale');
  });

  it('does not say "waiting for the chain" on a refund the chain already shows', async () => {
    apiMock.getOrder.mockResolvedValue(
      status({ execution: EXECUTION }, { state: 'REFUNDED', stateLabel: 'Refund verified on chain' }),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(text()).toContain('Sent, and found on chain.');
    expect(text()).not.toContain('Waiting for the chain to agree');
  });

  // A tester read the blue "in progress" dot on the last step as the refund being unfinished
  // (Skool feedback, 2026-09-16). A finished refund must mark every step done.
  it('marks every step done once the refund is verified on chain', () => {
    const steps = stepsFor(
      status({ execution: EXECUTION }, { state: 'REFUNDED', stateLabel: 'Refund verified on chain' }),
    );
    expect(steps[steps.length - 1]).toMatchObject({
      label: 'Refund verified on chain',
      status: 'done',
    });
    expect(steps.map((step) => step.status)).toEqual(Array(steps.length).fill('done'));
  });

  it('still marks the state in progress while the refund is only broadcast', () => {
    const steps = stepsFor(
      status({ execution: EXECUTION }, { state: 'REFUND_BROADCAST', stateLabel: 'Refund sent' }),
    );
    expect(steps[5]?.status).toBe('now');
    expect(steps[6]?.status).toBe('todo');
  });

  it('says "Nothing was sent yet" for an order whose payment was cancelled', async () => {
    apiMock.getOrder.mockResolvedValue(status({}, { state: 'CREATED' }));
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(byTestId('nothing-sent')?.textContent).toContain('Nothing was sent yet');
    expect(buttonWith(/Try the payment again/)).toBeTruthy();
  });

  it('retries the payment through the wallet and submits the hash it gets', async () => {
    apiMock.getOrder.mockResolvedValue(status({}, { state: 'CREATED' }));
    walletMock.sendPayment.mockResolvedValue({
      status: 'ok',
      value: { raw: 'a'.repeat(64), kind: 'hash', txHash: 'a'.repeat(64) },
    });
    apiMock.submitPayment.mockResolvedValue({ order: ORDER, status: 'waiting', note: null });
    await render(<OrderScreen orderId={ORDER.id} />);
    await click(buttonWith(/Try the payment again/));
    expect(apiMock.submitPayment).toHaveBeenCalledWith(ORDER.id, 'a'.repeat(64));
  });

  it('shows a verified payment as verified, with its block', async () => {
    apiMock.getOrder.mockResolvedValue(
      status({}, {
        state: 'PAID',
        stateLabel: 'Paid, verified on chain',
        paymentTxHash: 'a'.repeat(64),
        paymentBlockNumber: 61_480_679,
        payerAddress: 'NQ64 P4YR 0001',
      }),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(text()).toContain('verified in block 61480679');
    expect(buttonWith('Request refund')).toBeTruthy();
  });

  it('offers a way out of a terminal state instead of a dead end', async () => {
    apiMock.getOrder.mockResolvedValue(
      status({}, { state: 'REFUND_FAILED', stateLabel: 'Refund failed', lastError: 'node refused' }),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(text()).toContain('node refused');
    expect(buttonWith('Start again at the Demo Store')).toBeTruthy();
  });

  it('tells the buyer of a shop order that it waits on the shop, once', async () => {
    apiMock.getOrder.mockResolvedValue(
      status(
        { note: 'Waiting for the merchant to send the refund.' },
        { state: 'REFUND_APPROVED', refundSource: 'MERCHANT_WALLET' },
      ),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(byTestId('waiting-on-shop')?.textContent).toBe(
      'Approved. Waiting for the shop to send the refund.',
    );
    expect(text()).not.toContain('Waiting for the merchant to send the refund.');
  });

  it('says a requested shop refund waits for approval, and says nothing for the Demo Store', async () => {
    apiMock.getOrder.mockResolvedValue(
      status({}, { state: 'REFUND_REQUESTED', refundSource: 'MERCHANT_WALLET' }),
    );
    await render(<OrderScreen orderId={ORDER.id} />);
    expect(byTestId('waiting-on-shop')?.textContent).toBe(
      'Waiting for the shop to approve the refund.',
    );

    apiMock.getOrder.mockResolvedValue(status({}, { state: 'REFUND_REQUESTED' }));
    await render(<OrderScreen orderId="another0123456789" />);
    await settle();
    expect(byTestId('waiting-on-shop')).toBeNull();
  });
});

// --- Refund -----------------------------------------------------------------

describe('Refund request', () => {
  beforeEach(() => {
    apiMock.requestChallenge.mockResolvedValue({
      challenge: CHALLENGE,
      order: ORDER,
      explain: '',
    });
    apiMock.getOrder.mockResolvedValue(
      status({}, { state: 'PAID', payerAddress: 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001' }),
    );
  });

  it('shows the wallet the refund goes back to and asks that wallet to sign', async () => {
    await render(<RefundScreen orderId={ORDER.id} />);
    expect(text()).toContain('Sign with the wallet the refund goes back to');
    expect(text()).toContain('Refund goes to');
    expect(text()).toContain('NQ64 P4YR');
    expect(byTestId('refund-sender')?.textContent).toContain('Demo Store approves');
  });

  it('says a shop order is approved and sent by the shop, not by Rewind', async () => {
    apiMock.requestChallenge.mockResolvedValue({
      challenge: CHALLENGE,
      order: { ...ORDER, refundSource: 'MERCHANT_WALLET', merchantId: 'w-shop' },
      explain: '',
    });
    await render(<RefundScreen orderId={ORDER.id} />);
    expect(byTestId('refund-sender')?.textContent).toContain(
      'The shop then approves the request and sends the refund from its own wallet',
    );
    expect(byTestId('refund-sender')?.textContent).toContain('You get the full amount back');
    expect(text()).not.toContain('Demo Store approves');
  });

  it('keeps the canonical text behind a "what am I signing" toggle', async () => {
    await render(<RefundScreen orderId={ORDER.id} />);
    expect(byTestId('challenge-text')).toBeNull();
    await click(byTestId('what-am-i-signing') as HTMLButtonElement);
    expect(byTestId('challenge-text')?.textContent).toBe(CHALLENGE.message);
  });

  it('signs and submits the exact bytes it displayed', async () => {
    walletMock.sign.mockResolvedValue({
      status: 'ok',
      value: { publicKey: 'aa', signature: 'bb' },
    });
    apiMock.submitRefund.mockResolvedValue({
      order: ORDER,
      signedRequest: CHALLENGE,
      execution: null,
      autoApproved: true,
      note: 'Verified and approved by the Demo Store.',
    });
    await render(<RefundScreen orderId={ORDER.id} />);
    await click(buttonWith('Sign refund request'));
    expect(apiMock.submitRefund).toHaveBeenCalledWith(ORDER.id, {
      message: CHALLENGE.message,
      publicKey: 'aa',
      signature: 'bb',
    });
    expect(text()).toContain('approved by the Demo Store');
  });

  it('has its own screen for a cancelled signature, and submits nothing', async () => {
    walletMock.sign.mockResolvedValue({ status: 'cancelled', message: 'no' });
    await render(<RefundScreen orderId={ORDER.id} />);
    await click(buttonWith('Sign refund request'));
    expect(byTestId('cancelled-banner')?.textContent).toContain('Nothing was sent');
    expect(apiMock.submitRefund).not.toHaveBeenCalled();
  });

  it('shows a rejected signature in the API\'s own words', async () => {
    walletMock.sign.mockResolvedValue({
      status: 'ok',
      value: { publicKey: 'aa', signature: 'bb' },
    });
    apiMock.submitRefund.mockRejectedValue(
      new FakeApiError(
        'bad_request',
        'That signature could not be verified.',
        'bad_signature: signature does not match the public key',
      ),
    );
    await render(<RefundScreen orderId={ORDER.id} />);
    await click(buttonWith('Sign refund request'));
    expect(byTestId('refund-error-message')?.textContent).toBe(
      'That signature could not be verified.',
    );
    expect(byTestId('refund-error-detail')?.textContent).toBe(
      'bad_signature: signature does not match the public key',
    );
  });

  it('treats a 503 as submitted-but-unconfirmed, not as a rejection', async () => {
    // The signature is consumed before anything reads the chain, so "the node could not be
    // reached" never means the request failed — and re-signing would hit "nonce already
    // used", which reads as a rejection to a buyer.
    walletMock.sign.mockResolvedValue({
      status: 'ok',
      value: { publicKey: 'aa', signature: 'bb' },
    });
    apiMock.submitRefund.mockRejectedValue(
      new FakeApiError('unavailable', 'Verification is delayed: the Nimiq node could not be reached.'),
    );
    await render(<RefundScreen orderId={ORDER.id} />);
    await click(buttonWith('Sign refund request'));
    expect(byTestId('refund-error')).toBeNull();
    expect(text()).toContain('Verified and submitted');
    expect(buttonWith('Back to order')).toBeTruthy();
  });
});

// --- Receipt ----------------------------------------------------------------

describe('Receipt', () => {
  it('shows both transactions, their explorer links and the exact claim', async () => {
    apiMock.getOrder.mockResolvedValue(
      status(
        {
          signedRequest: {
            ...CHALLENGE,
            consumedAt: 1_700_000_050_000,
            signerAddress: 'NQ64 P4YR 0001',
            signatureHex: 'cc'.repeat(32),
          },
          execution: EXECUTION,
        },
        {
          state: 'REFUNDED',
          stateLabel: 'Refunded, verified on chain',
          paymentTxHash: 'a'.repeat(64),
          paymentExplorerUrl: `https://nimiq.watch/#${'a'.repeat(64)}`,
          paymentBlockNumber: 41_999,
          payerAddress: 'NQ64 P4YR 0001',
        },
      ),
    );
    await render(<ReceiptScreen orderId={ORDER.id} />);
    expect(byTestId('refund-claim')?.textContent).toContain(REFUND_CLAIM);
    expect(text()).toContain('paid by the Demo Store, not taken from your refund');
    expect(text()).not.toContain('reversible');
    expect(text()).not.toContain('guaranteed');
    expect(byTestId('payment-explorer')?.getAttribute('href')).toBe(
      `https://nimiq.watch/#${'a'.repeat(64)}`,
    );
    expect(byTestId('refund-explorer')?.getAttribute('href')).toBe(
      `https://nimiq.watch/#${'b'.repeat(64)}`,
    );
    // The signed request is summarised; the bytes stay behind a toggle.
    expect(text()).toContain('Signed by');
    expect(byTestId('signed-text-toggle')).toBeTruthy();
  });

  it('says plainly when there is nothing to show yet, and still offers a next step', async () => {
    apiMock.getOrder.mockResolvedValue(status());
    await render(<ReceiptScreen orderId={ORDER.id} />);
    expect(text()).toContain('No payment has been verified on chain');
    expect(buttonWith('Back to order')).toBeTruthy();
  });
});

// --- Your orders on this device ----------------------------------------------

describe('Your orders on this device', () => {
  it('lists the orders this device remembers, newest first, with links to each', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    window.localStorage.setItem(
      'rewind.orders',
      JSON.stringify([
        { id: 'order00000000002', label: 'Table 4', amountLuna: 2_500, createdAtMs: Date.now() },
        { id: 'order00000000001', label: 'Refund Test', amountLuna: 1_000, createdAtMs: Date.now() },
        { id: 42, label: 'malformed' },
      ]),
    );
    await render(<DemoStoreScreen />);
    const links = [...(byTestId('your-orders')?.querySelectorAll('a') ?? [])];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/order/order00000000002',
      '#/order/order00000000001',
    ]);
    expect(links[0]?.textContent).toBe('Table 4');
    expect(byTestId('your-orders')?.textContent).toContain('0.025 NIM');
    expect(text()).not.toContain('malformed');
  });

  it('is hidden when nothing is remembered', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    await render(<DemoStoreScreen />);
    expect(text()).not.toContain('Your orders on this device');
  });

  it('records a new order, and still pays when storage throws on every access', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    apiMock.createOrder.mockResolvedValue({ order: ORDER });
    walletMock.sendPayment.mockResolvedValue({
      status: 'ok',
      value: { raw: 'a'.repeat(64), kind: 'hash', txHash: 'a'.repeat(64) },
    });
    apiMock.submitPayment.mockResolvedValue({ order: ORDER, status: 'waiting', note: null });

    const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      expect(() => window.localStorage).toThrow('insecure');
      await render(<DemoStoreScreen />);
      expect(byTestId('your-orders')).toBeNull();
      await click(buttonWith('Pay 0.01 NIM'));
      await settle();
      expect(apiMock.submitPayment).toHaveBeenCalledWith(ORDER.id, 'a'.repeat(64));
      expect(window.location.hash).toBe(`#/order/${ORDER.id}`);
    } finally {
      blocked.mockRestore();
    }

    // With storage back, the next order is remembered.
    act(() => root.unmount());
    root = createRoot(container);
    await render(<DemoStoreScreen />);
    await click(buttonWith('Pay 0.01 NIM'));
    await settle();
    const stored = JSON.parse(window.localStorage.getItem('rewind.orders') ?? '[]') as Array<{
      id: string;
      label: string;
      amountLuna: number;
    }>;
    expect(stored[0]).toMatchObject({ id: ORDER.id, label: ORDER.itemLabel, amountLuna: 1_000 });
  });
});

// --- Payment links (merchant) --------------------------------------------------

const SHOP = {
  id: 'w-nq12shop0000000000000000000000000001',
  name: 'Corner Coffee',
  address: 'NQ12 SH0P 0000 0000 0000 0000 0000 0000 0001',
};

const REFUND_TO = 'NQ64 P4YR 0000 0000 0000 0000 0000 0000 0001';

function saveShop(): void {
  window.localStorage.setItem('rewind.merchant', JSON.stringify(SHOP));
}

function merchantChallengeFor(action: string, orderId?: string) {
  return {
    challenge: {
      message: `REWIND_MERCHANT_V1\naction=${action}`,
      expiresAtSec: Math.floor(Date.now() / 1000) + 120,
      merchantAddress: SHOP.address,
      action,
      orderId: orderId ?? '0',
      singleUse: action !== 'list',
    },
    required: true,
    explain: '',
  };
}

function shopRow(state: string, over: Partial<OrderView> = {}) {
  const order: OrderView = {
    ...ORDER,
    state,
    stateLabel: state,
    merchantId: SHOP.id,
    merchantAddress: SHOP.address,
    itemLabel: 'Table 4',
    refundSource: 'MERCHANT_WALLET',
    refunderAddress: SHOP.address,
    payerAddress: 'NQ00 HTLC 0000 0000 0000 0000 0000 0000 0009',
    ...over,
  };
  return {
    order,
    signedRequest: { ...CHALLENGE, refundTo: REFUND_TO, signerAddress: REFUND_TO },
    execution:
      state === 'REFUND_REQUESTED'
        ? null
        : {
            ...EXECUTION,
            source: 'MERCHANT_WALLET',
            refundTo: REFUND_TO,
            amountLuna: 1_000,
            refunderAddress: SHOP.address,
            intendedTxHash: null,
            broadcastAt: null,
            refundTxHash: null,
            refundExplorerUrl: null,
            refundBlockNumber: null,
            confirmedAt: null,
          },
  };
}

/** Saved shop, signed in, board loaded with `rows`. */
async function renderSignedInBoard(rows: ReturnType<typeof shopRow>[]): Promise<void> {
  saveShop();
  apiMock.merchantChallenge.mockImplementation(async (_id: string, action: string, orderId?: string) =>
    merchantChallengeFor(action, orderId),
  );
  walletMock.sign.mockResolvedValue({ status: 'ok', value: { publicKey: 'mm', signature: 'ss' } });
  apiMock.listMerchantRequests.mockResolvedValue({
    requests: rows,
    scopedToMerchantId: SHOP.id,
    authenticated: true,
  });
  await render(<MerchantScreen />);
  await click(buttonWith('Sign in with wallet'));
  await settle();
}

describe('Payment links', () => {
  it('registers by signing the exact three-line text, then saves and shows the shop', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_123_456);
    walletMock.sign.mockResolvedValue({ status: 'ok', value: { publicKey: 'pk', signature: 'sig' } });
    apiMock.registerMerchant.mockResolvedValue({ merchant: SHOP });

    await render(<MerchantScreen />);
    expect(hasButton(/Acting as|Create order/)).toBe(false);
    await type('input[aria-label="Shop name"]', '  Corner Coffee ');
    await click(buttonWith('Create my payment link'));
    await settle();
    vi.mocked(Date.now).mockRestore();

    const message = 'REWIND_MERCHANT_REGISTER_V1\nname=Corner Coffee\nissued=1700000123';
    expect(walletMock.sign).toHaveBeenCalledWith(message);
    expect(apiMock.registerMerchant).toHaveBeenCalledWith({
      message,
      publicKey: 'pk',
      signature: 'sig',
    });
    expect(JSON.parse(window.localStorage.getItem('rewind.merchant') ?? 'null')).toEqual(SHOP);
    expect(text()).toContain('Corner Coffee');
    expect(buttonWith('Use a different wallet')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Shop name"]')).toBeNull();
  });

  it('creates nothing when the registration signature is cancelled', async () => {
    walletMock.sign.mockResolvedValue({ status: 'cancelled', message: 'no' });
    await render(<MerchantScreen />);
    await type('input[aria-label="Shop name"]', 'Corner Coffee');
    await click(buttonWith('Create my payment link'));
    await settle();
    expect(apiMock.registerMerchant).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('rewind.merchant')).toBeNull();
    expect(text()).toContain('No payment link was created');
  });

  it('forgets the saved shop on "Use a different wallet"', async () => {
    saveShop();
    await render(<MerchantScreen />);
    await click(buttonWith('Use a different wallet'));
    expect(window.localStorage.getItem('rewind.merchant')).toBeNull();
    expect(buttonWith('Create my payment link')).toBeTruthy();
  });

  it('builds the exact link for 0.01 NIM and a label, and refuses an amount over 1 NIM', async () => {
    saveShop();
    await render(<MerchantScreen />);
    // Defaults: 0.01 NIM, labelled with the shop name.
    expect(byTestId('payment-link')?.textContent).toBe(
      `${window.location.origin}/#/pay/${SHOP.id}?amount=1000&label=Corner%20Coffee`,
    );

    await type('input[aria-label="Label"]', 'Table 4 & a flat white');
    expect(byTestId('payment-link')?.textContent).toBe(
      `${window.location.origin}/#/pay/${SHOP.id}?amount=1000&label=${encodeURIComponent('Table 4 & a flat white')}`,
    );
    expect(text()).toContain(SHARE_NOTE);

    await type('input[aria-label="Amount in NIM"]', '1.5');
    expect(byTestId('payment-link')).toBeNull();
    expect(byTestId('amount-problem')).toBeTruthy();

    await type('input[aria-label="Amount in NIM"]', '0.123456');
    expect(byTestId('payment-link')).toBeNull();
  });

  it('copies the link to the clipboard', async () => {
    saveShop();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await render(<MerchantScreen />);
      await click(buttonWith('Copy link'));
      expect(writeText).toHaveBeenCalledWith(byTestId('payment-link')?.textContent);
      expect(text()).toContain('Copied.');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('signs the merchant challenge before approving, and sends the signature', async () => {
    await renderSignedInBoard([shopRow('REFUND_REQUESTED')]);
    apiMock.merchantAction.mockResolvedValue({ order: ORDER, execution: null });

    expect(apiMock.merchantChallenge).toHaveBeenCalledWith(SHOP.id, 'list');
    await click(buttonWith('Approve'));
    await settle();

    expect(apiMock.merchantChallenge).toHaveBeenCalledWith(SHOP.id, 'approve', ORDER.id);
    expect(apiMock.merchantAction).toHaveBeenCalledWith(ORDER.id, 'approve', {
      message: 'REWIND_MERCHANT_V1\naction=approve',
      publicKey: 'mm',
      signature: 'ss',
    });
  });

  it('does nothing at all when the merchant cancels the approval signature', async () => {
    await renderSignedInBoard([shopRow('REFUND_REQUESTED')]);
    walletMock.sign.mockResolvedValue({ status: 'cancelled', message: 'no' });
    await click(buttonWith('Approve'));
    await settle();
    expect(apiMock.merchantAction).not.toHaveBeenCalled();
    expect(text()).toContain('cancelled the approve signature');
  });

  it('sends an approved refund from the wallet to refundTo with the RW1:R reference', async () => {
    await renderSignedInBoard([shopRow('REFUND_APPROVED')]);
    walletMock.sendPayment.mockResolvedValue({
      status: 'ok',
      value: { raw: '0100ab', kind: 'serialized', txHash: null },
    });

    // The destination shown is the execution's, not the paying HTLC.
    expect(text()).toContain('Refund goes to');
    expect(text()).not.toContain('NQ00 HTLC');
    await click(buttonWith('Send refund'));
    await settle();

    expect(walletMock.sendPayment).toHaveBeenCalledWith({
      recipient: REFUND_TO,
      value: 1_000,
      data: `RW1:R:${ORDER.id}`,
    });
    // The server finds the refund by its reference; nothing is reported back.
    expect(apiMock.merchantAction).not.toHaveBeenCalled();
    expect(text()).toContain(REFUND_SENT_NOTE);
    // A second tap cannot send it twice while the chain catches up.
    expect(buttonWith('Sent. Waiting for the chain').disabled).toBe(true);
  });

  it('says nothing was sent when the refund wallet dialog is cancelled', async () => {
    await renderSignedInBoard([shopRow('REFUND_APPROVED')]);
    walletMock.sendPayment.mockResolvedValue({ status: 'cancelled', message: 'no' });
    await click(buttonWith('Send refund'));
    await settle();
    expect(text()).toContain('nothing was sent');
    expect(buttonWith('Send refund').disabled).toBe(false);
  });

  it('shows settled rows with their state and a receipt link, and no actions', async () => {
    await renderSignedInBoard([shopRow('REFUNDED', { stateLabel: 'Refund verified on chain' })]);
    expect(text()).toContain('Refund verified on chain');
    const receipt = byTestId(`refund-row-${ORDER.id}`)?.querySelector('a');
    expect(receipt?.getAttribute('href')).toBe(`#/receipt/${ORDER.id}`);
    expect(hasButton(/Approve|Send refund/)).toBe(false);
  });
});

// --- Pay (payment link) --------------------------------------------------------

describe('Pay', () => {
  const SHOP_ORDER: OrderView = {
    ...ORDER,
    id: 'shoporder0123456',
    merchantId: SHOP.id,
    merchantAddress: SHOP.address,
    itemLabel: 'Table 4',
    amountLuna: 2_500,
    amountLabel: '0.025 NIM',
    refundSource: 'MERCHANT_WALLET',
    paymentReference: 'RW1:P:shoporder0123456',
  };

  it('shows the shop, where the NIM goes and the refund line, then creates and pays the order', async () => {
    apiMock.getMerchant.mockResolvedValue({ merchant: { ...SHOP, isDemoStore: false } });
    apiMock.createOrder.mockResolvedValue({ order: SHOP_ORDER });
    walletMock.sendPayment.mockResolvedValue({
      status: 'ok',
      value: { raw: 'a'.repeat(64), kind: 'hash', txHash: 'a'.repeat(64) },
    });
    apiMock.submitPayment.mockResolvedValue({ order: SHOP_ORDER, status: 'waiting', note: null });

    await render(<PayScreen merchantId={SHOP.id} amountLuna={2_500} label="Table 4" />);
    expect(apiMock.getMerchant).toHaveBeenCalledWith(SHOP.id);
    expect(text()).toContain('Corner Coffee');
    expect(text()).toContain('0.025 NIM');
    expect(text()).toContain('Table 4');
    expect(byTestId('pay-refund-line')?.textContent).toBe(PAY_REFUND_LINE);
    expect(text()).not.toContain('paying from');

    await click(buttonWith('Pay 0.025 NIM'));
    await settle();

    expect(apiMock.createOrder).toHaveBeenCalledWith({
      merchantId: SHOP.id,
      amountLuna: 2_500,
      reference: 'Table 4',
    });
    expect(walletMock.sendPayment).toHaveBeenCalledWith({
      recipient: SHOP.address,
      value: 2_500,
      data: 'RW1:P:shoporder0123456',
    });
    expect(apiMock.submitPayment).toHaveBeenCalledWith(SHOP_ORDER.id, 'a'.repeat(64));
    expect(window.location.hash).toBe(`#/order/${SHOP_ORDER.id}`);
    expect(window.localStorage.getItem('rewind.orders')).toContain(SHOP_ORDER.id);
  });

  it('uses the shop name as the reference when the link has no label', async () => {
    apiMock.getMerchant.mockResolvedValue({ merchant: { ...SHOP, isDemoStore: false } });
    apiMock.createOrder.mockResolvedValue({ order: SHOP_ORDER });
    walletMock.sendPayment.mockResolvedValue({ status: 'cancelled', message: 'no' });

    await render(<PayScreen merchantId={SHOP.id} amountLuna={1_000} label={null} />);
    await click(buttonWith('Pay 0.01 NIM'));
    await settle();

    expect(apiMock.createOrder).toHaveBeenCalledWith({
      merchantId: SHOP.id,
      amountLuna: 1_000,
      reference: 'Corner Coffee',
    });
    expect(byTestId('cancelled-banner')?.textContent).toContain('nothing was sent');
    expect(apiMock.submitPayment).not.toHaveBeenCalled();
  });

  it.each([null, 0, 100_001])('refuses a link with amount %s: an error and no Pay button', async (amount) => {
    apiMock.getMerchant.mockResolvedValue({ merchant: { ...SHOP, isDemoStore: false } });
    await render(<PayScreen merchantId={SHOP.id} amountLuna={amount} label={null} />);
    expect(byTestId('pay-link-error')?.textContent).toContain('no valid amount');
    expect(hasButton(/^Pay /)).toBe(false);
  });

  it('refuses a link to an unknown shop: the API message and no Pay button', async () => {
    apiMock.getMerchant.mockRejectedValue(
      new FakeApiError('not_found', 'This payment link does not belong to a Rewind merchant.'),
    );
    await render(<PayScreen merchantId="w-nobody" amountLuna={1_000} label={null} />);
    expect(byTestId('pay-merchant-error')?.textContent).toBe(
      'This payment link does not belong to a Rewind merchant.',
    );
    expect(hasButton(/^Pay /)).toBe(false);
  });

  it('sends a link to the Demo Store to the Demo Store screen', async () => {
    apiMock.getMerchant.mockResolvedValue({
      merchant: { id: 'demo-store', name: 'Demo Store', address: SHOP.address, isDemoStore: true },
    });
    await render(<PayScreen merchantId="demo-store" amountLuna={1_000} label={null} />);
    expect(window.location.hash).toBe('#/store');
    expect(hasButton(/^Pay /)).toBe(false);
  });
});

// --- App shell ----------------------------------------------------------------

describe('App shell', () => {
  async function renderApp(): Promise<void> {
    apiMock.health.mockResolvedValue(HEALTH);
    await render(<App />);
    await act(async () => {
      window.dispatchEvent(new Event(WALLET_READY_EVENT));
    });
  }

  it('tells a browser without Nimiq Pay to open the app there, not that it is in development mode', async () => {
    walletFlags.fake = false;
    walletFlags.nimiqPay = false;
    await renderApp();
    expect(byTestId('open-in-nimiq-pay')?.textContent).toContain('Open Rewind inside the Nimiq Pay app');
    expect(byTestId('dev-wallet-banner')).toBeNull();
    expect(text()).not.toContain('fake chain');
  });

  it('shows the development banner only when the fake wallet is in use', async () => {
    walletFlags.fake = true;
    await renderApp();
    expect(byTestId('dev-wallet-banner')?.textContent).toContain('Development mode');
    expect(byTestId('open-in-nimiq-pay')).toBeNull();
  });

  it('shows no wallet banner inside Nimiq Pay', async () => {
    walletFlags.fake = false;
    walletFlags.nimiqPay = true;
    await renderApp();
    expect(byTestId('dev-wallet-banner')).toBeNull();
    expect(byTestId('open-in-nimiq-pay')).toBeNull();
  });

  it.each([
    ['#/order/abcdef0123456789', 'Order'],
    ['#/refund/abcdef0123456789', 'Refund'],
    ['#/receipt/abcdef0123456789', 'Receipt'],
  ])('labels the third tab for %s as "%s", not with the raw route name', async (hash, label) => {
    apiMock.getOrder.mockResolvedValue(status());
    window.location.hash = hash;
    try {
      await renderApp();
      const tabs = [...document.querySelectorAll('nav.tabs button')].map((b) => b.textContent);
      expect(tabs).toEqual(['Demo Store', 'Payment links', label]);
    } finally {
      window.location.hash = '';
    }
  });

  it('discloses on every screen what Rewind stores', async () => {
    await renderApp();
    expect(byTestId('data-notice')?.textContent).toBe(DATA_NOTICE);
    expect(DATA_NOTICE).toContain('wallet addresses');
  });
});

