import { getDeps } from '../_lib/deps.js';
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
} from '../_lib/http.js';
import { DEFAULT_LIMITS, rateLimit } from '../_lib/ratelimit.js';
import { authenticateMerchant, merchantAuthRequired } from '../_lib/merchant-auth.js';
import { isMerchantAction, LIST_ORDER_SENTINEL } from '../../server/domain/merchant-auth.js';
import { challengeView, executionView, orderView } from '../_lib/views.js';
import {
  executeTreasuryRefund,
  recordMerchantRefundBroadcast,
  rejectRefund,
  reserveRefund,
  settleRefund,
} from '../../server/domain/refund-reservation.js';

/**
 * GET  /api/merchant/refunds                       list refund requests
 * POST /api/merchant/refunds  { orderId, action }  approve | reject | record-tx
 *
 * BOTH verbs are authenticated the same way: the caller presents `message`, `publicKey` and
 * `signature` for a merchant challenge issued by POST /api/merchant/challenge, and the
 * address recovered from that signature must be the merchant's own.
 *
 *   POST carries them in the JSON body and the challenge is bound to the action and the
 *   order. Its nonce is consumed, so the same signed text cannot be replayed (gap S3).
 *
 *   GET carries them in headers, because a GET has no body: the base64 of the challenge text
 *   in `x-rewind-merchant-challenge`, and the hex public key and signature in
 *   `x-rewind-merchant-publickey` / `x-rewind-merchant-signature`. The challenge action is
 *   `list`, it is bound to no order, and it is NOT consumed — a board polling every few
 *   seconds must not need a wallet dialog every few seconds. The answer is then SCOPED to the
 *   merchant named in that challenge: a merchant sees their own orders and nobody else's.
 *   That closes the second half of gap S1.
 *
 * In the fake-chain developer loop (`merchantAuthRequired()` false) an unsigned GET is still
 * answered, unscoped, so `npm run dev` walks the flow with no wallet. That default inverts
 * the moment REWIND_CHAIN=rpc or a production deployment is configured.
 */

const LIST_STATES = [
  'REFUND_REQUESTED',
  'REFUND_APPROVED',
  'REFUND_BROADCAST',
  'REFUNDED',
  'REFUND_FAILED',
  'REJECTED',
];

function headerValue(req: ApiRequest, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The challenge text travels base64 encoded, because header values cannot carry newlines. */
function decodeChallengeHeader(value: string): string | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    return text.length > 0 && text.length <= 1024 ? text : null;
  } catch {
    return null;
  }
}

export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  const deps = getDeps();

  if (req.method === 'GET') {
    const limit = rateLimit(`merchant:list:${clientIp(req)}`, DEFAULT_LIMITS.read);
    if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');

    const encoded = headerValue(req, 'x-rewind-merchant-challenge');
    const publicKey = headerValue(req, 'x-rewind-merchant-publickey');
    const signature = headerValue(req, 'x-rewind-merchant-signature');
    const authRequired = merchantAuthRequired();

    let scopedMerchantId: string | null = null;

    if (encoded || publicKey || signature || authRequired) {
      if (!encoded || !publicKey || !signature) {
        return sendError(
          res,
          'bad_request',
          'Sign in with your merchant wallet to see refund requests.',
          'x-rewind-merchant-challenge, -publickey and -signature are all required',
        );
      }
      const message = decodeChallengeHeader(encoded);
      if (message === null) {
        return sendError(
          res,
          'bad_request',
          'That merchant sign-in could not be read.',
          'x-rewind-merchant-challenge must be base64 of the challenge text',
        );
      }
      // Who the text claims to be is read first, but it proves nothing: the merchant record
      // comes from the repository and the address is compared with the recovered signer.
      const claimed = /^merchant=(.+)$/m.exec(message);
      const merchant = claimed?.[1] ? await deps.repo.getMerchant(claimed[1]) : null;
      if (!merchant) {
        return sendError(res, 'bad_request', 'That merchant sign-in was not accepted.', 'unknown merchant');
      }
      const auth = await authenticateMerchant(deps, merchant, 'list', LIST_ORDER_SENTINEL, {
        message,
        publicKey,
        signature,
      });
      if (!auth.ok) {
        return sendError(
          res,
          'bad_request',
          'That merchant sign-in was not accepted.',
          `${auth.reason}: ${auth.detail}`,
        );
      }
      scopedMerchantId = merchant.id;
    }

    const orders = await deps.repo.listOrders(50);
    const interesting = orders.filter(
      (o) =>
        LIST_STATES.includes(o.state) &&
        (scopedMerchantId === null || o.merchantId === scopedMerchantId),
    );
    // Polling drives the state machine here too, so a merchant watching this list sees a
    // refund reach REFUNDED without having to open the order. Every step is idempotent.
    for (const order of interesting) {
      if (order.state === 'REFUND_APPROVED' || order.state === 'REFUND_BROADCAST') {
        await settleRefund(deps, order.id);
      }
    }

    const rows = await Promise.all(
      interesting.map(async (order) => {
        const [fresh, challenges, execution] = await Promise.all([
          deps.repo.getOrder(order.id),
          deps.repo.listChallengesForOrder(order.id),
          deps.repo.getRefundExecutionByOrder(order.id),
        ]);
        const current = fresh ?? order;
        const signed = challenges.find((c) => c.consumedAt !== null) ?? null;
        return {
          order: orderView(current),
          signedRequest: signed ? challengeView(signed) : null,
          execution: execution ? executionView(execution) : null,
        };
      }),
    );
    return sendJson(res, 200, {
      requests: rows,
      scopedToMerchantId: scopedMerchantId,
      authenticated: scopedMerchantId !== null,
    });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const limit = rateLimit(`merchant:act:${clientIp(req)}`, DEFAULT_LIMITS.write);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');

  const body = readJsonBody(req);
  const orderId = requireString(body, 'orderId', { maxLength: 64 });
  const action = requireString(body, 'action', { maxLength: 32 });
  if (!isMerchantAction(action) || action === 'list') {
    return sendError(res, 'bad_request', 'Unknown action.', 'use approve, reject or record-tx');
  }

  // Authenticate before touching any state, and before revealing whether the order exists.
  if (merchantAuthRequired()) {
    const order = await deps.repo.getOrder(orderId);
    const merchant = order ? await deps.repo.getMerchant(order.merchantId) : null;
    if (!order || !merchant) {
      return sendError(res, 'not_found', 'Order not found.');
    }
    const auth = await authenticateMerchant(deps, merchant, action, orderId, {
      message: body.message,
      publicKey: body.publicKey,
      signature: body.signature,
    });
    if (!auth.ok) {
      return sendError(
        res,
        'bad_request',
        'That request was not signed by the merchant wallet.',
        `${auth.reason}: ${auth.detail}`,
      );
    }
  }

  if (action === 'reject') {
    const rejected = await rejectRefund(deps, orderId);
    if (!rejected) {
      return sendError(
        res,
        'conflict',
        'This refund can no longer be rejected.',
        'either it is not awaiting approval, or it is already reserved',
      );
    }
    return sendJson(res, 200, { order: orderView(rejected) });
  }

  if (action === 'record-tx') {
    // The merchant sent the refund from their own wallet and is reporting the hash.
    const txHash = requireString(body, 'txHash', { maxLength: 128 });
    const recorded = await recordMerchantRefundBroadcast(deps, orderId, txHash);
    if (!recorded.ok) {
      return sendError(res, 'conflict', 'That refund transaction could not be recorded.', `${recorded.reason}: ${recorded.detail}`);
    }
    const settled = await settleRefund(deps, orderId);
    return sendJson(res, 200, {
      order: settled.order ? orderView(settled.order) : null,
      execution: settled.execution ? executionView(settled.execution) : null,
      status: settled.status,
      note: settled.message ?? null,
    });
  }

  const reserved = await reserveRefund(deps, orderId);
  if (!reserved.ok) {
    if (reserved.reason === 'not_found') return sendError(res, 'not_found', 'Order not found.');
    if (reserved.reason === 'cap_denied') {
      return sendError(res, 'conflict', reserved.message, reserved.detail);
    }
    return sendError(res, 'conflict', reserved.message, `${reserved.reason}: ${reserved.detail}`);
  }

  // Demo Store only: the capped treasury sends it now. A real merchant signs in their wallet
  // and then calls back with action=record-tx.
  let status = 'reserved';
  if (reserved.execution.source === 'DEMO_TREASURY' && deps.broadcaster && deps.txBuilder) {
    const sent = await executeTreasuryRefund(deps, orderId);
    status = sent.ok ? sent.status : `broadcast_error:${sent.reason}`;
  }
  const settled = await settleRefund(deps, orderId);

  return sendJson(res, 200, {
    order: settled.order ? orderView(settled.order) : orderView(reserved.order),
    execution: settled.execution
      ? executionView(settled.execution)
      : executionView(reserved.execution),
    alreadyReserved: reserved.alreadyReserved,
    status,
    settleStatus: settled.status,
    note: settled.message ?? null,
  });
});
