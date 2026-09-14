/**
 * Mounts the `api/` handlers inside `vite dev`.
 *
 * In production Vercel turns each file under `api/` into a serverless function and does this
 * routing itself. Locally nothing does, so `npm run dev` would serve a frontend with no
 * backend. This plugin loads the exact same handler modules through Vite's SSR loader and
 * adapts Node's req/res to the small `ApiRequest`/`ApiResponse` shapes the handlers use.
 *
 * It is a development convenience with no production counterpart: nothing under `api/`
 * imports it, and the deployment never runs it.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import type { ApiRequest, ApiResponse, Handler } from '../api/_lib/http';

interface Route {
  /** Regex over the pathname; named groups become query parameters. */
  pattern: RegExp;
  module: string;
}

const ROUTES: Route[] = [
  { pattern: /^\/api\/orders$/, module: '/api/orders.ts' },
  { pattern: /^\/api\/orders\/(?<id>[^/]+)$/, module: '/api/orders/[id].ts' },
  { pattern: /^\/api\/orders\/(?<id>[^/]+)\/payment$/, module: '/api/orders/[id]/payment.ts' },
  {
    pattern: /^\/api\/orders\/(?<id>[^/]+)\/refund-challenge$/,
    module: '/api/orders/[id]/refund-challenge.ts',
  },
  { pattern: /^\/api\/orders\/(?<id>[^/]+)\/refund$/, module: '/api/orders/[id]/refund.ts' },
  { pattern: /^\/api\/merchant\/refunds$/, module: '/api/merchant/refunds.ts' },
  { pattern: /^\/api\/merchant\/challenge$/, module: '/api/merchant/challenge.ts' },
  { pattern: /^\/api\/merchant\/register$/, module: '/api/merchant/register.ts' },
  { pattern: /^\/api\/merchants\/(?<id>[^/]+)$/, module: '/api/merchants/[id].ts' },
  { pattern: /^\/api\/dev\/fake-chain$/, module: '/api/dev/fake-chain.ts' },
  { pattern: /^\/api\/health$/, module: '/api/health.ts' },
];

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function adaptResponse(res: ServerResponse): ApiResponse {
  let statusCode = 200;
  const api: ApiResponse = {
    status(code: number) {
      statusCode = code;
      return api;
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
    },
    json(body: unknown) {
      res.statusCode = statusCode;
      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify(body));
    },
    end(chunk?: string) {
      res.statusCode = statusCode;
      res.end(chunk);
    },
  };
  return api;
}

/**
 * Loads `.env.local` from the repository root into `process.env`, without overriding anything
 * already set — the rehearsal script passes its variables explicitly and those must win.
 *
 * Vite reads `.env` files for the CLIENT bundle (`VITE_`-prefixed only) and never puts them in
 * `process.env`, so without this the API handlers running in this process would not see
 * `REWIND_TREASURY_PRIVATE_KEY` even though the file is sitting next to them. Values are never
 * logged: only the names that were applied are.
 */
function loadDotEnvLocal(root: string, log: (line: string) => void): void {
  const file = resolve(root, '.env.local');
  if (!existsSync(file)) return;
  const applied: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[name] !== undefined) continue;
    process.env[name] = value;
    applied.push(name);
  }
  if (applied.length > 0) log(`[rewind-dev-api] .env.local applied: ${applied.join(', ')}`);
}

/** Every non-internal IPv4 address, so the phone can be told where to point. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

export function devApiPlugin(): Plugin {
  return {
    name: 'rewind-dev-api',
    configureServer(server: ViteDevServer) {
      const log = (line: string) => server.config.logger.info(line);
      loadDotEnvLocal(server.config.root, log);

      if (process.env.REWIND_CHAIN === 'lightclient') {
        // The port vite ASKED for is not always the port it gets — it walks forward when one
        // is busy, and a URL typed into a phone from the wrong port is a silent dead end. So
        // this waits for the socket and reports what it actually bound.
        server.httpServer?.once('listening', () => {
          const bound = server.httpServer?.address();
          const port = typeof bound === 'object' && bound ? bound.port : server.config.server.port;
          for (const address of lanAddresses()) {
            log(`[rewind-dev-api] phone (same wifi): http://${address}:${port}`);
          }
        });
        // Boot the client NOW rather than on the phone's first tap: consensus is 5-6 s on
        // testnet and every request would otherwise queue behind it. Loaded through the SSR
        // graph on purpose — importing it here would be a DIFFERENT module instance from the
        // one the handlers use, and the whole point is one shared client per process.
        void server
          .ssrLoadModule('/server/chain/light-client-chain-reader.ts')
          .then(async (mod: Record<string, unknown>) => {
            const boot = mod.getSharedLightClient as (o?: unknown) => Promise<unknown>;
            const name = process.env.REWIND_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
            log(`[rewind-dev-api] warming the ${name} light client…`);
            await boot({ network: name, onLog: log });
            log('[rewind-dev-api] light client ready');
          })
          .catch((err: unknown) => {
            server.config.logger.error(`[rewind-dev-api] light client boot failed: ${String(err)}`);
          });
      }

      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith('/api/')) return next();

        const url = new URL(rawUrl, 'http://localhost');
        const route = ROUTES.find((r) => r.pattern.test(url.pathname));
        if (!route) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such endpoint.' } }));
          return;
        }

        const match = route.pattern.exec(url.pathname);
        const query: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of url.searchParams) query[key] = value;
        for (const [key, value] of Object.entries(match?.groups ?? {})) {
          if (value !== undefined) query[key] = decodeURIComponent(value);
        }

        try {
          const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
          const apiReq: ApiRequest = {
            method: req.method,
            url: rawUrl,
            headers: req.headers as Record<string, string | string[] | undefined>,
            query,
            body: raw === '' ? undefined : raw,
            socket: { remoteAddress: req.socket.remoteAddress ?? undefined },
          };
          const mod = (await server.ssrLoadModule(route.module)) as { default: Handler };
          await mod.default(apiReq, adaptResponse(res));
        } catch (err) {
          server.config.logger.error(`[rewind-dev-api] ${String(err)}`);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                error: { code: 'internal', message: 'Dev API handler threw.', detail: String(err) },
              }),
            );
          }
        }
      });
    },
  };
}
