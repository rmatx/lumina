/**
 * The deep gear (Pro Search): plan_research → stream `plan` → research each sub-question in
 * parallel (bounded) → merge into one citation numbering → structured synthesis.
 * Every retrieval step and every source carries the sub-question it served.
 */
import { z } from 'zod';
import { PlanEvent } from '@lumina/contract';
import { env } from './env.js';
import type { AskRun, PendingStep } from './run.js';
import { recallMemories } from './memory.js';
import { searchDocuments } from './rag.js';
import { llmCost, textCall } from './providers/llm.js';
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

/**
 * A compact line format rather than JSON structured output: in our probes it halved the
 * planner's wall clock (fewer tokens, no grammar warm-up), and the plan is deep's first paint.
 */
const PLANNER = `You plan research for a multi-part question, the way a careful analyst would before searching.
Break it into ${env.deepSubQuestionsMin}-${env.deepSubQuestionsMax} sub-questions (usually 4) that together answer it.
- Each covers a DIFFERENT facet: never restate the original question; no overlap between sub-questions.
- Each is specific, at most 16 words, and answerable from public web sources.
Output exactly this format and nothing else:
PLAN: <one sentence on how you split the question>
1. <sub-question> || <why it matters, at most 10 words>
2. <sub-question> || <why it matters, at most 10 words>`;

const SubLine = z.object({ question: z.string().min(3).max(400), reason: z.string().max(400) });

const SYNTH = `You are LUMINA in deep-research mode. Write a structured answer in Markdown using ONLY the numbered sources.
Format exactly:
**Short answer:** 2-4 sentences that directly answer the question.
Then one "### " section per sub-question, in plan order, with a concise heading. 2-5 sentences or bullets each, with the specifics the sources give (numbers, names, trade-offs).
Finish with "### What's still unknown": the concrete gaps, conflicts between sources, or things the sources did not establish. No boilerplate.
Rules: put [n] right after each claim it supports; cite only numbers listed in <sources>; never invent a source. If a sub-question's sources are thin, say so in that section. No padding, no repetition across sections. Follow <user_memories> preferences when they apply.`;

/** Tolerates "1." / "1)" / "**1.**" / "- 1." numbering and "||" or a dash as the reason separator. */
function parsePlan(text: string) {
  const reason = /^\W*PLAN\W*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim();
  const subs = text
    .split('\n')
    .map((l) => /^\s*(?:[-*]\s*)?\**\s*\d+\s*[.):]\**\s*(.+?)\s*$/.exec(l)?.[1])
    .filter((l): l is string => Boolean(l))
    .map((l) => {
      const [q, why] = l.split(/\s*\|\|\s*|\s+[—–]\s+/);
      return SubLine.parse({ question: q!.replace(/\*+/g, '').trim(), reason: (why ?? '').replace(/\*+/g, '').trim() });
    })
    .slice(0, env.deepSubQuestionsMax);
  return { reason, subs };
}

async function plan(run: AskRun, input: AskInput) {
  let last = '';
  // A second attempt covers a one-off format slip; a provider exception is not retried here.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, usage } = await textCall({
      model: env.llmModelPlanner,
      maxTokens: 600,
      signal: run.signal,
      system: PLANNER,
      // Earlier questions only: prior answers in the prompt make the planner imitate an answer
      // ("**Short answer:** …") instead of writing a plan. The cap probe caught exactly that.
      user:
        (input.priorQuestions.length ? `Earlier questions in this conversation:\n${input.priorQuestions.map((q) => `- ${q}`).join('\n')}\n\n` : '') +
        `Question to plan: ${input.query}\n\nReply with only the PLAN line and the numbered sub-questions.`
    });
    run.addUsage(env.llmModelPlanner, usage, llmCost);
    const { reason, subs } = parsePlan(text);
    if (subs.length >= env.deepSubQuestionsMin) {
      return { reason, subQuestions: subs.map((s, i) => ({ i: i + 1, question: s.question, ...(s.reason ? { reason: s.reason } : {}) })) };
    }
    last = text;
  }
  throw new Error(
    `planner returned fewer than ${env.deepSubQuestionsMin} usable sub-questions twice; last output: ${JSON.stringify(last.slice(0, 300))}`
  );
}

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

  const planned = await run.tool('plan_research', { question: query, model: env.llmModelPlanner }, 'deep search: decompose the question before retrieving anything', () => plan(run, input), {
    sink: head,
    describe: (p) => ({ subQuestions: p.subQuestions.length })
  });
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
