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

import type { IncomingMessage, ServerResponse } from 'node:http';
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

export function devApiPlugin(): Plugin {
  return {
    name: 'rewind-dev-api',
    configureServer(server: ViteDevServer) {
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
