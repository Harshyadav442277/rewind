#!/usr/bin/env node
// Usage: node check-balance.mjs <NQ.. address>
import { getAccountByAddress } from './rpc.mjs';

const address = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
if (!address) {
  console.error('Usage: node check-balance.mjs "NQxx XXXX ...."');
  process.exit(2);
}

const { data, metadata } = await getAccountByAddress(address);
const luna = BigInt(data.balance);
const nim = Number(luna) / 1e5;

console.log(`address        ${data.address}`);
console.log(`type           ${data.type}`);
console.log(`balance        ${luna} Luna  =  ${nim.toFixed(5)} NIM`);
console.log(`at block       ${metadata?.blockNumber ?? '(none)'}`);
console.log(`checked at     ${new Date().toISOString()}`);
