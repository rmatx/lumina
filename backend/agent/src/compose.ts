import { SourcesEvent, type Source } from '@lumina/contract';
import { env } from './env.js';
import type { AskRun, PendingStep } from './run.js';
import { embedCost, llmCost, SEARCH_USD_PER_CALL, streamText } from './providers/llm.js';
import { fetchPage, webSearch, type SearchResult } from './providers/search.js';
import { embedOne } from './providers/embed.js';
import { extractMemory, saveMemory } from './memory.js';
import { bestPassage } from './snippets.js';
import { UpstreamError } from './util.js';
import type { DocHit } from './rag.js';

export interface AskInput {
  query: string;
  mode: 'auto' | 'web' | 'docs';
  spaceId?: string;
  /** Recent turns of this thread, already rendered as text. */
  history: string;
  /** The previous user question in this thread, for follow-up search queries. */
  lastUserQuery?: string;
  /** Earlier user questions in this thread, oldest first. The planner sees these, never prior answers. */
  priorQuestions: string[];
}

export interface Material {
  kind: 'web' | 'doc';
  title: string;
  url?: string;
  docId?: string;
  locator?: DocHit['locator'];
  snippet: string;
  context: string;
  subQuestion?: number;
}

export interface AnswerOut {
  text: string;
  sources: Source[];
  model: string;
  subQuestions?: { i: number; question: string; reason?: string }[];
}

const urlKey = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

export const materialKey = (m: Material) =>
  m.kind === 'web'
    ? `url:${urlKey(m.url ?? '')}`
    : `doc:${m.docId}:${m.locator?.page ?? ''}:${m.locator?.heading ?? ''}:${m.locator?.line ?? ''}`;

/** Number contiguously from 1, in the order given. The contract schema is the final check. */
export function toSources(ms: Material[]): Source[] {
  return SourcesEvent.parse(
    ms.map((m, i) => ({
      n: i + 1,
      kind: m.kind,
      title: m.title.slice(0, 300) || 'untitled',
      snippet: m.snippet,
      ...(m.url ? { url: m.url } : {}),
      ...(m.docId ? { docId: m.docId, locator: m.locator } : {}),
      ...(m.subQuestion ? { subQuestion: m.subQuestion } : {})
    }))
  );
}

export function docMaterial(h: DocHit, subQuestion?: number): Material {
  return { kind: 'doc', title: h.title, docId: h.docId, locator: h.locator, snippet: h.text, context: h.context, subQuestion };
}

export const embedQuery = (run: AskRun, text: string) =>
  embedOne(text).then((v) => {
    run.extraCostUsd += embedCost(v.tokens);
    return v.vector;
  });

/**
 * A follow-up like "and what about pricing?" searches with the previous question as context.
 * Only questions that clearly lean on the last one are rewritten: gluing two standalone
 * questions together searches for neither (and defeats the search cache).
 */
export function searchQueryFor(input: AskInput): string {
  const q = input.query.trim();
  if (!input.lastUserQuery) return q;
  const leadsOn = /^(and|also|but|so|then|what about|how about|same)\b/i.test(q);
  const pronoun = q.split(/\s+/).length <= 10 && /\b(it|its|they|them|their|those|these|that one|this one)\b/i.test(q);
  return leadsOn || pronoun ? `${input.lastUserQuery} ${q}`.slice(0, 300) : q;
}

/** web_search with cache accounting. A provider failure is the run's failure, not an empty list. */
export async function searchWeb(run: AskRun, query: string, reason: string, opts: { subQuestion?: number; sink?: PendingStep[]; max?: number } = {}): Promise<SearchResult[]> {
  const r = await run.tool('web_search', { query, provider: env.searchProvider }, reason, () => webSearch(query, { max: opts.max ?? 6, signal: run.signal }), {
    ...opts,
    describe: (v) => ({ results: v.results.length, cached: v.cached })
  });
  if (!r.ok) {
    if (run.capHit) return [];
    throw new UpstreamError(r.error);
  }
  run.searches++;
  if (r.value.cached) run.searchesCached++;
  else run.extraCostUsd += SEARCH_USD_PER_CALL;
  return r.value.results;
}

/**
 * fetch_page over the top results, in parallel. A failed page is a visible failed step and
 * one refill round tries the next result. `claimed` keeps deep sub-questions on distinct pages.
 */
export async function fetchPages(
  run: AskRun,
  results: SearchResult[],
  query: string,
  want: number,
  opts: { maxChars: number; subQuestion?: number; sink?: PendingStep[]; claimed?: Set<string>; budget?: number }
): Promise<Material[]> {
  // Video and social pages have no readable article text to quote from.
  const unreadable = /^https?:\/\/([^/]+\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com)\//i;
  const queue = results.filter((r) => !unreadable.test(r.url) && !opts.claimed?.has(urlKey(r.url)));
  const take = (n: number) => {
    const batch = queue.splice(0, n);
    batch.forEach((r) => opts.claimed?.add(urlKey(r.url)));
    return batch;
  };
  let budget = Math.min(opts.budget ?? Infinity, run.callsLeft);
  const out: Material[] = [];
  // At most 4 fetches in a row (the A3 thrash guard, maxConsecutiveSameTool): refills top up to that, no further.
  const MAX_IN_A_ROW = 4;
  let fetched = 0;
  let round = take(Math.min(want, budget, MAX_IN_A_ROW));
  let refills = 0;
  while (round.length) {
    budget -= round.length;
    fetched += round.length;
    const got = await Promise.all(
      round.map(async (r) => ({
        r,
        res: await run.tool('fetch_page', { url: r.url }, 'read the page itself rather than the search snippet', () => fetchPage(r, run.signal), {
          subQuestion: opts.subQuestion,
          sink: opts.sink,
          describe: (v) => ({ via: v.via, chars: v.text.length })
        })
      }))
    );
    let failed = 0;
    for (const { r, res } of got) {
      const p = res.ok ? bestPassage(res.value.text, query, opts.maxChars) : null;
      if (p) out.push({ kind: 'web', title: r.title, url: r.url, snippet: p.snippet, context: p.context, subQuestion: opts.subQuestion });
      else failed++;
    }
    if (!failed || refills++ >= 1 || run.capHit || budget <= 0) break;
    round = take(Math.min(failed, budget, MAX_IN_A_ROW - fetched));
  }
  return out;
}

/** save_memory, only when the user stated something durable. */
export async function maybeSaveMemory(run: AskRun, query: string, sink?: PendingStep[]): Promise<void> {
  const ex = await extractMemory(query, run.signal);
  run.addUsage(env.llmModelPlanner, ex.usage, llmCost);
  if (!ex.text) return;
  const text = ex.text;
  const r = await run.tool('save_memory', { text }, 'the user stated a durable preference or fact about themselves', () => saveMemory(run.ctx.userId, text, run.ctx.threadId), {
    sink,
    describe: (v) => ({ id: v.id, duplicate: v.duplicate })
  });
  if (!r.ok && !run.capHit) throw new UpstreamError(r.error);
}

export function sourcesBlock(ms: Material[]): string {
  return ms
    .map((m, i) => {
      const where = m.kind === 'web' ? m.url : `${m.title}${m.locator?.page ? `, p. ${m.locator.page}` : m.locator?.heading ? `, § ${m.locator.heading}` : ''}`;
      return `[${i + 1}] ${m.title} (${where})${m.subQuestion ? ` [sub-question ${m.subQuestion}]` : ''}\n${m.context}`;
    })
    .join('\n\n');
}

/**
 * Removes any [n] the sources do not contain, while streaming. Holds back a trailing "[12"
 * until it can tell whether it is a citation. The model is told the rule; this enforces it.
 */
export class CitationFilter {
  private buf = '';
  constructor(private valid: Set<number>) {}
  private clean(s: string) {
    return s.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (_m, list: string) =>
      list
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => this.valid.has(n))
        .map((n) => `[${n}]`)
        .join('')
    );
  }
  push(t: string): string {
    this.buf += t;
    const open = this.buf.lastIndexOf('[');
    let emit = this.buf;
    if (open !== -1 && !this.buf.includes(']', open) && this.buf.length - open < 16) {
      emit = this.buf.slice(0, open);
      this.buf = this.buf.slice(open);
    } else this.buf = '';
    return this.clean(emit);
  }
  end(): string {
    const rest = this.clean(this.buf);
    this.buf = '';
    return rest;
  }
}

/** Stream the answer. If a cap fires mid-stream, keep what was written and mark it partial. */
export async function synthesize(run: AskRun, opts: { model: string; system: string; user: string; maxTokens: number; sourceCount: number }): Promise<string> {
  const filter = new CitationFilter(new Set(Array.from({ length: opts.sourceCount }, (_, i) => i + 1)));
  let text = '';
  const emit = (t: string) => {
    if (!t) return;
    text += t;
    run.token(t);
  };
  try {
    const r = await streamText({ model: opts.model, system: opts.system, messages: [{ role: 'user', content: opts.user }], maxTokens: opts.maxTokens, signal: run.signal, onText: (t) => emit(filter.push(t)) });
    emit(filter.end());
    run.addUsage(opts.model, r.usage, llmCost);
    if (r.stopReason === 'max_tokens') emit('\n\n_(Answer cut off at the output-token limit.)_');
  } catch (e) {
    if (!run.capHit) throw e;
    emit(filter.end());
    // Tokens for an aborted stream are not reported; estimate so cost is never silently zero.
    run.addUsage(opts.model, { in: Math.ceil(opts.user.length / 4), out: Math.ceil(text.length / 4) }, llmCost);
  }
  return text;
}

export function capNote(run: AskRun): string {
  if (!run.capHit) return '';
  run.terminated = 'cap';
  return `\n\n_Stopped early: this run hit its ${run.capHit} cap, so the answer above is partial and uses only what was retrieved before then._`;
}

export const memoriesBlock = (mem: { text: string }[]) =>
  mem.length ? `<user_memories>\n${mem.map((m) => `- ${m.text}`).join('\n')}\n</user_memories>\n\n` : '';

export const historyBlock = (h: string) => (h ? `<conversation_so_far>\n${h}\n</conversation_so_far>\n\n` : '');
