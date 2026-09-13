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

const { apiMock, walletMock, FakeApiError } = vi.hoisted(() => {
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
    },
    walletMock: {
      listAccounts: vi.fn(),
      sign: vi.fn(),
      sendPayment: vi.fn(),
    },
  };
});

vi.mock('../api', () => ({ api: apiMock, ApiError: FakeApiError }));

vi.mock('../wallet', () => ({
  getWallet: () => walletMock,
  isFakeWallet: () => true,
  shortAddress: (a: string) => a,
}));

import { AUTO_APPROVE_DISCLOSURE, DemoStoreScreen } from './DemoStore';
import { OrderScreen } from './Order';
import { RefundScreen } from './Refund';
import { REFUND_CLAIM, ReceiptScreen } from './Receipt';
import { MerchantScreen } from './Merchant';

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
  walletMock.listAccounts.mockResolvedValue({ status: 'ok', value: ['NQ64 P4YR 0001'] });
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

// --- Demo Store -------------------------------------------------------------

describe('Demo Store', () => {
  it('shows the item, the price and the auto-approval disclosure verbatim', async () => {
    apiMock.health.mockResolvedValue(HEALTH);
    await render(<DemoStoreScreen />);
    expect(text()).toContain('0.01 NIM');
    expect(byTestId('auto-approve-disclosure')?.textContent).toBe(`${AUTO_APPROVE_DISCLOSURE}.`);
    expect(buttonWith('Pay 0.01 NIM').disabled).toBe(false);
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

  it('shows the paying address and tells you which wallet to sign with', async () => {
    await render(<RefundScreen orderId={ORDER.id} />);
    expect(text()).toContain('Sign with the wallet that paid');
    expect(text()).toContain('NQ64 P4YR');
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

  it('shows the wrong-signer error in the API\'s own words', async () => {
    walletMock.sign.mockResolvedValue({
      status: 'ok',
      value: { publicKey: 'aa', signature: 'bb' },
    });
    apiMock.submitRefund.mockRejectedValue(
      new FakeApiError(
        'bad_request',
        'That signature is not from the wallet that paid for this order.',
        'signer_not_payer: NQ11 OTHER does not match NQ64 P4YR',
      ),
    );
    await render(<RefundScreen orderId={ORDER.id} />);
    await click(buttonWith('Sign refund request'));
    expect(byTestId('refund-error-message')?.textContent).toBe(
      'That signature is not from the wallet that paid for this order.',
    );
    expect(byTestId('refund-error-detail')?.textContent).toBe(
      'signer_not_payer: NQ11 OTHER does not match NQ64 P4YR',
    );
  });

  it('treats a 503 as submitted-but-unconfirmed, not as a rejection', async () => {
    // The signature is consumed before anything reads the chain, so "the node could not be
    // reached" never means the request failed — and re-signing would hit "nonce already
    // used", which reads as a rejection to a buyer. The light-client rehearsal makes this
    // the common case: it throws about transactions that exist for ~30 s after inclusion.
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

// --- Merchant ---------------------------------------------------------------

describe('Merchant', () => {
  it('renders a canned example, badged, when nothing real is waiting', async () => {
    apiMock.listMerchantRequests.mockResolvedValue({
      requests: [],
      scopedToMerchantId: null,
      authenticated: false,
    });
    await render(<MerchantScreen />);
    expect(text()).toContain('example');
    expect(text()).toContain('Nothing real is waiting');
  });

  it('creates an order with an amount and a reference, and shows a share link', async () => {
    apiMock.listMerchantRequests.mockResolvedValue({
      requests: [],
      scopedToMerchantId: null,
      authenticated: false,
    });
    apiMock.createOrder.mockResolvedValue({
      order: { ...ORDER, itemLabel: 'table 4', amountLuna: 2_500, amountLabel: '0.025 NIM' },
    });
    await render(<MerchantScreen />);

    await type('input[aria-label="Your reference"]', 'table 4');
    await type('input[aria-label="Amount in Luna"]', '2500');
    await click(buttonWith('Create order'));

    expect(apiMock.createOrder).toHaveBeenCalledWith({
      merchantId: 'demo-store',
      amountLuna: 2_500,
      reference: 'table 4',
    });
    expect(byTestId('share-link')?.textContent).toContain(`#/order/${ORDER.id}`);
  });

  it('signs the merchant challenge before approving, and sends the signature', async () => {
    apiMock.listMerchantRequests.mockResolvedValue({
      requests: [
        {
          order: { ...ORDER, state: 'REFUND_REQUESTED', stateLabel: 'Refund requested' },
          signedRequest: null,
          execution: null,
        },
      ],
      scopedToMerchantId: 'demo-store',
      authenticated: true,
    });
    apiMock.merchantChallenge.mockResolvedValue({
      challenge: {
        message: 'REWIND_MERCHANT_V1\naction=approve',
        expiresAtSec: 1,
        merchantAddress: 'NQ79',
        action: 'approve',
        orderId: ORDER.id,
        singleUse: true,
      },
      required: true,
      explain: '',
    });
    walletMock.sign.mockResolvedValue({
      status: 'ok',
      value: { publicKey: 'mm', signature: 'ss' },
    });
    apiMock.merchantAction.mockResolvedValue({
      order: ORDER,
      execution: null,
      settleStatus: 'sent',
    });

    await render(<MerchantScreen />);
    await click(buttonWith('Approve'));

    expect(apiMock.merchantChallenge).toHaveBeenCalledWith('demo-store', 'approve', ORDER.id);
    expect(apiMock.merchantAction).toHaveBeenCalledWith(ORDER.id, 'approve', {
      message: 'REWIND_MERCHANT_V1\naction=approve',
      publicKey: 'mm',
      signature: 'ss',
    });
  });

  it('does nothing at all when the merchant cancels the approval signature', async () => {
    apiMock.listMerchantRequests.mockResolvedValue({
      requests: [
        {
          order: { ...ORDER, state: 'REFUND_REQUESTED', stateLabel: 'Refund requested' },
          signedRequest: null,
          execution: null,
        },
      ],
      scopedToMerchantId: 'demo-store',
      authenticated: true,
    });
    apiMock.merchantChallenge.mockResolvedValue({
      challenge: {
        message: 'REWIND_MERCHANT_V1\naction=approve',
        expiresAtSec: 1,
        merchantAddress: 'NQ79',
        action: 'approve',
        orderId: ORDER.id,
        singleUse: true,
      },
      required: true,
      explain: '',
    });
    walletMock.sign.mockResolvedValue({ status: 'cancelled', message: 'no' });

    await render(<MerchantScreen />);
    await click(buttonWith('Approve'));

    expect(apiMock.merchantAction).not.toHaveBeenCalled();
    expect(text()).toContain('cancelled the approve signature');
  });
});
