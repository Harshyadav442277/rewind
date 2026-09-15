import { describe, expect, it } from 'vitest';
import { defaultNetworkId, networkNameFromEnv } from './network.js';
import { treasuryNetworkIdFromEnv } from './treasury-broadcaster.js';

describe('network selection', () => {
  it('reads REWIND_NETWORK, and anything unrecognised is mainnet', () => {
    expect(networkNameFromEnv({ REWIND_NETWORK: 'testnet' } as NodeJS.ProcessEnv)).toBe('testnet');
    expect(networkNameFromEnv({ REWIND_NETWORK: 'mainnet' } as NodeJS.ProcessEnv)).toBe('mainnet');
    expect(networkNameFromEnv({} as NodeJS.ProcessEnv)).toBe('mainnet');
    // A typo must not silently select testnet and make every mainnet check pass against 5.
    expect(networkNameFromEnv({ REWIND_NETWORK: 'Testnet' } as NodeJS.ProcessEnv)).toBe('mainnet');
  });

  it('defaults networkId to 5 on testnet and 24 otherwise', () => {
    expect(defaultNetworkId({ REWIND_NETWORK: 'testnet' } as NodeJS.ProcessEnv)).toBe(5);
    expect(defaultNetworkId({} as NodeJS.ProcessEnv)).toBe(24);
  });

  it('gives the treasury signer the same default networkId the domain checks', () => {
    for (const env of [{}, { REWIND_NETWORK: 'testnet' }, { REWIND_NETWORK: 'mainnet' }]) {
      const e = env as NodeJS.ProcessEnv;
      expect(treasuryNetworkIdFromEnv(e)).toBe(defaultNetworkId(e));
    }
    expect(treasuryNetworkIdFromEnv({ REWIND_NETWORK_ID: '24', REWIND_NETWORK: 'testnet' } as NodeJS.ProcessEnv)).toBe(24);
  });
});
