import { getDeps, DEMO_MERCHANT_ID } from './_lib/deps.js';
import {
  clientIp,
  methodNotAllowed,
  readJsonBody,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http.js';
import { DEFAULT_LIMITS, rateLimit } from './_lib/ratelimit.js';
import { orderView } from './_lib/views.js';
import { createOrder } from '../server/domain/order-service.js';

/** The single Demo Store item. 0.01 NIM = 1000 Luna. */
export const DEMO_ITEM = { label: 'Refund Test — 0.01 NIM', amountLuna: 1_000 } as const;

/** Bounds on a merchant-created order. Small on purpose: this is a demo on mainnet. */
export const MAX_ORDER_LUNA = 100_000; // 1 NIM
export const MAX_REFERENCE_LENGTH = 40;

/**
 * POST /api/orders   { merchantId?, amountLuna?, reference? }   create an order
 *
 * `amountLuna` and `reference` exist for payment links, which name their own amount and label.
 * Left out, the single Demo Store item is used. `reference` is the shop's own label for the
 * order — their invoice number, a table number — and it is stored as the item label. It never
 * reaches the chain: the on-chain reference is always `RW1:P:<orderId>`, which is what the
 * payment scan looks for.
 *
 * There is deliberately no GET. A list of every order would hand anyone the payer addresses
 * and the order ids of strangers. A buyer reads their own order by its id, and a shop reads
 * its own orders through `GET /api/merchant/refunds`, signed by the shop's wallet.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const deps = getDeps();

  const limit = rateLimit(`orders:create:${clientIp(req)}`, DEFAULT_LIMITS.write);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many orders. Wait a moment.');

  const body = readJsonBody(req);
  const merchantId = typeof body.merchantId === 'string' ? body.merchantId : DEMO_MERCHANT_ID;

  let amountLuna: number = DEMO_ITEM.amountLuna;
  if (body.amountLuna !== undefined) {
    const requested = Number(body.amountLuna);
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > MAX_ORDER_LUNA) {
      return sendError(
        res,
        'bad_request',
        `Enter an amount between 1 and ${MAX_ORDER_LUNA} Luna.`,
        `amountLuna must be an integer in 1..${MAX_ORDER_LUNA}`,
      );
    }
    amountLuna = requested;
  }

  let itemLabel: string = DEMO_ITEM.label;
  if (body.reference !== undefined) {
    const reference = String(body.reference).trim();
    if (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) {
      return sendError(
        res,
        'bad_request',
        `A reference has to be 1 to ${MAX_REFERENCE_LENGTH} characters.`,
        'reference length out of range',
      );
    }
    itemLabel = reference;
  }

  const result = await createOrder(deps, { merchantId, itemLabel, amountLuna });
  if (!result.ok) {
    return sendError(res, 'bad_request', 'That order could not be created.', `${result.reason}: ${result.detail}`);
  }
  return sendJson(res, 201, { order: orderView(result.order) });
});
