import type { Repository } from '../db/repository';
import { DEFAULT_TREASURY_CAPS, type TreasuryCaps } from './demo-treasury';
import { DEFAULT_CHALLENGE_TTL_SEC } from './challenge';
import type {
  ChainReader,
  Clock,
  RandomSource,
  RefundTxBuilder,
  SignatureVerifier,
  TxBroadcaster,
} from './ports';

export interface DomainConfig {
  /**
   * Compared as a string against `networkId` on every transaction record.
   * Albatross mainnet is 24. The default is 24 so a mainnet build is correct with no env
   * var set at all; `REWIND_NETWORK_ID` is an override for a testnet or a local node.
   */
  networkId: number | string;
  /** Confirmations required before a transfer counts. */
  minConfirmations: number;
  /** Fee the treasury attaches to a refund, in Luna. */
  refundFeeLuna: number;
  /**
   * How many blocks a prepared refund stays valid for. After it lapses without inclusion the
   * refund is conclusively dead and the execution can be marked failed rather than re-sent.
   */
  refundValidityWindowBlocks: number;
  challengeTtlSec: number;
  /** How long an unpaid order stays open. */
  orderTtlMs: number;
  treasuryCaps: TreasuryCaps;
  demoMerchantId: string;
  /**
   * Below this treasury balance the Demo Store stops offering to sell. It is not a safety
   * limit — the caps are — it is honesty: a store that cannot pay a refund back must not
   * take the payment. `GET /api/health` compares it with the balance it reads.
   */
  treasuryFloorLuna: number;
  /**
   * The Demo Store approves its own refunds. It is the merchant, the policy is published on
   * the store screen, and it is what lets one person walk the whole flow. Every other
   * merchant approves by hand, in their own wallet.
   */
  demoAutoApprove: boolean;
}

export const DEFAULT_CONFIG: DomainConfig = {
  // 24 = Albatross mainnet, observed live on 2026-09-13. It was 42 (pre-Albatross) until
  // then, which matches nothing on the current chain, so every verification failed closed.
  networkId: 24,
  minConfirmations: 2,
  refundFeeLuna: 0,
  refundValidityWindowBlocks: 120,
  challengeTtlSec: DEFAULT_CHALLENGE_TTL_SEC,
  orderTtlMs: 30 * 60 * 1000,
  treasuryCaps: DEFAULT_TREASURY_CAPS,
  demoMerchantId: 'demo-store',
  treasuryFloorLuna: 50_000, // 0.5 NIM, fifty demo refunds' worth
  demoAutoApprove: true,
};

export interface DomainDeps {
  repo: Repository;
  clock: Clock;
  random: RandomSource;
  chain: ChainReader;
  signatureVerifier: SignatureVerifier;
  /** Present only where the capped Demo Store treasury is configured. */
  txBuilder: RefundTxBuilder | null;
  broadcaster: TxBroadcaster | null;
  config: DomainConfig;
}
