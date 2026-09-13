import { DEMO_MERCHANT, getDeps, IS_FAKE_CHAIN, IS_LIGHT_CLIENT, NETWORK_NAME, REPO_MODE } from './_lib/deps';
import {
  clientIp,
  methodNotAllowed,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http';
import { DEFAULT_LIMITS, rateLimit } from './_lib/ratelimit';
import { explorerBase } from './_lib/views';
import { formatLuna } from '../server/domain/nimiq';
import { ChainUnavailableError } from '../server/domain/ports';

/**
 * GET /api/health
 *
 * What the Demo Store screen needs before it offers to take money:
 *
 *   - can the chain be read at all, at what height, and when was that actually read,
 *   - what the Demo Store treasury address is and what it holds,
 *   - the floor below which the demo stops selling,
 *   - and the one boolean the screen acts on, `demoPaused`.
 *
 * It answers 200 even when the node is unreachable. "We could not read the chain" is a state
 * the store has to render, not an error that hides the rest of the answer — so
 * ChainUnavailableError is caught here rather than becoming the 503 that every other endpoint
 * turns it into.
 *
 * The balance read is `getAccountByAddress`, which is read-only and needs no key. A balance is
 * never evidence that a transfer happened; nothing in the money path reads this endpoint.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const limit = rateLimit(`health:${clientIp(req)}`, DEFAULT_LIMITS.read);
  if (!limit.allowed) return sendError(res, 'rate_limited', 'Too many requests. Slow down.');

  const deps = getDeps();
  const treasuryAddress = DEMO_MERCHANT.address;
  const floorLuna = deps.config.treasuryFloorLuna;

  let blockNumber: number | null = null;
  let balanceLuna: number | null = null;
  let checkedAtMs: number | null = null;
  let chainError: string | null = null;

  try {
    const height = await deps.chain.getBlockNumber();
    blockNumber = height.data;
    checkedAtMs = height.fetchedAtMs;
    const account = await deps.chain.getAccountByAddress(treasuryAddress);
    balanceLuna = account.data.balance;
    // The older of the two reads, so "checked at" never claims to be fresher than its data.
    checkedAtMs = Math.min(checkedAtMs, account.fetchedAtMs);
  } catch (err) {
    if (!(err instanceof ChainUnavailableError)) throw err;
    chainError = err.message;
  }

  const reachable = chainError === null && blockNumber !== null;
  // Paused when the treasury is known to be short, AND when the chain cannot be read at all:
  // a store that cannot check whether it can refund must not take the payment.
  const demoPaused = !reachable || balanceLuna === null || balanceLuna < floorLuna;

  return sendJson(res, 200, {
    chain: {
      reachable,
      mode: IS_FAKE_CHAIN ? 'fake' : IS_LIGHT_CLIENT ? 'lightclient' : 'rpc',
      // The frontend has no way of knowing which chain it is looking at otherwise, and
      // "testnet" is the difference between a rehearsal and real money. Every explorer link in
      // a view is already built server-side from this same base.
      network: NETWORK_NAME,
      explorerBase: explorerBase(),
      networkId: String(deps.config.networkId),
      blockNumber,
      checkedAtMs,
      error: chainError,
    },
    treasury: {
      address: treasuryAddress,
      balanceLuna,
      balanceLabel: balanceLuna === null ? null : formatLuna(balanceLuna),
      floorLuna,
      floorLabel: formatLuna(floorLuna),
    },
    demoPaused,
    demoPausedReason: !demoPaused
      ? null
      : !reachable
        ? 'The Nimiq node could not be read, so the Demo Store cannot confirm it is able to refund.'
        : 'The Demo Store treasury is below its floor and is not taking payments.',
    repo: REPO_MODE,
    serverTimeMs: deps.clock.nowMs(),
  });
});
