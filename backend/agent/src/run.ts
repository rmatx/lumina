import type { Response } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLECTIONS,
  RunLog,
  TraceEvent,
  type Depth,
  type DoneEvent,
  type SseEventName,
  type Terminated,
  type ToolName
} from '@lumina/contract';
import { env } from './env.js';
import { col } from './db.js';
import { HttpError, errMsg, log } from './util.js';

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A trace step that has run but not been emitted yet (deep search emits per sub-question). */
export interface PendingStep {
  trace: Omit<TraceEvent, 'step'>;
}

/**
 * One ask, from first byte to run log. Owns the caps, the trace, the cost and the stream.
 *
 * The response is NOT committed to 200 until `commit()` — called when the first retrieval
 * succeeds or the plan is ready. A provider failure before that is a real HTTP 502, not a
 * 200 stream carrying an apology.
 */
export class AskRun {
  readonly started = Date.now();
  readonly abort = new AbortController();
  readonly maxCalls: number;
  readonly deadline: number;
  capHit: 'tool calls' | 'wall clock' | null = null;
  terminated: Terminated = 'done';

  private committed = false;
  private ended = false;
  private queue: string[] = [];
  private step = 0;
  private callsStarted = 0;
  private timer: NodeJS.Timeout;
  /** Steps held for grouped emission; flushed on failure so a failed step is never lost. */
  private sinks = new Set<PendingStep[]>();

  readonly toolCalls: RunLog['toolCalls'] = [];
  readonly trace: TraceEvent[] = [];
  tokensIn = 0;
  tokensOut = 0;
  extraCostUsd = 0;
  searches = 0;
  searchesCached = 0;
  ttftMs: number | null = null;

  constructor(
    private res: Response,
    readonly ctx: { requestId: string; userId: string; threadId: string; depth: Depth; query: string }
  ) {
    const deep = ctx.depth === 'deep';
    this.maxCalls = deep ? env.maxToolCallsDeep : env.maxToolCalls;
    this.deadline = this.started + (deep ? env.maxWallClockSecDeep : env.maxWallClockSec) * 1000;
    this.timer = setTimeout(() => {
      this.capHit ??= 'wall clock';
      this.abort.abort(new Error('wall-clock cap'));
    }, this.deadline - this.started);
    res.on('close', () => {
      if (!this.ended) this.abort.abort(new Error('client disconnected'));
    });
  }

  get signal() {
    return this.abort.signal;
  }

  get callsLeft(): number {
    return Math.max(0, this.maxCalls - this.callsStarted);
  }

  /** True when another tool call would break the gear's cap. Sets capHit so the answer says so. */
  atCap(): boolean {
    if (this.capHit) return true;
    if (this.callsStarted >= this.maxCalls) this.capHit = 'tool calls';
    else if (Date.now() >= this.deadline) this.capHit = 'wall clock';
    return this.capHit !== null;
  }

  send(event: SseEventName, data: unknown): void {
    if (this.ended || this.res.writableEnded) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (this.committed) this.res.write(frame);
    else this.queue.push(frame);
  }

  commit(): void {
    if (this.committed || this.ended) return;
    this.committed = true;
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();
    for (const f of this.queue) this.res.write(f);
    this.queue = [];
  }

  /**
   * Run one tool call under the cap. With no `sink` the trace step is emitted immediately;
   * with a sink it is held so a sub-question's steps stay together in the log.
   */
  async tool<T>(
    name: ToolName,
    input: Record<string, unknown>,
    reason: string,
    fn: () => Promise<T>,
    opts: { subQuestion?: number; sink?: PendingStep[]; describe?: (v: T) => Record<string, unknown> } = {}
  ): Promise<ToolResult<T>> {
    if (this.atCap()) return { ok: false, error: `skipped: ${this.capHit} cap reached` };
    this.callsStarted++;
    const t0 = Date.now();
    let result: ToolResult<T>;
    let extra: Record<string, unknown> = {};
    try {
      const value = await fn();
      extra = opts.describe?.(value) ?? {};
      result = { ok: true, value };
    } catch (e) {
      if (this.signal.aborted && !this.capHit) throw e; // client went away: nothing to report to
      result = { ok: false, error: this.capHit ? `${this.capHit} cap reached: ${errMsg(e)}` : errMsg(e) };
    }
    const trace: Omit<TraceEvent, 'step'> = {
      tool: name,
      input: { ...input, ...extra },
      ok: result.ok,
      ms: Date.now() - t0,
      reason,
      ...(result.ok ? {} : { error: result.error }),
      ...(opts.subQuestion ? { subQuestion: opts.subQuestion } : {})
    };
    if (opts.sink) {
      opts.sink.push({ trace });
      this.sinks.add(opts.sink);
    } else this.emitStep(trace);
    return result;
  }

  emitStep(t: Omit<TraceEvent, 'step'>): void {
    const ev = TraceEvent.parse({ step: ++this.step, ...t });
    this.trace.push(ev);
    this.toolCalls.push({ name: ev.tool, ok: ev.ok, ms: ev.ms, ...(ev.error ? { error: ev.error } : {}) });
    this.send('trace', ev);
  }

  flush(sink: PendingStep[]): void {
    for (const p of sink.splice(0)) this.emitStep(p.trace);
  }

  addUsage(model: string, u: { in: number; out: number }, cost: (m: string, i: number, o: number) => number): void {
    this.tokensIn += u.in;
    this.tokensOut += u.out;
    this.extraCostUsd += cost(model, u.in, u.out);
  }

  token(text: string): void {
    if (!text) return;
    if (this.ttftMs === null) this.ttftMs = Date.now() - this.started;
    this.send('token', { text });
  }

  get costUsd(): number {
    return Number(this.extraCostUsd.toFixed(6));
  }

  /** Close the stream as a failure. Before commit this is a real HTTP status. */
  fail(e: unknown): { status: number; error: string } {
    const status = e instanceof HttpError ? e.status : 502;
    const error = errMsg(e);
    this.terminated = 'error';
    for (const sink of this.sinks) this.flush(sink);
    if (!this.committed && !this.res.headersSent) {
      this.ended = true;
      this.res.status(status).json({ error, status, requestId: this.ctx.requestId, ...(e instanceof HttpError ? e.extra : {}) });
    } else {
      this.send('error', { status, error });
    }
    return { status, error };
  }

  /** Emit `done` (when committed), end the stream, write the run log. Returns the done payload. */
  async finish(answerId: string, model: string, subQuestions: number): Promise<DoneEvent> {
    clearTimeout(this.timer);
    const done: DoneEvent = {
      answerId: answerId as DoneEvent['answerId'],
      latencyMs: Date.now() - this.started,
      ttftMs: this.ttftMs ?? Date.now() - this.started,
      model,
      tokens: { in: this.tokensIn, out: this.tokensOut },
      costUsd: this.costUsd,
      searchCached: this.searches > 0 && this.searchesCached === this.searches,
      terminated: this.terminated,
      depth: this.ctx.depth,
      subQuestions
    };
    // Before the response closes: the request-row writer reads this on 'close'.
    this.res.locals.answer = { ...done, toolCalls: this.toolCalls.length };
    if (this.committed) {
      this.send('done', done);
      this.ended = true;
      this.res.end();
    }
    this.ended = true;
    await this.writeRunLog(done);
    return done;
  }

  private async writeRunLog(done: DoneEvent): Promise<void> {
    const runLog = RunLog.parse({
      tokens: done.tokens.in + done.tokens.out,
      wallClockSec: Number((done.latencyMs / 1000).toFixed(2)),
      costUsd: done.costUsd,
      terminated: done.terminated,
      depth: done.depth,
      toolCalls: this.toolCalls
    });
    mkdirSync(env.runsDir, { recursive: true });
    writeFileSync(join(env.runsDir, `${this.ctx.requestId}.json`), JSON.stringify(runLog, null, 2));
    if (env.runsToMongo) {
      await (await col(COLLECTIONS.runs)).updateOne(
        { requestId: this.ctx.requestId },
        { $set: { ...runLog, requestId: this.ctx.requestId, userId: this.ctx.userId, threadId: this.ctx.threadId, answerId: done.answerId, query: this.ctx.query, trace: this.trace, createdAt: new Date() } },
        { upsert: true }
      );
    }
    this.res.locals.answer = { ...done, toolCalls: this.toolCalls.length, depth: done.depth };
    log.info(
      {
        requestId: this.ctx.requestId,
        userId: this.ctx.userId,
        toolCalls: this.toolCalls.length,
        terminated: done.terminated,
        depth: done.depth,
        tokens: done.tokens,
        costUsd: done.costUsd,
        searchCached: done.searchCached,
        ttftMs: done.ttftMs,
        latencyMs: done.latencyMs
      },
      'answer'
    );
  }
}
