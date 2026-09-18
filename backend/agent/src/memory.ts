import { z } from 'zod';
import { COLLECTIONS, SEARCH_INDEXES, newId } from '@lumina/contract';
import { env } from './env.js';
import { col } from './db.js';
import { cosine, embedOne } from './providers/embed.js';
import { jsonCall, type Usage } from './providers/llm.js';

export interface RecalledMemory {
  id: string;
  text: string;
  score: number;
}

/**
 * recall_memory: the user's nearest memories by meaning, at most MEMORY_TOP_K and ~1 000
 * tokens. No high similarity cutoff on purpose: a style preference ("British English") is
 * never semantically close to the question it should change, so ranking decides, not a threshold.
 */
export async function recallMemories(userId: string, vector: number[]): Promise<RecalledMemory[]> {
  const ranked = await rankMemories(userId, vector);
  const out: RecalledMemory[] = [];
  let chars = 0;
  for (const m of ranked) {
    if (chars + m.text.length > 4000) break;
    chars += m.text.length;
    out.push(m);
  }
  return out;
}

async function rankMemories(userId: string, vector: number[]): Promise<RecalledMemory[]> {
  const memories = await col(COLLECTIONS.memories);
  if (env.vectorBackend === 'mongo-cosine-scan') {
    const rows = await memories.find({ userId }, { projection: { text: 1, embedding: 1 } }).limit(500).toArray();
    return rows
      .map((r) => ({ id: String(r._id), text: r.text as string, score: cosine(vector, r.embedding as number[]) }))
      .filter((m) => m.score >= env.memoryMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, env.memoryTopK);
  }
  const rows = await memories
    .aggregate([
      { $vectorSearch: { index: SEARCH_INDEXES.memoriesVector, path: 'embedding', queryVector: vector, numCandidates: 100, limit: env.memoryTopK, filter: { userId } } },
      { $project: { text: 1, score: { $meta: 'vectorSearchScore' } } }
    ])
    .toArray();
  // Atlas cosine scores are (1 + cos) / 2; map back so the threshold means the same on both backends.
  const indexed = rows.map((r) => ({ id: String(r._id), text: r.text as string, score: 2 * (r.score as number) - 1 }));

  // The vector index is eventually consistent: a preference saved seconds ago may not be
  // searchable yet. Score the last few minutes' writes exactly, so "remember X" works in the
  // very next thread instead of after the index catches up.
  const recent = await memories
    .find({ userId, createdAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) } }, { projection: { text: 1, embedding: 1 } })
    .limit(50)
    .toArray();
  const byId = new Map(indexed.map((m) => [m.id, m]));
  for (const r of recent) {
    const id = String(r._id);
    if (!byId.has(id)) byId.set(id, { id, text: r.text as string, score: cosine(vector, r.embedding as number[]) });
  }
  return [...byId.values()]
    .filter((m) => m.score >= env.memoryMinScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, env.memoryTopK);
}

export async function saveMemory(userId: string, text: string, threadId?: string): Promise<{ id: string; duplicate: boolean; tokens: number }> {
  const { vector, tokens } = await embedOne(text);
  const near = await recallMemories(userId, vector);
  const dup = near.find((m) => m.score > 0.93);
  if (dup) return { id: dup.id, duplicate: true, tokens };
  const id = newId('mem');
  await (await col(COLLECTIONS.memories)).insertOne({ _id: id, userId, text, embedding: vector, sourceThread: threadId, createdAt: new Date() });
  return { id, duplicate: false, tokens };
}

export async function listMemories(userId: string) {
  const rows = await (await col(COLLECTIONS.memories)).find({ userId }, { projection: { embedding: 0 } }).sort({ createdAt: -1 }).toArray();
  return rows.map((r) => ({ id: String(r._id), text: r.text as string, sourceThread: r.sourceThread as string | undefined, createdAt: (r.createdAt as Date).toISOString() }));
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const res = await (await col(COLLECTIONS.memories)).deleteOne({ _id: id, userId });
  return res.deletedCount === 1;
}

/** Cheap gate before the model: only messages that look like a stated fact or preference. */
const LOOKS_DURABLE =
  /\b(remember|from now on|always|never|i prefer|i'd prefer|i like|i don't like|i hate|my name is|call me|i am a|i'm a|i work (as|at|on|in)|i build|i use|i live|my (team|company|stack|role|job))\b/i;

const Extracted = z.object({ save: z.boolean(), memory: z.string() });

/**
 * Decide whether the user stated a durable fact or preference, and phrase it as one line.
 * Returns null when there is nothing to save. A provider failure throws (fail loud).
 */
export async function extractMemory(query: string, signal?: AbortSignal): Promise<{ text: string | null; usage: Usage }> {
  if (!LOOKS_DURABLE.test(query)) return { text: null, usage: { in: 0, out: 0 } };
  const { data, usage } = await jsonCall({
    model: env.llmModelPlanner,
    maxTokens: 200,
    signal,
    system:
      'You decide whether a user message states a stable, long-lived fact about the user or a preference for how answers should be written. ' +
      'Save only durable facts/preferences (language, format, tone, their role, their stack). Do not save questions, one-off requests, or trivia. ' +
      'If saving, write the memory as one short third-person sentence starting with "User", e.g. "User prefers TypeScript code examples."',
    user: query,
    schema: {
      type: 'object',
      properties: { save: { type: 'boolean' }, memory: { type: 'string' } },
      required: ['save', 'memory'],
      additionalProperties: false
    }
  });
  const parsed = Extracted.parse(data);
  return { text: parsed.save && parsed.memory.trim() ? parsed.memory.trim() : null, usage };
}
