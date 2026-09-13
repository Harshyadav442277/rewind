/**
 * Rewind spike — tiny verification server for the phone test.
 *
 * Listens on 0.0.0.0:8787 so the phone on the same Wi-Fi can reach it.
 * CORS is wide open on purpose: this is a LAN-only throwaway spike, never deployed.
 *
 *   GET  /health   -> { ok: true, ... }
 *   POST /verify   -> body { message, publicKey, signature, accounts? } -> verify.mjs report
 *
 * Every payload received is appended to captures/ as evidence for gate N11.
 *
 * Run: node server.mjs           (PORT=8787 REWIND_RPC=https://rpc.nimiqwatch.com to override)
 */

import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifySigned } from './verify.mjs';

const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.REWIND_RPC ?? 'https://rpc.nimiqwatch.com';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES = path.join(HERE, 'captures');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(json);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}  (${name})`);
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'rewind-spike-sign-verify', node: process.version, rpc: RPC_URL });
  }

  if (req.method === 'POST' && url.pathname === '/verify') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { ok: false, error: `bad JSON body: ${e.message}` });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await mkdir(CAPTURES, { recursive: true });
      await writeFile(path.join(CAPTURES, `${stamp}-payload.json`), JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error('could not write capture:', e.message);
    }

    let report;
    try {
      report = await verifySigned({
        message: payload.message,
        publicKey: payload.publicKey,
        signature: payload.signature,
        accounts: payload.accounts ?? [],
        rpcUrl: url.searchParams.get('rpc') === '0' ? null : RPC_URL,
      });
    } catch (e) {
      console.error(e);
      return send(res, 500, { ok: false, error: e.message });
    }

    try {
      await writeFile(path.join(CAPTURES, `${stamp}-report.json`), JSON.stringify(report, null, 2), 'utf8');
    } catch { /* best effort */ }

    console.log(
      `[${stamp}] verify -> matched=${report.matchedVariant} addr=${report.derivedAddress} ` +
      `accountMatch=${report.addressMatchesAccount} rpc=${report.rpc?.ok} GATE_N11=${report.gateN11?.pass ? 'PASS' : 'FAIL'}`,
    );

    return send(res, 200, report);
  }

  return send(res, 404, { ok: false, error: 'not found', routes: ['GET /health', 'POST /verify'] });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`rewind sign-verify server listening on 0.0.0.0:${PORT}`);
  console.log(`  local : http://localhost:${PORT}/health`);
  for (const a of lanAddresses()) console.log(`  LAN   : http://${a.split('  ')[0]}:${PORT}/health   ${a.split('  ')[1]}`);
  console.log(`  RPC cross-check: ${RPC_URL}`);
  console.log(`  captures -> ${CAPTURES}`);
});
