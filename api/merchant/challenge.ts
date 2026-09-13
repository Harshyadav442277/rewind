import { getDeps } from '../_lib/deps';
import {
  clientIp,
  methodNotAllowed,
  readJsonBody,
  requireString,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../_lib/http';
import { DEFAULT_LIMITS, rateLimit } from '../_lib/ratelimit';
import { issueAndRecordMerchantChallenge, merchantAuthRequired } from '../_lib/merchant-auth';
import { isMerchantAction, LIST_ORDER_SENTINEL } from '../../server/domain/merchant-auth';

/**
 * POST /api/merchant/challenge   { merchantId, orderId, action }
 *
 * Returns the exact text the merchant's wallet must sign to perform `action` on `orderId`.
 * Issuing changes nothing and grants nothing: the text is worthless without the merchant's
 * key, and it binds one action to one order for a couple of minutes.
 *
 * The server issues it rather than letting the client compose it, so the server owns the
 * clock and the canonical spelling of the address — and, since gap S3 was closed, so that
 * the challenge is RECORDED. A signature over text this server never issued is refused, and
 * a state-changing challenge is single use.
 *
 * `action: "list"` is the read credential for `GET /api/merchant/refunds`. It is bound to no
 * order, so `orderId` is ignored and the all-zero sentinel is used instead, and it is not
 * consumed — one signature backs the merchant board's polling for the life of the challenge.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const limit = rateLimit(`merchant:challenge:${clientIp(req)}`, DEFAULT_LIMITS.signature);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Wait a moment.');

  const body = readJsonBody(req);
  const merchantId = requireString(body, 'merchantId', { maxLength: 64 });
  const action = requireString(body, 'action', { maxLength: 32 });
  if (!isMerchantAction(action)) {
    return sendError(res, 'bad_request', 'Unknown action.', 'use approve, reject, record-tx or list');
  }
  const orderId =
    action === 'list' ? LIST_ORDER_SENTINEL : requireString(body, 'orderId', { maxLength: 64 });

  const deps = getDeps();
  const merchant = await deps.repo.getMerchant(merchantId);
  if (!merchant) return sendError(res, 'not_found', 'Merchant not found.');

  if (action !== 'list') {
    const order = await deps.repo.getOrder(orderId);
    if (!order) return sendError(res, 'not_found', 'Order not found.');
    if (order.merchantId !== merchant.id) {
      return sendError(res, 'not_found', 'Order not found.', 'order belongs to another merchant');
    }
  }

  const nowMs = deps.clock.nowMs();
  // Cheap housekeeping on the one endpoint that writes nonces, so the table does not grow
  // without bound. Best effort: a failure here must not stop a merchant working.
  void deps.repo.purgeExpiredMerchantNonces(Math.floor(nowMs / 1000)).catch(() => 0);

  const issued = await issueAndRecordMerchantChallenge(deps, {
    merchant,
    action,
    orderId,
    nowMs,
  });
  if (!issued.ok) {
    return sendError(res, 'conflict', 'That request was already signed. Try again.', issued.detail);
  }

  return sendJson(res, 201, {
    challenge: {
      message: issued.issued.message,
      expiresAtSec: issued.issued.expiresAtSec,
      merchantAddress: merchant.address,
      action,
      orderId,
      singleUse: action !== 'list',
    },
    required: merchantAuthRequired(),
    explain:
      'Signing this proves you control the merchant wallet. It moves no NIM and costs no fee.',
  });
});
