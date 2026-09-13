import { getDeps } from '../_lib/deps';
import {
  clientIp,
  methodNotAllowed,
  queryParam,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../_lib/http';
import { DEFAULT_LIMITS, rateLimit } from '../_lib/ratelimit';
import { challengeView, executionView, orderView } from '../_lib/views';
import { expireOrderIfStale, verifyOrderPayment } from '../../server/domain/order-service';
import { executeTreasuryRefund, settleRefund } from '../../server/domain/refund-reservation';

/**
 * GET /api/orders/:id
 *
 * Polling drives the state machine. A serverless deployment has nowhere to run a background
 * worker cheaply, so each status read does the small amount of work the order is waiting on:
 * check a payment, send an approved treasury refund, settle a broadcast one. Every one of
 * those operations is idempotent, which is what makes it safe to hang them off a poll.
 *
 * `chainFetchedAtMs` is returned so the UI can say when the chain was last actually read,
 * rather than implying it is live. Reads are cached; see CachingChainReader.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const id = queryParam(req, 'id');
  if (!id) return sendError(res, 'bad_request', 'Missing order id.');

  const limit = rateLimit(`order:get:${clientIp(req)}`, DEFAULT_LIMITS.read);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');

  const deps = getDeps();
  let order = await deps.repo.getOrder(id);
  if (!order) return sendError(res, 'not_found', 'Order not found.');

  let chainFetchedAtMs: number | null = null;
  let note: string | null = null;

  if (order.state === 'CREATED' || order.state === 'PAYMENT_PENDING') {
    order = (await expireOrderIfStale(deps, id)) ?? order;
  }

  if (order.state === 'PAYMENT_PENDING') {
    const check = await verifyOrderPayment(deps, id);
    if (check.status === 'paid' || check.status === 'waiting' || check.status === 'rejected') {
      chainFetchedAtMs = check.chainFetchedAtMs;
      order = check.order;
      if (check.status !== 'paid') note = check.message;
    }
  }

  if (order.state === 'REFUND_APPROVED' || order.state === 'REFUND_BROADCAST') {
    const execution = await deps.repo.getRefundExecutionByOrder(id);
    if (execution && execution.source === 'DEMO_TREASURY' && execution.confirmedAt === null) {
      // Idempotent: re-checks the chain before it would ever re-send.
      await executeTreasuryRefund(deps, id);
    }
    const settled = await settleRefund(deps, id);
    if (settled.chainFetchedAtMs !== undefined) chainFetchedAtMs = settled.chainFetchedAtMs;
    if (settled.message) note = settled.message;
    order = settled.order ?? order;
  }

  const [challenges, execution] = await Promise.all([
    deps.repo.listChallengesForOrder(id),
    deps.repo.getRefundExecutionByOrder(id),
  ]);
  const latest = challenges[0] ?? null;
  const signed = challenges.find((c) => c.consumedAt !== null) ?? null;

  return sendJson(res, 200, {
    order: orderView(order),
    challenge: latest ? challengeView(latest) : null,
    signedRequest: signed ? challengeView(signed) : null,
    execution: execution ? executionView(execution) : null,
    chainFetchedAtMs,
    note,
    serverTimeMs: deps.clock.nowMs(),
  });
});
