import { getDeps } from '../_lib/deps.js';
import {
  clientIp,
  methodNotAllowed,
  queryParam,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../_lib/http.js';
import { DEFAULT_LIMITS, rateLimit } from '../_lib/ratelimit.js';

/**
 * GET /api/merchants/:id
 *
 * What a payment link shows before the buyer pays: the shop name and the address the NIM goes
 * to. Public, because the link itself is shared publicly.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const id = queryParam(req, 'id');
  if (!id) return sendError(res, 'bad_request', 'Missing merchant id.');

  const limit = rateLimit(`merchant:get:${clientIp(req)}`, DEFAULT_LIMITS.read);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');

  const merchant = await getDeps().repo.getMerchant(id);
  if (!merchant) return sendError(res, 'not_found', 'This payment link does not belong to a Rewind merchant.');

  const { name, address, allowTreasuryRefund } = merchant;
  return sendJson(res, 200, { merchant: { id: merchant.id, name, address, isDemoStore: allowTreasuryRefund } });
});
