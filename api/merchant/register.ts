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
import { registerMerchant } from '../../server/domain/merchant-registration.js';

/**
 * POST /api/merchant/register   { message, publicKey, signature }
 *
 * Creates, or renames, the merchant of the wallet that signed `message`
 * (`REWIND_MERCHANT_REGISTER_V1` / `name=` / `issued=`). The merchant's address is the one the
 * signature recovers; the body cannot name an address. The response carries the merchant id
 * that payment links use.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const limit = rateLimit(`merchant:register:${clientIp(req)}`, DEFAULT_LIMITS.signature);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Wait a moment.');

  const body = readJsonBody(req);
  const message = requireString(body, 'message', { maxLength: 200 });
  const publicKey = requireString(body, 'publicKey', { maxLength: 200 });
  const signature = requireString(body, 'signature', { maxLength: 400 });

  const result = await registerMerchant(getDeps(), { message, publicKey, signature });
  if (!result.ok) return sendError(res, 'bad_request', result.message, `${result.reason}: ${result.detail}`);

  const { id, name, address } = result.merchant;
  return sendJson(res, 201, { merchant: { id, name, address } });
});
