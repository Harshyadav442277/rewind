/** Typed client for the `api/` endpoints. Shapes mirror `api/_lib/views.ts`. */

export interface OrderView {
  id: string;
  state: string;
  stateLabel: string;
  merchantId: string;
  merchantAddress: string;
  itemLabel: string;
  amountLuna: number;
  amountLabel: string;
  networkId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  paymentTxHash: string | null;
  paymentExplorerUrl: string | null;
  payerAddress: string | null;
  paidAt: number | null;
  paymentBlockNumber: number | null;
  claimedPaymentTxHash: string | null;
  refundSource: string;
  refunderAddress: string;
  lastError: string | null;
  paymentReference: string;
  refundReference: string;
}

export interface ChallengeView {
  nonce: string;
  message: string;
  refundTo: string;
  amountLuna: number;
  expiresAtSec: number;
  consumedAt: number | null;
  signerAddress: string | null;
  signatureHex: string | null;
}

export interface ExecutionView {
  id: string;
  source: string;
  refundTo: string;
  amountLuna: number;
  amountLabel: string;
  refunderAddress: string;
  intendedTxHash: string | null;
  broadcastAt: number | null;
  refundTxHash: string | null;
  refundExplorerUrl: string | null;
  refundBlockNumber: number | null;
  confirmedAt: number | null;
  failureReason: string | null;
}

export interface OrderStatus {
  order: OrderView;
  challenge: ChallengeView | null;
  signedRequest: ChallengeView | null;
  execution: ExecutionView | null;
  chainFetchedAtMs: number | null;
  note: string | null;
  serverTimeMs: number;
}

export interface HealthView {
  chain: {
    reachable: boolean;
    /** `fake`, `lightclient` (local testnet rehearsal) or `rpc`. */
    mode: string;
    /** `testnet` or `mainnet`. The client is told; it never guesses. */
    network: string;
    /** Prefix every explorer link in a view was built from. Shown, not used to build links. */
    explorerBase: string;
    networkId: string;
    blockNumber: number | null;
    checkedAtMs: number | null;
    error: string | null;
  };
  treasury: {
    address: string;
    balanceLuna: number | null;
    balanceLabel: string | null;
    floorLuna: number;
    floorLabel: string;
  };
  demoPaused: boolean;
  demoPausedReason: string | null;
  repo: string;
  serverTimeMs: number;
}

export interface MerchantChallengeView {
  message: string;
  expiresAtSec: number;
  merchantAddress: string;
  action: string;
  orderId: string;
  singleUse: boolean;
}

/** What the merchant board holds after signing once, to authenticate its reads. */
export interface MerchantSession {
  merchantId: string;
  message: string;
  publicKey: string;
  signature: string;
  expiresAtSec: number;
}

export interface MerchantRequestRow {
  order: OrderView;
  signedRequest: ChallengeView | null;
  execution: ExecutionView | null;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string; detail?: string } }).error;
    throw new ApiError(
      error?.code ?? 'internal',
      error?.message ?? `Request failed (${response.status}).`,
      error?.detail,
    );
  }
  return json as T;
}

/** Headers that authenticate a merchant read. The text is base64 because headers have no newlines. */
function merchantHeaders(session: MerchantSession | null): Record<string, string> {
  if (!session) return {};
  return {
    'x-rewind-merchant-challenge': btoa(session.message),
    'x-rewind-merchant-publickey': session.publicKey,
    'x-rewind-merchant-signature': session.signature,
  };
}

export interface CreateOrderInput {
  merchantId?: string;
  amountLuna?: number;
  reference?: string;
}

export const api = {
  health: () => request<HealthView>('/api/health'),

  createOrder: (input: CreateOrderInput = {}) =>
    request<{ order: OrderView }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getOrder: (id: string) => request<OrderStatus>(`/api/orders/${encodeURIComponent(id)}`),

  /** `txHash` is null when the wallet gave us no usable hash; the server then scans. */
  submitPayment: (id: string, txHash: string | null) =>
    request<{ order: OrderView; status: string; note: string | null }>(
      `/api/orders/${encodeURIComponent(id)}/payment`,
      { method: 'POST', body: JSON.stringify(txHash === null ? {} : { txHash }) },
    ),

  requestChallenge: (id: string) =>
    request<{ challenge: ChallengeView; order: OrderView | null; explain: string }>(
      `/api/orders/${encodeURIComponent(id)}/refund-challenge`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  submitRefund: (id: string, signed: { message: string; publicKey: string; signature: string }) =>
    request<{
      order: OrderView;
      signedRequest: ChallengeView;
      execution: ExecutionView | null;
      autoApproved: boolean;
      note: string;
    }>(
      `/api/orders/${encodeURIComponent(id)}/refund`,
      { method: 'POST', body: JSON.stringify(signed) },
    ),

  listMerchantRequests: (session: MerchantSession | null) =>
    request<{
      requests: MerchantRequestRow[];
      scopedToMerchantId: string | null;
      authenticated: boolean;
    }>('/api/merchant/refunds', { headers: merchantHeaders(session) }),

  merchantChallenge: (merchantId: string, action: string, orderId?: string) =>
    request<{ challenge: MerchantChallengeView; required: boolean; explain: string }>(
      '/api/merchant/challenge',
      {
        method: 'POST',
        body: JSON.stringify({ merchantId, action, ...(orderId ? { orderId } : {}) }),
      },
    ),

  merchantAction: (
    orderId: string,
    action: 'approve' | 'reject' | 'record-tx',
    signed?: { message: string; publicKey: string; signature: string },
    txHash?: string,
  ) =>
    request<{
      order: OrderView | null;
      execution: ExecutionView | null;
      status?: string;
      settleStatus?: string;
      alreadyReserved?: boolean;
      note?: string | null;
    }>('/api/merchant/refunds', {
      method: 'POST',
      body: JSON.stringify({ orderId, action, ...(signed ?? {}), ...(txHash ? { txHash } : {}) }),
    }),
};
