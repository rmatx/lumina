/**
 * LUMINA gateway — the software backend, and the only service the browser talks to.
 *
 *   X-User-Id enforcement → 401 · zod validation from @lumina/contract → 400
 *   per-user rate limit → 429 · early 413 on oversized uploads
 *   proxy to the agent service, SSE piped through unbuffered · 502 on any upstream failure
 *
 * No provider key and no database connection live here.
 */
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ZodTypeAny } from 'zod';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  MAX_UPLOAD_BYTES,
  REQUEST_HEADER,
  USER_HEADER
} from '@lumina/contract';
import { env } from './env.js';

const log = pino({ level: env.logLevel });
const app = express();
type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void;
const wrap = (fn: Handler): express.RequestHandler => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

// One request id, reused if inbound, generated if not, forwarded, logged by both services.
app.use((req, res, next) => {
  const inbound = req.header(REQUEST_HEADER)?.trim();
  const id = inbound && /^[\w.:-]{1,100}$/.test(inbound) ? inbound : `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

// One JSON line per request, written when the response closes (so a stream logs once, at the end).
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('close', () => {
    log.info({
      method: req.method,
      route: (req.route?.path as string | undefined) ?? req.path,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - t0,
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }, 'request');
  });
  next();
});

app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST' ? next() : express.json({ limit: '1mb' })(req, res, next)
);

const errorBody = (res: express.Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error, status, requestId: String(res.locals.requestId), ...extra });

// ---------------------------------------------------------------- unauthenticated routes

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    ai = { status: 'down', error: (err as Error).message };
  }
  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: String(ai.searchProvider ?? 'unknown'),
    vectorStore: String(ai.vectorStore ?? 'unknown'),
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

/** Written by /fde-lumina-eval (eval/build-report.mjs). Served verbatim, never generated here. */
app.get('/evals/report.json', (_req, res) => {
  const candidates = [process.env.EVALS_REPORT_PATH, resolve(process.cwd(), '../../reports/report.json'), resolve(process.cwd(), 'report.json')].filter(Boolean) as string[];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return void errorBody(res, 404, 'no evaluation report yet: run /fde-lumina-eval');
  res.type('application/json').send(readFileSync(path, 'utf8'));
});

// ---------------------------------------------------------------- auth + rate limit

const API = /^\/(stats|threads|memory|spaces)(\/|$)/;

app.use((req, res, next) => {
  if (!API.test(req.path)) return next();
  const user = req.header(USER_HEADER)?.trim();
  if (!user) return void errorBody(res, 401, `missing ${USER_HEADER} header`);
  if (user.length > 128) return void errorBody(res, 400, `${USER_HEADER} too long`);
  next();
});

/** Token bucket per user. Writes (asks, uploads, creates) spend from the tight bucket; reads from a 10x one. */
const buckets = new Map<string, { tokens: number; at: number }>();
function allow(key: string, perMinute: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(key, b);
  return { ok, retryAfterSec: ok ? 0 : Math.ceil(((1 - b.tokens) / perMinute) * 60) };
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60000;
  for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
}, 60000).unref();

app.use((req, res, next) => {
  if (!API.test(req.path)) return next();
  const user = req.header(USER_HEADER)!.trim();
  const write = req.method !== 'GET';
  const limit = write ? env.rateLimitPerMinute : env.rateLimitPerMinute * 10;
  const { ok, retryAfterSec } = allow(`${write ? 'w' : 'r'}:${user}`, limit);
  if (ok) return next();
  res.setHeader('Retry-After', String(retryAfterSec));
  errorBody(res, 429, `rate limit: ${limit} ${write ? 'writes' : 'reads'} per minute per user`);
});

// ---------------------------------------------------------------- proxy

const validate = (schema: ZodTypeAny): express.RequestHandler => (req, res, next) => {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return void errorBody(res, 400, msg);
  }
  req.body = parsed.data;
  next();
};

async function proxy(req: express.Request, res: express.Response, opts: { streamBody?: boolean } = {}): Promise<void> {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const headers: Record<string, string> = {
    [USER_HEADER]: req.header(USER_HEADER) ?? '',
    [REQUEST_HEADER]: String(res.locals.requestId)
  };
  let body: RequestInit['body'];
  if (opts.streamBody) {
    if (req.header('content-type')) headers['content-type'] = req.header('content-type')!;
    if (req.header('content-length')) headers['content-length'] = req.header('content-length')!;
    body = req as unknown as ReadableStream;
  } else if (req.method !== 'GET' && req.method !== 'DELETE') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body ?? {});
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers,
      body,
      signal: ac.signal,
      ...(opts.streamBody ? { duplex: 'half' } : {})
    } as RequestInit);
  } catch (e) {
    if (ac.signal.aborted) return;
    log.error({ requestId: res.locals.requestId, err: (e as Error).message }, 'agent unreachable');
    return void errorBody(res, 502, `agent service unreachable: ${(e as Error).message}`);
  }

  const type = upstream.headers.get('content-type') ?? '';
  if (!type.startsWith('text/event-stream')) {
    const text = await upstream.text();
    res.status(upstream.status);
    if (type) res.setHeader('content-type', type);
    res.send(text);
    return;
  }

  // SSE: no compression, headers flushed now, every chunk written as it arrives.
  res.status(upstream.status);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  } catch (e) {
    if (!ac.signal.aborted) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: 502, error: `agent stream broke: ${(e as Error).message}` })}\n\n`);
    }
  }
  res.end();
}

app.get('/stats', wrap((req, res) => proxy(req, res)));
app.get('/threads', wrap((req, res) => proxy(req, res)));
app.post('/threads', validate(CreateThreadBody), wrap((req, res) => proxy(req, res)));
app.get('/threads/:threadId', wrap((req, res) => proxy(req, res)));
app.post('/threads/:threadId/ask', validate(AskBody), wrap((req, res) => proxy(req, res)));
app.get('/memory', wrap((req, res) => proxy(req, res)));
app.delete('/memory/:memoryId', wrap((req, res) => proxy(req, res)));
app.get('/spaces', wrap((req, res) => proxy(req, res)));
app.post('/spaces', validate(CreateSpaceBody), wrap((req, res) => proxy(req, res)));
app.get('/spaces/:spaceId/documents', wrap((req, res) => proxy(req, res)));
app.post(
  '/spaces/:spaceId/documents',
  (req, res, next) => {
    const len = Number(req.header('content-length') ?? 0);
    // multipart overhead is small; anything clearly over the cap is refused before a byte is proxied
    if (len > MAX_UPLOAD_BYTES + 64 * 1024) return void errorBody(res, 413, `file too large: max ${MAX_UPLOAD_BYTES} bytes`);
    if (!/^multipart\/form-data/i.test(req.header('content-type') ?? '')) return void errorBody(res, 400, 'expected multipart/form-data with a "file" field');
    next();
  },
  wrap((req, res) => proxy(req, res, { streamBody: true }))
);

// ---------------------------------------------------------------- static UI

if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals\/report\.json)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => errorBody(res, 404, `no route ${req.method} ${req.path}`));

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error & { type?: string; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === 'entity.parse.failed') return void errorBody(res, 400, 'invalid JSON body');
  if (err.type === 'entity.too.large') return void errorBody(res, 413, 'body too large');
  log.error({ err, requestId: res.locals.requestId }, 'gateway error');
  if (res.headersSent) return void res.end();
  errorBody(res, 502, err.message);
});

app.listen(env.port, () => {
  log.info({ port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins }, 'gateway up');
});
