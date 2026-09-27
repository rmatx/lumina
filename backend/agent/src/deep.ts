/**
 * The deep gear (Pro Search): plan_research → stream `plan` → research each sub-question in
 * parallel (bounded) → merge into one citation numbering → structured synthesis.
 * Every retrieval step and every source carries the sub-question it served.
 */
import { PlanEvent } from '@lumina/contract';
import { env } from './env.js';
import type { AskRun, PendingStep } from './run.js';
import { recallMemories } from './memory.js';
import { planResearch } from './planner.js';
import { searchDocuments } from './rag.js';
import { llmCost } from './providers/llm.js';
import {
  capNote,
  docMaterial,
  embedQuery,
  fetchPages,
  historyBlock,
  materialKey,
  maybeSaveMemory,
  memoriesBlock,
  searchWeb,
  sourcesBlock,
  synthesize,
  toSources,
  type AnswerOut,
  type AskInput,
  type Material
} from './compose.js';
import { UpstreamError, mapLimit } from './util.js';

// Plain text on purpose: the provided UI renders the answer exactly as written and does not
// render Markdown, so "###" and "**" reached readers as literal symbols.
const SYNTH = `You are LUMINA in deep-research mode. Write a structured answer in PLAIN TEXT using ONLY the numbered sources. The reader's screen shows your text exactly as written and does not render Markdown, so never use #, *, ** or any other Markdown syntax.
Format exactly:
Short answer: 2-4 sentences that directly answer the question.
Then one section per sub-question, in plan order: a short heading in plain words on its own line, then 2-5 sentences or "- " bullet lines with the specifics the sources give (numbers, names, trade-offs).
Finish with a section headed exactly "What's still unknown" on its own line: the concrete gaps, conflicts between sources, or things the sources did not establish. No boilerplate.
Separate sections with one blank line.
Rules: put [n] right after each claim it supports; cite only numbers listed in <sources>; never invent a source. If a sub-question's sources are thin, say so in that section. No padding, no repetition across sections. Follow <user_memories> preferences when they apply.`;

export async function runDeep(run: AskRun, input: AskInput): Promise<AnswerOut> {
  const { query, mode, spaceId } = input;
  const head: PendingStep[] = [];

  const vector = embedQuery(run, query);
  vector.catch(() => undefined);
  const memP = run.tool('recall_memory', { query }, 'check what this user asked LUMINA to remember before researching', async () => recallMemories(run.ctx.userId, await vector), {
    sink: head,
    describe: (m) => ({ returned: m.length, memories: m.map((x) => x.text) })
  });
  const saveP = maybeSaveMemory(run, query, head);
  saveP.catch(() => undefined);

  const planned = await run.tool(
    'plan_research',
    { question: query, model: env.llmModelPlanner },
    'deep search: decompose the question before retrieving anything',
    () => planResearch({ query, priorQuestions: input.priorQuestions, signal: run.signal, onUsage: (u) => run.addUsage(env.llmModelPlanner, u, llmCost) }),
    {
      sink: head,
      // unanchored > 0 means a sub-question still did not name the subject after the retry
      describe: (p) => ({ subQuestions: p.subQuestions.length, attempts: p.attempts, unanchored: p.unanchored, ...(p.retried ? { retried: p.retried } : {}) })
    }
  );
  if (!planned.ok) throw new UpstreamError(`plan_research: ${planned.error}`);
  const subs = planned.value.subQuestions;

  // The plan is deep search's first paint, and it goes out before any retrieval exists.
  run.send('plan', PlanEvent.parse({ ...(planned.value.reason ? { reason: planned.value.reason } : {}), subQuestions: subs }));
  run.commit();

  const mem = await memP;
  if (!mem.ok && !run.capHit) throw new UpstreamError(mem.error);
  await saveP;
  run.flush(head);

  const useDocs = Boolean(spaceId) && mode !== 'web';
  const useWeb = mode !== 'docs';
  const perSub = Math.max(2, Math.floor(run.callsLeft / subs.length));
  const pagesPer = Math.max(1, Math.min(env.deepPagesPerSubQuestion, perSub - 1 - (useDocs && useWeb ? 1 : 0)));
  const claimed = new Set<string>();
  const found: Material[][] = subs.map(() => []);

  await mapLimit(subs, env.deepConcurrency, async (sq, idx) => {
    const sink: PendingStep[] = [];
    let used = 0;
    if (useDocs) {
      used++;
      const r = await run.tool('search_documents', { spaceId, query: sq.question }, `sub-question ${sq.i}: look in the Space`, async () => searchDocuments(spaceId!, sq.question, await embedQuery(run, sq.question), 3), {
        subQuestion: sq.i,
        sink,
        describe: (hits) => ({ hits: hits.length, topScore: Number((hits[0]?.vecScore ?? 0).toFixed(3)) })
      });
      if (!r.ok && !run.capHit) throw new UpstreamError(r.error);
      if (r.ok) found[idx]!.push(...r.value.filter((h) => mode === 'docs' || h.vecScore >= env.ragAutoMinScore).map((h) => docMaterial(h, sq.i)));
    }
    if (useWeb) {
      used++;
      const results = await searchWeb(run, sq.question, `sub-question ${sq.i}: ${sq.reason}`, { subQuestion: sq.i, sink, max: 8 });
      found[idx]!.push(...(await fetchPages(run, results, sq.question, pagesPer, { maxChars: 1100, subQuestion: sq.i, sink, claimed, budget: perSub - used })));
    }
    run.flush(sink); // this sub-question's steps land together in the trace
  });

  // One numbering: dedupe by url / docId+locator, first sub-question to find a source keeps it.
  const seen = new Set<string>();
  const merged: Material[] = [];
  for (const list of found)
    for (const m of list) {
      const k = materialKey(m);
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(m);
      }
    }

  const sources = toSources(merged);
  run.send('sources', sources);
  const model = env.llmModel;

  if (!merged.length) {
    const text = `I researched ${subs.length} sub-questions but could not retrieve any readable sources, so I have nothing to cite.` + capNote(run);
    run.token(text);
    return { text, sources, model, subQuestions: subs };
  }

  let text = await synthesize(run, {
    model,
    system: SYNTH,
    maxTokens: 3000,
    sourceCount: merged.length,
    user:
      `${memoriesBlock(mem.ok ? mem.value : [])}${historyBlock(input.history)}` +
      `<plan>\n${subs.map((s) => `${s.i}. ${s.question}`).join('\n')}\n</plan>\n\n<sources>\n${sourcesBlock(merged)}\n</sources>\n\nQuestion: ${query}`
  });
  const note = capNote(run);
  if (note) {
    run.token(note);
    text += note;
  }
  return { text, sources, model, subQuestions: subs };
}
