/**
 * Which Nimiq network the server checks transactions against.
 *
 * `REWIND_NETWORK` is `mainnet` (the default, and what any unrecognised value means, so a typo
 * fails safe) or `testnet`. It decides the `networkId` the domain expects when
 * `REWIND_NETWORK_ID` does not pin one, and the explorer the views link to. Production is
 * mainnet. No public testnet JSON-RPC endpoint is known (`rpc.nimiq-testnet.com` did not
 * resolve on 2026-09-12), so `testnet` needs a private node behind `NIMIQ_RPC_URL`.
 *
 * Network ids observed 2026-09-13: mainnet transactions report 24; a testnet client reported 5.
 */

export type NetworkName = 'testnet' | 'mainnet';

export const NETWORK_IDS: Readonly<Record<NetworkName, number>> = {
  testnet: 5,
  mainnet: 24,
};

export function networkNameFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkName {
  return env.REWIND_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
}

/** The networkId the domain should expect, with no `REWIND_NETWORK_ID` override set. */
export function defaultNetworkId(env: NodeJS.ProcessEnv = process.env): number {
  return NETWORK_IDS[networkNameFromEnv(env)];
}
