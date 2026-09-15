import { getDeps } from '../../_lib/deps.js';
import {
  clientIp,
  methodNotAllowed,
  queryParam,
  readJsonBody,
  requireString,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../../_lib/http.js';
import { DEFAULT_LIMITS, rateLimit } from '../../_lib/ratelimit.js';
import { challengeView, orderView } from '../../_lib/views.js';
import { executionView } from '../../_lib/views.js';
import {
  executeTreasuryRefund,
  reserveRefund,
  settleRefund,
  submitSignedRefundRequest,
} from '../../../server/domain/refund-reservation.js';

/**
 * POST /api/orders/:id/refund   { message, publicKey, signature }
 *
 * Accepts the signed refund request. Refuses, in this order: unreadable text, a nonce Rewind
 * never issued, text that differs by a byte from what was issued, a challenge that does not
 * match the order, an expired challenge, an unverifiable signature, a signature from a wallet
 * other than the refund destination read from the chain (the payer, or the wallet that funded
 * the payer's HTLC), and a nonce that has already been used.
 *
 * Success moves the order to REFUND_REQUESTED. For every ordinary merchant that is where it
 * stops: a person approves in their own wallet, and only then is a refund reserved and sent.
 *
 * The Demo Store is the exception, and it is a published one — the store screen says so in
 * as many words. The Demo Store IS the merchant here, its policy is to approve a valid
 * refund request for its own item, and that policy is what lets one person walk the whole
 * flow without a second human. It is not an authentication hole: the buyer still had to
 * prove they own the wallet the refund goes to, the amount still has to pass the treasury caps, and the
 * refund is still only called REFUNDED from a verified chain record.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const id = queryParam(req, 'id');
  if (!id) return sendError(res, 'bad_request', 'Missing order id.');

  const limit = rateLimit(`refund:${clientIp(req)}`, DEFAULT_LIMITS.signature);
  if (!limit.allowed) {
    return sendError(res, 'rate_limited', 'Too many refund attempts. Wait a moment.');
  }

  const body = readJsonBody(req);
  const message = requireString(body, 'message', { maxLength: 1024 });
  const publicKey = requireString(body, 'publicKey', { maxLength: 256 });
  const signature = requireString(body, 'signature', { maxLength: 512 });

  const deps = getDeps();
  const result = await submitSignedRefundRequest(deps, { orderId: id, message, publicKey, signature });

  if (!result.ok) {
    if (result.reason === 'not_found') return sendError(res, 'not_found', 'Order not found.');
    if (result.reason === 'nonce_already_used' || result.reason === 'wrong_state') {
      return sendError(res, 'conflict', result.message, result.detail);
    }
    return sendError(res, 'bad_request', result.message, `${result.reason}: ${result.detail}`);
  }

  // The Demo Store's published policy, applied. Everything below is idempotent, and a
  // failure at any step leaves the order in REFUND_REQUESTED for a human to approve.
  const autoApprove =
    deps.config.demoAutoApprove && result.order.refundSource === 'DEMO_TREASURY';
  if (!autoApprove) {
    return sendJson(res, 200, {
      order: orderView(result.order),
      signedRequest: challengeView(result.challenge),
      execution: null,
      autoApproved: false,
      note: 'Verified. A merchant now has to approve this refund before any NIM moves.',
    });
  }

  const reserved = await reserveRefund(deps, id);
  if (!reserved.ok) {
    // A cap denial is the honest answer, not a hidden failure: the order stays where a
    // person can still approve it, and the buyer is told why nothing was sent.
    return sendJson(res, 200, {
      order: orderView(result.order),
      signedRequest: challengeView(result.challenge),
      execution: null,
      autoApproved: false,
      note: `Verified, but the Demo Store could not approve it automatically: ${reserved.message}`,
    });
  }
  if (deps.broadcaster && deps.txBuilder) await executeTreasuryRefund(deps, id);
  const settled = await settleRefund(deps, id);

  return sendJson(res, 200, {
    order: orderView(settled.order ?? reserved.order),
    signedRequest: challengeView(result.challenge),
    execution: settled.execution
      ? executionView(settled.execution)
      : executionView(reserved.execution),
    autoApproved: true,
    note:
      settled.message ??
      'Verified and approved by the Demo Store. The refund is on its way; this page keeps checking the chain.',
  });
});
