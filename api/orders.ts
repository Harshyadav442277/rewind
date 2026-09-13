import { getDeps, DEMO_MERCHANT_ID } from './_lib/deps';
import {
  clientIp,
  methodNotAllowed,
  readJsonBody,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http';
import { DEFAULT_LIMITS, rateLimit } from './_lib/ratelimit';
import { orderView } from './_lib/views';
import { createOrder } from '../server/domain/order-service';

/** The single Demo Store item. 0.01 NIM = 1000 Luna. */
export const DEMO_ITEM = { label: 'Refund Test — 0.01 NIM', amountLuna: 1_000 } as const;

/** Bounds on a merchant-created order. Small on purpose: this is a demo on mainnet. */
export const MAX_ORDER_LUNA = 100_000; // 1 NIM
export const MAX_REFERENCE_LENGTH = 40;

/**
 * POST /api/orders   { merchantId?, amountLuna?, reference? }   create an order
 * GET  /api/orders   list recent orders (merchant screen and local development)
 *
 * `amountLuna` and `reference` exist for the merchant screen, which creates its own orders.
 * Left out, the single Demo Store item is used. `reference` is the merchant's own label for
 * the order — their invoice number, a table number — and it is stored as the item label. It
 * never reaches the chain: the on-chain reference is always `RW1:P:<orderId>`, which is what
 * the payment scan looks for.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  const deps = getDeps();

  if (req.method === 'GET') {
    const limit = rateLimit(`orders:list:${clientIp(req)}`, DEFAULT_LIMITS.read);
    if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');
    const orders = await deps.repo.listOrders(50);
    return sendJson(res, 200, { orders: orders.map(orderView) });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

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
