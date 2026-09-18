/**
 * LUMINA agent service — the AI backend. Provider keys live only in this process.
 *
 * Routes mirror packages/contract. The ask route runs the quick gear (quick.ts) or, only
 * when the client asked for it, the deep gear (deep.ts) behind DEEP_DAILY_CAP. Documents are
 * indexed by the jobs worker (worker.ts), forked and supervised from here.
 */
import express from 'express';
import multer from 'multer';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GridFSBucket } from 'mongodb';
import {
  ACCEPTED_UPLOAD_TYPES,
  AskBody,
  COLLECTIONS,
  CreateSpaceBody,
  CreateThreadBody,
  GRIDFS_BUCKETS,
  HealthResponse,
  MAX_UPLOAD_BYTES,
  REQUEST_HEADER,
  USER_HEADER,
  newId,
  type StatsResponse
} from '@lumina/contract';
import { env } from './env.js';
import { col, db, pingDb } from './db.js';
import { AskRun } from './run.js';
import { runQuick } from './quick.js';
import { runDeep } from './deep.js';
import { deleteMemory, listMemories } from './memory.js';
import type { AnswerOut, AskInput } from './compose.js';
import { HttpError, errMsg, log, nextUtcMidnight, todayUtc } from './util.js';

const app = express();
type Handler = (req: express.Request, res: express.Response) => Promise<void>;
const wrap = (fn: Handler): express.RequestHandler => (req, res, next) => fn(req, res).catch(next);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString());

app.disable('x-powered-by');
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST' ? next() : express.json({ limit: '1mb' })(req, res, next)
);
mkdirSync(env.runsDir, { recursive: true });

// ---------------------------------------------------------------- request id, identity, request rows

app.use((req, res, next) => {
  const id = req.header(REQUEST_HEADER)?.trim() || `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  const t0 = Date.now();
  res.on('close', () => {
    if (req.path === '/health') return;
    const a = res.locals.answer as Record<string, unknown> | undefined;
    const row = {
      requestId: id,
      userId: req.header(USER_HEADER) ?? 'anonymous',
      route: `${req.method} ${(req.route?.path as string | undefined) ?? req.path}`,
      status: res.statusCode,
      ms: Date.now() - t0,
      createdAt: new Date(),
      ...(a
        ? {
            answerId: a.answerId,
            tokensIn: (a.tokens as { in: number }).in,
            tokensOut: (a.tokens as { out: number }).out,
            costUsd: a.costUsd,
            toolCalls: a.toolCalls,
            terminated: a.terminated,
            depth: a.depth,
            searchCached: a.searchCached,
            ttftMs: a.ttftMs,
            latencyMs: a.latencyMs
          }
        : {})
    };
    void col(COLLECTIONS.requests)
      .then((c) => c.insertOne(row))
      .catch((e) => log.error({ requestId: id, err: errMsg(e) }, 'could not record request'));
  });
  next();
});

// The agent re-checks identity: reaching it directly must not bypass the header rule.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const user = req.header(USER_HEADER)?.trim();
  if (!user) return void res.status(401).json({ error: `missing ${USER_HEADER} header`, status: 401, requestId: res.locals.requestId });
  res.locals.userId = user;
  next();
});

const uid = (res: express.Response) => String(res.locals.userId);

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

// ---------------------------------------------------------------- health & stats

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok', quickModel: env.llmModelQuick, plannerModel: env.llmModelPlanner, embeddingModel: env.embeddingModel, worker: worker?.connected ? 'up' : env.workerInProcess ? 'down' : 'external', answersEnabled: env.answersEnabled, dailySpendCapUsd: env.dailySpendCapUsd } as HealthResponse['ai']
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

app.get(
  '/stats',
  wrap(async (_req, res) => {
    const requests = await col(COLLECTIONS.requests);
    const since = new Date(`${todayUtc()}T00:00:00.000Z`);
    const [total, answers, today, quota] = await Promise.all([
      requests.countDocuments({}),
      requests.countDocuments({ answerId: { $exists: true } }),
      requests.find({ createdAt: { $gte: since }, answerId: { $exists: true } }, { projection: { costUsd: 1, ttftMs: 1, searchCached: 1, depth: 1, toolCalls: 1 } }).toArray(),
      (await col('deepQuota')).findOne({ _id: `${uid(res)}:${todayUtc()}` })
    ]);
    const ttfts = today.filter((r) => r.depth !== 'deep' && Number.isFinite(r.ttftMs)).map((r) => r.ttftMs as number).sort((a, b) => a - b);
    const searched = today.filter((r) => typeof r.searchCached === 'boolean' && (r.toolCalls ?? 0) > 0);
    const body: StatsResponse = {
      requests: total,
      answers,
      searchCacheHitRatePct: searched.length ? Number(((100 * searched.filter((r) => r.searchCached).length) / searched.length).toFixed(1)) : 0,
      ttftP95Ms: ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.ceil(0.95 * ttfts.length) - 1)]! : 0,
      costUsdToday: Number(today.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)),
      deepToday: (quota?.count as number | undefined) ?? 0,
      deepDailyCap: env.deepDailyCap
    };
    res.json(body);
  })
);

// ---------------------------------------------------------------- threads

async function ownThread(res: express.Response, threadId: string) {
  const t = await (await col(COLLECTIONS.threads)).findOne({ _id: threadId, userId: uid(res) });
  if (!t) throw new HttpError(404, `thread ${threadId} not found`);
  return t;
}

app.post(
  '/threads',
  wrap(async (req, res) => {
    const body = parse(CreateThreadBody, req.body);
    const threadId = newId('thr');
    await (await col(COLLECTIONS.threads)).insertOne({ _id: threadId, userId: uid(res), title: body.title ?? 'New thread', createdAt: new Date() });
    res.status(201).json({ threadId });
  })
);

app.get(
  '/threads',
  wrap(async (_req, res) => {
    const rows = await (await col(COLLECTIONS.threads)).find({ userId: uid(res) }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ threads: rows.map((t) => ({ threadId: t._id, title: t.title, createdAt: iso(t.createdAt) })) });
  })
);

app.get(
  '/threads/:threadId',
  wrap(async (req, res) => {
    const t = await ownThread(res, req.params.threadId!);
    const msgs = await (await col(COLLECTIONS.messages)).find({ threadId: t._id }).sort({ createdAt: 1 }).toArray();
    res.json({
      threadId: t._id,
      title: t.title,
      messages: msgs.map((m) => ({
        role: m.role,
        content: m.content,
        sources: m.sources ?? [],
        ...(m.answerId ? { answerId: m.answerId } : {}),
        ...(m.done ? { done: m.done } : {}),
        ...(m.subQuestions ? { subQuestions: m.subQuestions } : {}),
        createdAt: iso(m.createdAt)
      }))
    });
  })
);

// ---------------------------------------------------------------- ask

/** Atomic per-user, per-UTC-day counter. The upsert collides once the cap is reached. */
async function spendDeep(userId: string): Promise<void> {
  const quota = await col('deepQuota');
  try {
    await quota.findOneAndUpdate(
      { _id: `${userId}:${todayUtc()}`, count: { $lt: env.deepDailyCap } },
      { $inc: { count: 1 }, $setOnInsert: { userId, day: todayUtc(), createdAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      throw new HttpError(429, `deep search daily cap reached (${env.deepDailyCap}/day per user)`, { resetsAt: nextUtcMidnight() });
    }
    throw e;
  }
  if (env.deepDailyCap <= 0) throw new HttpError(429, 'deep search is disabled (DEEP_DAILY_CAP=0)', { resetsAt: nextUtcMidnight() });
}

/**
 * The global spend ceiling. The per-user deep cap protects a user from themselves; anyone can
 * invent an X-User-Id, so this is what bounds the bill against strangers. Cached for 15 s: one
 * aggregate per quarter minute rather than one per answer.
 */
let spendCache = { at: 0, usd: 0 };
async function spentTodayUsd(): Promise<number> {
  if (Date.now() - spendCache.at < 15000) return spendCache.usd;
  const since = new Date(`${todayUtc()}T00:00:00.000Z`);
  const [row] = await (await col(COLLECTIONS.requests))
    .aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: null, usd: { $sum: '$costUsd' } } }])
    .toArray();
  spendCache = { at: Date.now(), usd: Number(row?.usd ?? 0) };
  return spendCache.usd;
}

app.post(
  '/threads/:threadId/ask',
  wrap(async (req, res) => {
    const body = parse(AskBody, req.body);
    const userId = uid(res);
    // Cheapest possible refusals: no provider call, no thread write, no run log.
    if (!env.answersEnabled) throw new HttpError(503, 'answers are disabled on this deployment (ANSWERS_ENABLED=false)');
    if (env.dailySpendCapUsd > 0) {
      const spent = await spentTodayUsd();
      if (spent >= env.dailySpendCapUsd) {
        throw new HttpError(429, `daily spend cap reached: $${spent.toFixed(2)} of $${env.dailySpendCapUsd.toFixed(2)} spent today across all users`, { resetsAt: nextUtcMidnight() });
      }
    }
    const thread = await ownThread(res, req.params.threadId!);
    if (body.mode === 'docs' && !body.spaceId) throw new HttpError(400, 'mode "docs" needs a spaceId');
    if (body.spaceId && !(await (await col(COLLECTIONS.spaces)).findOne({ _id: body.spaceId, userId }))) {
      throw new HttpError(404, `space ${body.spaceId} not found`);
    }
    // The server never upgrades depth; it only ever runs what the client asked for.
    if (body.depth === 'deep') await spendDeep(userId);

    const messages = await col(COLLECTIONS.messages);
    const prior = await messages.find({ threadId: thread._id }).sort({ createdAt: -1 }).limit(6).toArray();
    prior.reverse();
    const input: AskInput = {
      query: body.query,
      mode: body.mode,
      spaceId: body.spaceId,
      history: prior.map((m) => `${m.role}: ${String(m.content).slice(0, 700)}`).join('\n'),
      lastUserQuery: [...prior].reverse().find((m) => m.role === 'user')?.content as string | undefined,
      priorQuestions: prior.filter((m) => m.role === 'user').map((m) => String(m.content).slice(0, 300))
    };

    const requestId = String(res.locals.requestId);
    await messages.insertOne({ _id: newId('ans').replace('ans_', 'msg_'), threadId: thread._id, userId, role: 'user', content: body.query, sources: [], createdAt: new Date() });
    if (thread.title === 'New thread') {
      await (await col(COLLECTIONS.threads)).updateOne({ _id: thread._id }, { $set: { title: body.query.slice(0, 80) } });
    }

    const run = new AskRun(res, { requestId, userId, threadId: thread._id, depth: body.depth, query: body.query });
    const answerId = newId('ans');
    let out: AnswerOut | null = null;
    try {
      out = body.depth === 'deep' ? await runDeep(run, input) : await runQuick(run, input);
    } catch (e) {
      if (run.signal.aborted && !run.capHit && res.destroyed) {
        run.terminated = 'error';
        log.warn({ requestId }, 'client disconnected mid-answer');
      } else {
        const { status, error } = run.fail(e);
        log.error({ requestId, status, error }, 'answer failed');
      }
      run.abort.abort();
    }
    const done = await run.finish(answerId, out?.model ?? (body.depth === 'deep' ? env.llmModel : env.llmModelQuick), out?.subQuestions?.length ?? 0);
    if (out && done.terminated !== 'error') {
      await messages.insertOne({
        _id: answerId.replace('ans_', 'msg_'),
        threadId: thread._id,
        userId,
        role: 'assistant',
        content: out.text,
        answerId,
        sources: out.sources,
        done,
        ...(out.subQuestions ? { subQuestions: out.subQuestions } : {}),
        createdAt: new Date()
      });
    }
  })
);

// ---------------------------------------------------------------- memory

app.get('/memory', wrap(async (_req, res) => void res.json({ memories: await listMemories(uid(res)) })));

app.delete(
  '/memory/:memoryId',
  wrap(async (req, res) => {
    if (!(await deleteMemory(uid(res), req.params.memoryId!))) throw new HttpError(404, `memory ${req.params.memoryId} not found`);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- spaces & documents

async function ownSpace(res: express.Response, spaceId: string) {
  const s = await (await col(COLLECTIONS.spaces)).findOne({ _id: spaceId, userId: uid(res) });
  if (!s) throw new HttpError(404, `space ${spaceId} not found`);
  return s;
}

app.post(
  '/spaces',
  wrap(async (req, res) => {
    const body = parse(CreateSpaceBody, req.body);
    const spaceId = newId('spc');
    await (await col(COLLECTIONS.spaces)).insertOne({ _id: spaceId, userId: uid(res), name: body.name, createdAt: new Date() });
    res.status(201).json({ spaceId, name: body.name });
  })
);

app.get(
  '/spaces',
  wrap(async (_req, res) => {
    const rows = await (await col(COLLECTIONS.spaces)).find({ userId: uid(res) }).sort({ createdAt: -1 }).toArray();
    res.json({ spaces: rows.map((s) => ({ spaceId: s._id, name: s.name, createdAt: iso(s.createdAt) })) });
  })
);

app.get(
  '/spaces/:spaceId/documents',
  wrap(async (req, res) => {
    const space = await ownSpace(res, req.params.spaceId!);
    const rows = await (await col(COLLECTIONS.documents)).find({ spaceId: space._id }).sort({ createdAt: 1 }).toArray();
    res.json({
      documents: rows.map((d) => ({
        docId: d._id,
        title: d.title,
        status: d.status,
        pct: d.pct ?? 0,
        ...(d.pages ? { pages: d.pages } : {}),
        ...(typeof d.chunks === 'number' ? { chunks: d.chunks } : {}),
        ...(d.error ? { error: d.error } : {})
      }))
    });
  })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

function mimeOf(file: Express.Multer.File): string | null {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.txt')) return 'text/plain';
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(file.mimetype) ? file.mimetype : null;
}

/** 202 in well under 300 ms: store the bytes, write two rows, return. The worker does the rest. */
app.post(
  '/spaces/:spaceId/documents',
  (req, res, next) =>
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `file too large: max ${MAX_UPLOAD_BYTES} bytes`));
      if (err) return next(new HttpError(400, `upload failed: ${errMsg(err)}`));
      next();
    }),
  wrap(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'multipart field "file" is required');
    const mimeType = mimeOf(file);
    if (!mimeType) throw new HttpError(400, `unsupported file type: ${file.mimetype} (PDF, Markdown or plain text)`);

    // The ownership check and the GridFS write run concurrently: each is a round trip to Atlas,
    // and the 202 has a 300 ms budget. A write for a space that turns out not to be theirs is removed.
    const docId = newId('doc');
    const bucket = new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
    const stream = bucket.openUploadStream(file.originalname, { metadata: { docId, spaceId: req.params.spaceId, userId: uid(res), mimeType } });
    const stored = new Promise<void>((resolve, reject) => {
      stream.once('finish', () => resolve());
      stream.once('error', reject);
      stream.end(file.buffer);
    });
    const [spaceResult] = await Promise.allSettled([ownSpace(res, req.params.spaceId!), stored]);
    await stored;
    if (spaceResult.status === 'rejected') {
      await bucket.delete(stream.id).catch((e) => log.error({ err: errMsg(e), docId }, 'could not remove orphaned upload'));
      throw spaceResult.reason;
    }
    const space = spaceResult.value;

    const now = new Date();
    await (await col(COLLECTIONS.documents)).insertOne({
      _id: docId,
      spaceId: space._id,
      userId: uid(res),
      title: file.originalname,
      mimeType,
      bytes: file.size,
      status: 'pending',
      pct: 0,
      fileId: String(stream.id),
      createdAt: now
    });
    await (await col(COLLECTIONS.jobs)).insertOne({ _id: `job_${docId}`, kind: 'index_document', status: 'pending', payload: { docId }, userId: uid(res), attempts: 0, createdAt: now });
    res.status(202).json({ docId, status: 'pending' });
  })
);

// ---------------------------------------------------------------- errors

app.use((req, res) => void res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : err.type === 'entity.parse.failed' ? 400 : 502;
  if (status >= 500) log.error({ err, requestId: res.locals.requestId }, 'agent error');
  if (res.headersSent) return void res.end();
  res.status(status).json({ error: err.message, status, requestId: res.locals.requestId, ...(err instanceof HttpError ? err.extra : {}) });
});

// ---------------------------------------------------------------- worker supervisor

let worker: ChildProcess | null = null;
let shuttingDown = false;
function startWorker() {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  worker = fork(fileURLToPath(new URL(`./worker${ext}`, import.meta.url)), [], { execArgv: process.execArgv.filter((a) => !a.startsWith('--inspect')) });
  worker.on('exit', (code) => {
    if (shuttingDown) return;
    log.warn({ code }, 'jobs worker exited; restarting in 2s');
    setTimeout(startWorker, 2000);
  });
}
if (env.workerInProcess) startWorker();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    worker?.kill();
    process.exit(0);
  });
}

app.listen(env.port, async () => {
  // Imported here so the connection pool and the cold-start calls happen once the server is
  // up, never in the path of the first request.
  const { warmUp } = await import('./warmup.js');
  void warmUp();
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      quickModel: env.llmModelQuick,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      }
    },
    'agent up'
  );
});
