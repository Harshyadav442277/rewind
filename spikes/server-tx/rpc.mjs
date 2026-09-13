// Minimal JSON-RPC 2.0 client for the public Nimiq mainnet node.
//
// Envelope confirmed live (2026-09-12 and 2026-09-13):
//   {"jsonrpc":"2.0","result":{"data":<value>,"metadata":<obj|null>},"id":N}
// Errors:
//   {"jsonrpc":"2.0","error":{"code":N,"message":"...","data":"..."},"id":N}
// Source for the method signatures: nimiq/core-rs-albatross rpc-interface crate
//   consensus.rs  send_raw_transaction(&self, raw_tx: String) -> RPCResult<Blake2bHash, (), _>
//   mempool.rs    push_transaction(&self, raw_tx: String)     -> RPCResult<Blake2bHash, (), _>
//   mempool.rs    get_min_fee_per_byte(&self)                 -> RPCResult<f64, (), _>
//   blockchain.rs get_transaction_by_hash(&self, hash: Blake2bHash) -> RPCResult<ExecutedTransaction, (), _>
//   blockchain.rs get_account_by_address(&self, address: Address)   -> RPCResult<Account, BlockchainState, _>

export const DEFAULT_RPC = process.env.REWIND_RPC_URL || 'https://rpc.nimiqwatch.com';

export class RpcError extends Error {
  constructor(method, code, message, data) {
    super(`${method}: [${code}] ${message}${data ? ' — ' + data : ''}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
    this.rpcMessage = message;
    this.rpcData = data;
  }
}

let nextId = 0;

/** Returns { data, metadata } from the wrapped result. Throws RpcError on a JSON-RPC error. */
export async function rpcRaw(method, params = [], url = DEFAULT_RPC) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
  }
  if (body.error) {
    throw new RpcError(method, body.error.code, body.error.message, body.error.data);
  }
  if (!body.result || !('data' in body.result)) {
    throw new Error(`${method}: unexpected envelope ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.result; // { data, metadata }
}

/** Returns just result.data. */
export async function rpc(method, params = [], url = DEFAULT_RPC) {
  return (await rpcRaw(method, params, url)).data;
}

export const getBlockNumber = (url) => rpc('getBlockNumber', [], url);
export const getMinFeePerByte = (url) => rpc('getMinFeePerByte', [], url);
export const getAccountByAddress = (address, url) => rpcRaw('getAccountByAddress', [address], url);
export const getTransactionByHash = (hash, url) => rpc('getTransactionByHash', [hash], url);
export const sendRawTransaction = (rawHex, url) => rpc('sendRawTransaction', [rawHex], url);
export const pushTransaction = (rawHex, url) => rpc('pushTransaction', [rawHex], url);

/**
 * getTransactionByHash answers with JSON-RPC -32603 "Transaction not found: <hash>" while the
 * transaction is unknown to the history index. Confirmed live 2026-09-13T07:45:08Z.
 */
export function isNotFound(err) {
  return err instanceof RpcError && /Transaction not found/i.test(String(err.rpcData ?? err.rpcMessage));
}
