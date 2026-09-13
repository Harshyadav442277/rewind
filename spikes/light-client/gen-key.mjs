#!/usr/bin/env node
// Rewind spike — light-client. Generates a fresh Nimiq keypair for TESTNET use and writes the
// private key to .env.local (gitignored). Prints ONLY the user-friendly address.
//
// Usage:  node gen-key.mjs [--out <path>]
// Refuses to overwrite an existing file (existsSync guard + O_EXCL on the write itself).
//
// This key is a TESTNET burner. It is funded from the public testnet faucet and holds nothing
// of value. It must never be used on mainnet.

import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from '@nimiq/core';

const here = dirname(fileURLToPath(import.meta.url));

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = resolve(outIdx === -1 ? resolve(here, '.env.local') : args[outIdx + 1]);

  if (existsSync(outPath)) {
    console.error(`REFUSING TO OVERWRITE: ${outPath} already exists.`);
    console.error('Move or delete it yourself if you really want a new key. This script will not touch it.');
    process.exitCode = 2;
    return;
  }

  const keyPair = KeyPair.generate();
  const address = keyPair.toAddress().toUserFriendlyAddress();
  const privateKeyHex = keyPair.privateKey.toHex();

  // flag 'wx' => O_EXCL: fails rather than truncating if the file appeared since the check.
  writeFileSync(
    outPath,
    `# Rewind light-client spike burner key — TESTNET ONLY. Generated ${new Date().toISOString()}.\n` +
      `# Address: ${address}\n` +
      `# Funded from the public testnet faucet. Holds nothing of value. Never use on mainnet,\n` +
      `# never commit, never paste anywhere.\n` +
      `REWIND_TESTNET_PRIVATE_KEY=${privateKeyHex}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  console.log(address);
}

main();
