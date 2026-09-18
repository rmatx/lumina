import { createHash } from 'node:crypto';
import pino from 'pino';
import { env } from './env.js';

export const log = pino({ level: env.logLevel });

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** An error that knows its HTTP status. Anything thrown without one is an upstream failure: 502. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** Provider failures are 502. Named so a reader of the loop sees which catch is which. */
export class UpstreamError extends HttpError {
  constructor(message: string) {
    super(502, message);
  }
}

/** Small TTL'd LRU. Map preserves insertion order, so the first key is the oldest. */
export class Lru<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private max: number,
    private ttlMs: number
  ) {}
  get(k: string): V | undefined {
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, hit);
    return hit.v;
  }
  set(k: string, v: V, ttlMs = this.ttlMs): void {
    this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

/** Run tasks with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'unknown error';

export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const nextUtcMidnight = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
};
