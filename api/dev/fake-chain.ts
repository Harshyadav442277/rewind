import { getDeps, getFakeChain, getFakeSignatureVerifier, IS_FAKE_CHAIN } from '../_lib/deps';
import {
  methodNotAllowed,
  readJsonBody,
  requireString,
  sendError,
  sendJson,
  withErrors,
  type ApiRequest,
  type ApiResponse,
} from '../_lib/http';
import { fakeKeyFor, fakeSign } from '../../server/domain/fakes';
import { normalizeAddress } from '../../server/domain/nimiq';

/**
 * DEVELOPMENT ONLY. The harness behind the FakeWallet.
 *
 * It stands in for the two things a browser cannot do offline: put a transaction on a chain,
 * and sign with a Nimiq key. It refuses to run whenever the real chain is configured or the
 * deployment is production, so it cannot become a way to fabricate a payment.
 *
 * Nothing here proves anything about the real wallet, the real signature scheme or the real
 * chain. It exists so the whole flow can be walked end to end on a laptop.
 */
export default withErrors(async (req: ApiRequest, res: ApiResponse) => {
  if (!IS_FAKE_CHAIN || process.env.VERCEL_ENV === 'production') {
    return sendError(res, 'not_found', 'Not found.');
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const deps = getDeps();
  const chain = getFakeChain();
  if (!chain) return sendError(res, 'unavailable', 'The fake chain is not running.');

  const body = readJsonBody(req);
  const action = requireString(body, 'action', { maxLength: 32 });

  if (action === 'send') {
    const from = normalizeAddress(requireString(body, 'from', { maxLength: 64 }));
    const to = normalizeAddress(requireString(body, 'to', { maxLength: 64 }));
    if (from === null || to === null) {
      return sendError(res, 'bad_request', 'Those are not Nimiq addresses.');
    }
    if (from === to) {
      return sendError(res, 'bad_request', 'Sender and recipient must differ.');
    }
    const valueLuna = Number(body.valueLuna);
    if (!Number.isSafeInteger(valueLuna) || valueLuna <= 0) {
      return sendError(res, 'bad_request', 'valueLuna must be a positive integer.');
    }
    const data = typeof body.data === 'string' ? body.data : undefined;

    const tx = chain.include({
      from,
      to,
      value: valueLuna,
      data,
      networkId: String(deps.config.networkId),
      timestamp: deps.clock.nowMs(),
    });
    // Mine enough blocks that the transaction immediately satisfies minConfirmations,
    // so a developer is not waiting for an imaginary chain.
    chain.advanceHeight(deps.config.minConfirmations);
    return sendJson(res, 201, { hash: tx.hash, blockNumber: tx.blockNumber, height: chain.height });
  }

  if (action === 'sign') {
    const verifier = getFakeSignatureVerifier();
    if (!verifier) return sendError(res, 'unavailable', 'The fake signature verifier is not running.');
    const address = normalizeAddress(requireString(body, 'address', { maxLength: 64 }));
    if (address === null) return sendError(res, 'bad_request', 'That is not a Nimiq address.');
    const message = requireString(body, 'message', { maxLength: 1024 });

    const key = verifier.register(fakeKeyFor(address));
    return sendJson(res, 200, {
      publicKey: key.publicKey,
      signature: fakeSign(key, message),
      address: key.address,
    });
  }

  if (action === 'mine') {
    const blocks = Number(body.blocks ?? 1);
    chain.advanceHeight(Number.isSafeInteger(blocks) && blocks > 0 ? blocks : 1);
    return sendJson(res, 200, { height: chain.height });
  }

  return sendError(res, 'bad_request', 'Unknown action.', 'use send, sign or mine');
});
