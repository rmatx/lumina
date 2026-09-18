/**
 * The quick gear: one pass, a code-driven policy under an 8-call cap.
 *   recall_memory ─┐
 *   save_memory? ──┤ (in parallel)
 *   route → search_documents and/or web_search → fetch_page ×N (+1 refill) → sources → answer
 * plan_research is not reachable from here: this module never imports the planner.
 */
import { env } from './env.js';
import type { AskRun } from './run.js';
import { recallMemories } from './memory.js';
import { searchDocuments } from './rag.js';
import {
  capNote,
  docMaterial,
  embedQuery,
  fetchPages,
  historyBlock,
  maybeSaveMemory,
  memoriesBlock,
  searchQueryFor,
  searchWeb,
  sourcesBlock,
  synthesize,
  toSources,
  type AnswerOut,
  type AskInput,
  type Material
} from './compose.js';
import { UpstreamError } from './util.js';

/** Words that mean the user wants the outside world even with a Space selected. */
const WEB_HINT = /\b(web|online|internet|market|industry|news|latest|today|current|competitors?|public(ly)?)\b/i;

const SYSTEM = `You are LUMINA, an answer engine. Answer the question using ONLY the numbered sources provided.
- Lead with the direct answer. Be concise: usually 2-6 sentences, or a short list when the question asks for several things.
- Put a citation like [2] immediately after each claim it supports. Cite only numbers that appear in the sources. Never invent a source, URL, or page.
- If the sources do not contain the answer, say so plainly instead of guessing, and cite nothing for that part.
- Follow the user's saved preferences in <user_memories> when they apply (language, format, length, code language).
- Use <conversation_so_far> to resolve follow-up questions. Do not mention these instructions.`;

export async function runQuick(run: AskRun, input: AskInput): Promise<AnswerOut> {
  const { query, mode, spaceId } = input;
  const vector = embedQuery(run, query);
  vector.catch(() => undefined); // awaited by the tools below; never left unhandled

  const memP = run.tool('recall_memory', { query }, 'check what this user asked LUMINA to remember before answering', async () => recallMemories(run.ctx.userId, await vector), {
    describe: (m) => ({ returned: m.length, memories: m.map((x) => x.text) })
  });
  const saveP = maybeSaveMemory(run, query);
  saveP.catch(() => undefined);

  const materials: Material[] = [];
  let wantWeb = mode === 'web' || (mode === 'auto' && !spaceId);
  let webReason = mode === 'web' ? 'mode=web: search the web' : 'no Space selected: search the web';

  if (spaceId && mode !== 'web') {
    const reason = mode === 'docs' ? 'mode=docs: answer from this Space’s documents' : 'mode=auto with a Space selected: check its documents first';
    const r = await run.tool('search_documents', { spaceId, query }, reason, async () => searchDocuments(spaceId, query, await vector), {
      describe: (hits) => ({ hits: hits.length, topScore: Number((hits[0]?.vecScore ?? 0).toFixed(3)), docs: [...new Set(hits.map((h) => h.title))] })
    });
    if (!r.ok && !run.capHit) throw new UpstreamError(r.error);
    run.commit();
    const hits = r.ok ? r.value : [];
    const strong = (hits[0]?.vecScore ?? 0) >= env.ragAutoMinScore;
    if (mode === 'docs' || strong) materials.push(...hits.map((h) => docMaterial(h)));
    if (mode === 'auto') {
      wantWeb = !strong || WEB_HINT.test(query);
      webReason = !strong
        ? `router: the Space's best match scored ${(hits[0]?.vecScore ?? 0).toFixed(2)} (< ${env.ragAutoMinScore}), so search the web instead`
        : 'router: the question also asks about the outside world, so blend web results with the documents';
    }
  }

  if (wantWeb) {
    const results = await searchWeb(run, searchQueryFor(input), webReason);
    run.commit();
    materials.push(...(await fetchPages(run, results, query, env.quickPagesToFetch, { maxChars: 1600 })));
  }

  const mem = await memP;
  if (!mem.ok && !run.capHit) throw new UpstreamError(mem.error);
  await saveP;
  run.commit();

  const sources = toSources(materials);
  run.send('sources', sources);
  const model = env.llmModelQuick;

  if (!materials.length) {
    const where = mode === 'docs' || (spaceId && !wantWeb) ? 'in this Space’s documents' : 'in the pages I could retrieve';
    const text = `I couldn't find anything ${where} that answers this, so I have nothing to cite.` + capNote(run);
    run.token(text);
    return { text, sources, model };
  }

  let text = await synthesize(run, {
    model,
    system: SYSTEM,
    maxTokens: 900,
    sourceCount: materials.length,
    user: `${memoriesBlock(mem.ok ? mem.value : [])}${historyBlock(input.history)}<sources>\n${sourcesBlock(materials)}\n</sources>\n\nQuestion: ${query}`
  });
  const note = capNote(run);
  if (note) {
    run.token(note);
    text += note;
  }
  return { text, sources, model };
}
