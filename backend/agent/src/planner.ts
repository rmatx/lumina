/**
 * plan_research: decompose a deep question into sub-questions that each retrieve well.
 *
 * Why this module is strict about wording: reading trajectory req_17aba78683204542 showed a
 * sub-question ("implementation costs and operational complexity") that never named the
 * subject, so web search returned generic operations-management pages and that section of the
 * answer was vague. Each sub-question is sent to the search engine alone, without the original
 * question, so it has to carry the subject itself. The prompt says so, and `unanchored` checks
 * it: a plan whose sub-questions drop the subject gets one corrective retry.
 */
import { z } from 'zod';
import { env } from './env.js';
import { textCall, type Usage } from './providers/llm.js';

/**
 * A compact line format rather than JSON structured output: in our probes it halved the
 * planner's wall clock (fewer tokens, no grammar warm-up), and the plan is deep's first paint.
 */
export const PLANNER = `You plan research for a multi-part question, the way a careful analyst would before searching.
Break it into ${env.deepSubQuestionsMin}-${env.deepSubQuestionsMax} sub-questions (usually 4) that together answer it.
Each sub-question is sent to a web search engine ON ITS OWN, without the original question, so:
- Name the subject in every sub-question: the specific product, technology, organisation, place or period the question is about. Never "it", "this", "they", "the system", and never a bare topic.
- Ask for something a web page can state: a figure, a documented limit, a named comparison, a procedure, a date. Not an opinion.
- Keep the question's own qualifiers (scale, version, region, time frame) where they matter.
- Each covers a DIFFERENT facet: never restate the original question; no overlap between sub-questions.
- At most 18 words each.
- If the question refers back to an earlier question ("it", "that option"), resolve the reference and name the subject.
Example for "Should our team switch from Jira to Linear?":
  bad:  Migration costs and team adoption || effort matters
  good: How long does migrating issues and workflows from Jira to Linear take for a mid-size team? || switching cost
Output exactly this format and nothing else:
PLAN: <one sentence on how you split the question>
1. <sub-question> || <why it matters, at most 10 words>
2. <sub-question> || <why it matters, at most 10 words>`;

const SubLine = z.object({ question: z.string().min(3).max(400), reason: z.string().max(400) });

/** Tolerates "1." / "1)" / "**1.**" / "- 1." numbering and "||" or a dash as the reason separator. */
export function parsePlan(text: string) {
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

// Words that say how a question is asked, not what it is about. A sub-question sharing only
// these with the original has not named the subject.
const GENERIC = new Set(
  (
    'the and for with from into onto off our your their its this that these those what which who whom whose when where why how ' +
    'should would could can does did doing done are was were been being have has had will shall may might must ' +
    'we you they them him her his she he it us me my mine a an of to in on at by as or if is be do not no yes ' +
    'about over under than then there here also just only more most less least much many some any all each every ' +
    'compare comparison versus between difference differences better best good worse worst pros cons tradeoff tradeoffs trade-offs ' +
    'use using used work works working way ways need needs want wants make makes get gets move moving switch switching ' +
    'worth really actually still today now currently vs question questions'
  ).split(' ')
);

const stem = (w: string) => w.replace(/(?:ies)$/, 'y').replace(/(?:es|s|ing|ed)$/, '');

/** The words that carry a question's subject: acronyms and alphanumerics (RAG, k1) count even when short. */
export function anchorTerms(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts)
    for (const raw of t.match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? []) {
      const w = raw.toLowerCase().replace(/[.-]+$/, '');
      const salient = w.length >= 3 || /\d/.test(w) || /^[A-Z]{2,}$/.test(raw);
      if (salient && !GENERIC.has(w)) out.add(stem(w));
    }
  return out;
}

/** Sub-questions that share no subject word with the question (or the earlier questions it refers to). */
export function unanchored(subQuestions: string[], anchors: Set<string>): string[] {
  return subQuestions.filter((q) => ![...anchorTerms(q)].some((w) => anchors.has(w)));
}

export interface Plan {
  reason?: string;
  subQuestions: { i: number; question: string; reason?: string }[];
  /** Sub-questions that still did not name the subject after the corrective retry; reported in the trace. */
  unanchored: number;
  attempts: number;
  /** Why attempt 2 ran, so a slow plan can be explained from the trace alone. */
  retried?: 'format' | 'unanchored';
}

export async function planResearch(opts: {
  query: string;
  priorQuestions: string[];
  signal?: AbortSignal;
  onUsage: (usage: Usage) => void;
}): Promise<Plan> {
  const anchors = anchorTerms(opts.query, ...opts.priorQuestions);
  const context = opts.priorQuestions.length
    ? `Earlier questions in this conversation:\n${opts.priorQuestions.map((q) => `- ${q}`).join('\n')}\n\n`
    : '';
  let feedback = '';
  let last = '';
  let best: Plan | undefined;
  let retried: Plan['retried'];

  // Attempt 2 covers a format slip or a plan whose sub-questions dropped the subject. A provider
  // exception is not retried here: textCall throws it and the run ends with a 502.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, usage } = await textCall({
      model: env.llmModelPlanner,
      maxTokens: 700,
      signal: opts.signal,
      system: PLANNER,
      // Earlier questions only: prior answers in the prompt make the planner imitate an answer
      // ("**Short answer:** …") instead of writing a plan. The cap probe caught exactly that.
      user: `${context}Question to plan: ${opts.query}\n\n${feedback}Reply with only the PLAN line and the numbered sub-questions.`
    });
    opts.onUsage(usage);
    last = text;
    const { reason, subs } = parsePlan(text);
    if (subs.length < env.deepSubQuestionsMin) {
      feedback = `Your previous reply was not in the required format. `;
      retried = 'format';
      continue;
    }
    const vague = unanchored(
      subs.map((s) => s.question),
      anchors
    );
    const plan: Plan = {
      ...(reason ? { reason } : {}),
      subQuestions: subs.map((s, i) => ({ i: i + 1, question: s.question, ...(s.reason ? { reason: s.reason } : {}) })),
      unanchored: vague.length,
      attempts: attempt,
      ...(retried ? { retried } : {})
    };
    if (!best || plan.unanchored < best.unanchored) best = plan;
    if (!vague.length) return plan;
    retried = 'unanchored';
    feedback =
      `A previous plan had sub-questions that do not name the subject, so a search engine would return generic pages:\n` +
      vague.map((q) => `- ${q}`).join('\n') +
      `\nRewrite the plan so every sub-question names what the question is about.\n\n`;
  }
  if (best) return { ...best, attempts: 2, ...(retried ? { retried } : {}) }; // a usable plan whose weak spots are counted in the trace, not hidden
  throw new Error(
    `planner returned fewer than ${env.deepSubQuestionsMin} usable sub-questions twice; last output: ${JSON.stringify(last.slice(0, 300))}`
  );
}
