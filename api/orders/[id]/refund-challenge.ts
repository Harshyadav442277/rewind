import { getDeps } from '../../_lib/deps';
import {
  clientIp,
  methodNotAllowed,
  queryParam,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../../_lib/http';
import { DEFAULT_LIMITS, rateLimit } from '../../_lib/ratelimit';
import { challengeView, orderView } from '../../_lib/views';
import { issueRefundChallenge } from '../../../server/domain/refund-reservation';

/**
 * POST /api/orders/:id/refund-challenge
 *
 * Issues the one-time text the buyer signs in Nimiq Pay. Issuing changes no order state; the
 * order stays PAID until a valid signature arrives. Re-requesting is allowed and produces a
 * fresh nonce, because a buyer who dismissed the wallet dialog needs to try again.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const id = queryParam(req, 'id');
  if (!id) return sendError(res, 'bad_request', 'Missing order id.');

  const limit = rateLimit(`challenge:${clientIp(req)}`, DEFAULT_LIMITS.signature);
  if (!limit.allowed) {
    return sendError(res, 'rate_limited', 'Too many refund requests. Wait a moment.');
  }

  const deps = getDeps();
  const result = await issueRefundChallenge(deps, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return sendError(res, 'not_found', 'Order not found.');
    if (result.reason === 'already_requested') {
      return sendError(
        res,
        'conflict',
        'A refund has already been requested for this order.',
        result.detail,
      );
    }
    return sendError(
      res,
      'conflict',
      'This order has no verified payment to refund yet.',
      result.detail,
    );
  }

  const order = await deps.repo.getOrder(id);
  return sendJson(res, 201, {
    challenge: challengeView(result.challenge),
    order: order ? orderView(order) : null,
    // Shown next to the Sign button so the buyer knows what they are approving.
    explain:
      'Signing this proves you control the wallet that paid. It moves no NIM and costs no fee.',
  });
});
