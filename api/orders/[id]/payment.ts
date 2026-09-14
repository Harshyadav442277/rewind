import { getDeps } from '../../_lib/deps.js';
import {
  clientIp,
  methodNotAllowed,
  queryParam,
  readJsonBody,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../../_lib/http.js';
import { DEFAULT_LIMITS, rateLimit } from '../../_lib/ratelimit.js';
import { orderView } from '../../_lib/views.js';
import { submitPaymentHint, verifyOrderPayment } from '../../../server/domain/order-service.js';

/**
 * POST /api/orders/:id/payment   { txHash }
 *
 * The wallet handed the client a transaction hash. That is a HINT: it tells the server which
 * chain record to go and look at. The order only becomes PAID if that record satisfies the
 * acceptance predicate — right recipient, right amount to the Luna, right `RW1:P:<id>`
 * reference, executed, on the right network, deep enough.
 *
 * So a caller who invents a hash, or replays somebody else's, gets a mismatch, not a payment.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const id = queryParam(req, 'id');
  if (!id) return sendError(res, 'bad_request', 'Missing order id.');

  const limit = rateLimit(`payment:${clientIp(req)}`, DEFAULT_LIMITS.write);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');

  const body = readJsonBody(req);
  // Optional on purpose: a wallet that returns a serialised transaction rather than a hash
  // leaves the client with no pointer, and the server finds the payment by its reference.
  const raw = body.txHash;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return sendError(res, 'bad_request', 'That is not a transaction hash.', 'txHash must be a string');
  }
  const txHash = typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 128) : null;

  const deps = getDeps();
  const hint = await submitPaymentHint(deps, id, txHash);
  if (!hint.ok) {
    if (hint.reason === 'not_found') return sendError(res, 'not_found', 'Order not found.');
    if (hint.reason === 'bad_tx_hash') {
      return sendError(res, 'bad_request', 'That is not a transaction hash.', hint.detail);
    }
    if (hint.reason === 'tx_already_used') {
      return sendError(
        res,
        'conflict',
        'That payment is already attached to another order.',
        hint.detail,
      );
    }
    return sendError(res, 'conflict', 'This order is not waiting for a payment.', hint.detail);
  }

  // Check immediately so the buyer usually sees the answer without a second round trip.
  const check = await verifyOrderPayment(deps, id);
  const order = 'order' in check && check.order ? check.order : hint.order;

  return sendJson(res, 202, {
    order: orderView(order),
    status: check.status,
    note: 'message' in check ? check.message : null,
    chainFetchedAtMs: 'chainFetchedAtMs' in check ? check.chainFetchedAtMs : null,
  });
});
