/**
 * Wiring. One place decides which repository, which chain and which signer the API uses.
 *
 * Defaults are the offline ones: in-memory repository, fake chain, fake signature verifier,
 * fake treasury. That is what makes `npm run dev` walk the whole flow in a browser with no
 * database, no wallet and no node. Nothing here is a deployment configuration — a deployment
 * must set REWIND_REPO=postgres and REWIND_CHAIN=rpc, and both of those paths are UNTESTED.
 */

import { InMemoryRepository } from '../../server/db/memory';
import { PostgresRepository } from '../../server/db/postgres';
import type { Repository } from '../../server/db/repository';
import { CachingChainReader } from '../../server/domain/chain-cache';
import { DEFAULT_CONFIG, type DomainConfig, type DomainDeps } from '../../server/domain/deps';
import { DEFAULT_TREASURY_CAPS } from '../../server/domain/demo-treasury';
import {
  FakeChain,
  FakeChainReader,
  FakeRefundTxBuilder,
  FakeSignatureVerifier,
  FakeTxBroadcaster,
  cryptoRandom,
  systemClock,
} from '../../server/domain/fakes';
import type {
  ChainReader,
  PreparedRefundTx,
  RefundTxBuilder,
  RefundTxRequest,
  SignatureVerifier,
  TxBroadcaster,
} from '../../server/domain/ports';
import { RpcChainReader } from '../../server/chain/rpc-chain-reader';
import type { Merchant } from '../../server/domain/types';

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback;

export const REPO_MODE = env('REWIND_REPO', 'memory');
export const CHAIN_MODE = env('REWIND_CHAIN', 'fake');
export const IS_FAKE_CHAIN = CHAIN_MODE !== 'rpc';

/**
 * Which signature verifier to use. The real one is Ed25519 over Nimiq's signed-message
 * preimage (`server/crypto/nimiq-signature-verifier.ts`); the fake accepts a digest a real
 * verifier would reject and exists only so the fake wallet can drive the flow locally.
 *
 * `REWIND_VERIFIER=real|fake` decides it outright. Otherwise the real one is used in
 * production and whenever the real chain is configured, and never silently in between.
 */
export function useRealSignatureVerifier(e: NodeJS.ProcessEnv = process.env): boolean {
  const mode = e.REWIND_VERIFIER;
  if (mode === 'real') return true;
  if (mode === 'fake') {
    if (e.VERCEL_ENV === 'production' || e.NODE_ENV === 'production') {
      throw new Error('REWIND_VERIFIER=fake is refused in production.');
    }
    return false;
  }
  return (
    e.NODE_ENV === 'production' || e.VERCEL_ENV === 'production' || e.REWIND_CHAIN === 'rpc'
  );
}

/**
 * `@nimiq/core` loads a WASM module on import, so the crypto adapters are pulled in only when
 * they are actually going to be used. The fake-chain developer loop never loads them.
 */
class LazyNimiqSignatureVerifier implements SignatureVerifier {
  private impl: SignatureVerifier | null = null;

  async verify(message: string, publicKeyHex: string, signatureHex: string) {
    if (!this.impl) {
      const { NimiqSignatureVerifier } = await import('../../server/crypto/nimiq-signature-verifier');
      this.impl = new NimiqSignatureVerifier();
    }
    return this.impl.verify(message, publicKeyHex, signatureHex);
  }
}

class LazyTreasuryTxBuilder implements RefundTxBuilder {
  private impl: RefundTxBuilder | null = null;

  async prepare(request: RefundTxRequest): Promise<PreparedRefundTx> {
    if (!this.impl) {
      const { TreasuryTxBuilder } = await import('../../server/chain/treasury-broadcaster');
      this.impl = TreasuryTxBuilder.fromEnv();
    }
    return this.impl.prepare(request);
  }
}

class LazyTxBroadcaster implements TxBroadcaster {
  private impl: TxBroadcaster | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly authorization: string | undefined,
  ) {}

  async broadcast(serializedTx: string): Promise<{ hash: string }> {
    if (!this.impl) {
      const { RpcTxBroadcaster } = await import('../../server/chain/treasury-broadcaster');
      this.impl = new RpcTxBroadcaster({
        endpoint: this.endpoint,
        authorization: this.authorization,
      });
    }
    return this.impl.broadcast(serializedTx);
  }
}

export const DEMO_MERCHANT_ID = 'demo-store';

/**
 * Placeholder addresses. They are shape-valid so the domain accepts them, and they are
 * obviously not wallets. No key exists for either, and none is in this repository.
 */
const PLACEHOLDER_TREASURY = 'NQ79 TR3A 5URY 0000 0000 0000 0000 0000 0001';

export const DEMO_MERCHANT: Merchant = {
  id: DEMO_MERCHANT_ID,
  name: 'Rewind Demo Store',
  address: env('REWIND_TREASURY_ADDRESS', PLACEHOLDER_TREASURY),
  allowTreasuryRefund: true,
};

/** A second, non-treasury merchant so the merchant-signs-their-own-refund path is reachable. */
export const SAMPLE_MERCHANT: Merchant = {
  id: 'sample-merchant',
  name: 'Sample Merchant (signs their own refunds)',
  address: env('REWIND_SAMPLE_MERCHANT_ADDRESS', 'NQ17 5AMP 1E00 0000 0000 0000 0000 0000 0002'),
  allowTreasuryRefund: false,
};

function buildConfig(): DomainConfig {
  const int = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    ...DEFAULT_CONFIG,
    networkId: env('REWIND_NETWORK_ID', String(DEFAULT_CONFIG.networkId)),
    minConfirmations: int('REWIND_MIN_CONFIRMATIONS', DEFAULT_CONFIG.minConfirmations),
    treasuryFloorLuna: int('REWIND_TREASURY_FLOOR_LUNA', DEFAULT_CONFIG.treasuryFloorLuna),
    demoAutoApprove: env('REWIND_DEMO_AUTO_APPROVE', 'on') !== 'off',
    refundFeeLuna: int('REWIND_REFUND_FEE_LUNA', DEFAULT_CONFIG.refundFeeLuna),
    demoMerchantId: DEMO_MERCHANT_ID,
    treasuryCaps: {
      ...DEFAULT_TREASURY_CAPS,
      maxLunaPerRefund: int('REWIND_CAP_PER_REFUND_LUNA', DEFAULT_TREASURY_CAPS.maxLunaPerRefund),
      maxLunaTotal: int('REWIND_CAP_TOTAL_LUNA', DEFAULT_TREASURY_CAPS.maxLunaTotal),
    },
  };
}

// --- module-scope singletons (one per function instance) --------------------

let repository: Repository | null = null;
let chainReader: ChainReader | null = null;
let signatureVerifier: SignatureVerifier | null = null;
let txBuilder: RefundTxBuilder | null = null;
let broadcaster: TxBroadcaster | null = null;
let fakeChain: FakeChain | null = null;
let deps: DomainDeps | null = null;

/** The dev-only fake chain, so the dev endpoints can include transactions in it. */
export function getFakeChain(): FakeChain | null {
  return fakeChain;
}

export function getFakeSignatureVerifier(): FakeSignatureVerifier | null {
  return signatureVerifier instanceof FakeSignatureVerifier ? signatureVerifier : null;
}

function buildRepository(config: DomainConfig): Repository {
  if (REPO_MODE === 'postgres') {
    const url = env('DATABASE_URL');
    if (!url) throw new Error('REWIND_REPO=postgres but DATABASE_URL is not set');
    return new PostgresRepository(url);
  }
  if (process.env.VERCEL_ENV === 'production') {
    // Per-instance memory in a serverless deployment loses orders between requests and is
    // worse than no persistence, because it looks like it works.
    throw new Error('REWIND_REPO=memory is refused in production. Set REWIND_REPO=postgres.');
  }
  void config;
  return new InMemoryRepository([DEMO_MERCHANT, SAMPLE_MERCHANT]);
}

export function getDeps(): DomainDeps {
  if (deps) return deps;
  const config = buildConfig();
  repository = buildRepository(config);

  if (IS_FAKE_CHAIN) {
    fakeChain = new FakeChain();
    fakeChain.networkId = String(config.networkId);
    // One block per read, so confirmations accumulate while a developer clicks through
    // instead of the demo stalling at one confirmation for ever.
    chainReader = new CachingChainReader(new FakeChainReader(fakeChain, systemClock, 1), systemClock, {
      // Short TTLs locally: a developer clicking through should not wait on a cache.
      txTtlMs: 1_000,
      missTtlMs: 250,
      blockNumberTtlMs: 250,
    });
    signatureVerifier = new FakeSignatureVerifier();
    const builder = new FakeRefundTxBuilder(DEMO_MERCHANT.address);
    txBuilder = builder;
    broadcaster = new FakeTxBroadcaster((serializedTx, hash) => {
      // The fake treasury's transaction lands in the fake chain, exactly as a real broadcast
      // would land in the real one.
      const parsed = parseFakeSerializedTx(serializedTx);
      fakeChain?.include({
        hash,
        from: DEMO_MERCHANT.address,
        to: parsed.recipient,
        value: parsed.valueLuna,
        data: parsed.data,
        networkId: String(config.networkId),
        timestamp: Date.now(),
      });
    });
  } else {
    const endpoint = env('NIMIQ_RPC_URL');
    if (!endpoint) throw new Error('REWIND_CHAIN=rpc but NIMIQ_RPC_URL is not set');
    chainReader = new CachingChainReader(
      new RpcChainReader({
        endpoint,
        clock: systemClock,
        authorization: process.env.NIMIQ_RPC_AUTHORIZATION,
      }),
      systemClock,
    );
    signatureVerifier = new LazyNimiqSignatureVerifier();

    // The treasury signer exists only where a key is configured. Without one the Demo Store
    // simply cannot send a refund, which is a refusal, not a silent no-op: reserveRefund still
    // records the obligation and the order sits in REFUND_APPROVED.
    if (process.env.REWIND_TREASURY_PRIVATE_KEY) {
      txBuilder = new LazyTreasuryTxBuilder();
      broadcaster = new LazyTxBroadcaster(endpoint, process.env.NIMIQ_RPC_AUTHORIZATION);
    } else {
      txBuilder = null;
      broadcaster = null;
    }
  }

  if (IS_FAKE_CHAIN && useRealSignatureVerifier()) {
    // Real signatures against a fake chain is a coherent combination (it is how a real wallet
    // can be tested without spending NIM), so it is allowed rather than refused.
    signatureVerifier = new LazyNimiqSignatureVerifier();
  }

  deps = {
    repo: repository,
    clock: systemClock,
    random: cryptoRandom,
    chain: chainReader,
    signatureVerifier,
    txBuilder,
    broadcaster,
    config,
  };
  return deps;
}

/** Mirrors FakeRefundTxBuilder's format. Dev only. */
function parseFakeSerializedTx(serializedTx: string): {
  recipient: string;
  valueLuna: number;
  data: string;
} {
  const body = serializedTx.replace(/^fake-tx:/, '');
  const parts = body.split('|');
  return {
    recipient: parts[0] ?? '',
    valueLuna: Number(parts[1] ?? 0),
    data: parts[2] ?? '',
  };
}

/** Test aid. Never called by a handler. */
export function resetDeps(): void {
  repository = null;
  chainReader = null;
  signatureVerifier = null;
  txBuilder = null;
  broadcaster = null;
  fakeChain = null;
  deps = null;
}
