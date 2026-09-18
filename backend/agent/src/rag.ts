import { COLLECTIONS, SEARCH_INDEXES } from '@lumina/contract';
import { env } from './env.js';
import { col } from './db.js';
import { cosine } from './providers/embed.js';
import { terms } from './snippets.js';

export interface DocHit {
  chunkId: string;
  docId: string;
  title: string;
  /** The best-ranked chunk: the citation snippet. */
  text: string;
  /** Every retrieved chunk sharing this citation locator, in document order: what the model reads. */
  context: string;
  locator: { page?: number; heading?: string; line?: number };
  /** Cosine similarity of the best vector hit (0 when found by text only). */
  vecScore: number;
  rrf: number;
}

interface Row {
  _id: string;
  docId: string;
  text: string;
  locator: DocHit['locator'];
  score?: number;
}

async function vectorLeg(spaceId: string, vector: number[]): Promise<Row[]> {
  const chunks = await col(COLLECTIONS.chunks);
  if (env.vectorBackend === 'mongo-cosine-scan') {
    const rows = await chunks.find({ spaceId }, { projection: { docId: 1, text: 1, locator: 1, embedding: 1 } }).limit(5000).toArray();
    return rows
      .map((r) => ({ _id: String(r._id), docId: r.docId, text: r.text, locator: r.locator, score: cosine(vector, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, env.ragCandidates);
  }
  // The spaceId filter lives INSIDE $vectorSearch: a later $match would drop hits after the limit.
  const rows = await chunks
    .aggregate([
      { $vectorSearch: { index: SEARCH_INDEXES.chunksVector, path: 'embedding', queryVector: vector, numCandidates: Math.max(100, env.ragCandidates * 10), limit: env.ragCandidates, filter: { spaceId } } },
      { $project: { docId: 1, text: 1, locator: 1, score: { $meta: 'vectorSearchScore' } } }
    ])
    .toArray();
  return rows.map((r) => ({ ...(r as Row), _id: String(r._id), score: 2 * (r.score as number) - 1 }));
}

async function textLeg(spaceId: string, query: string): Promise<Row[]> {
  const chunks = await col(COLLECTIONS.chunks);
  if (env.vectorBackend === 'mongo-cosine-scan') {
    const qTerms = terms(query);
    if (!qTerms.length) return [];
    const rows = await chunks.find({ spaceId }, { projection: { docId: 1, text: 1, locator: 1 } }).limit(5000).toArray();
    return rows
      .map((r) => {
        const lower = String(r.text).toLowerCase();
        return { _id: String(r._id), docId: r.docId, text: r.text, locator: r.locator, score: qTerms.filter((t) => lower.includes(t)).length };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, env.ragCandidates);
  }
  const rows = await chunks
    .aggregate([
      {
        $search: {
          index: SEARCH_INDEXES.chunksText,
          compound: { must: [{ text: { query, path: 'text' } }], filter: [{ equals: { path: 'spaceId', value: spaceId } }] }
        }
      },
      { $limit: env.ragCandidates },
      { $project: { docId: 1, text: 1, locator: 1 } }
    ])
    .toArray();
  return rows.map((r) => ({ ...(r as Row), _id: String(r._id) }));
}

/**
 * search_documents: dense + BM25, fused with reciprocal rank fusion, grouped to one hit per
 * (docId, locator) so every citation is unique and carries all of that locator's chunks. No re-ranker: see DESIGN.md trade-off 4.
 */
export async function searchDocuments(spaceId: string, query: string, vector: number[], k = env.ragTopK): Promise<DocHit[]> {
  const [vec, txt] = await Promise.all([vectorLeg(spaceId, vector), textLeg(spaceId, query)]);
  const fused = new Map<string, { row: Row; rrf: number; vecScore: number }>();
  const add = (rows: Row[], isVec: boolean) =>
    rows.forEach((row, rank) => {
      const cur = fused.get(row._id) ?? { row, rrf: 0, vecScore: 0 };
      cur.rrf += 1 / (env.ragRrfK + rank + 1);
      if (isVec) cur.vecScore = row.score ?? 0;
      fused.set(row._id, cur);
    });
  add(vec, true);
  add(txt, false);

  // Group by citation identity rather than dropping lower-ranked chunks: a PDF page split into
  // three chunks is one citation, and the model must read every retrieved chunk of that page.
  const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf);
  const groups = new Map<string, { best: (typeof ranked)[number]; texts: { ord: number; text: string }[] }>();
  for (const h of ranked) {
    const key = `${h.row.docId}:${h.row.locator?.page ?? ''}:${h.row.locator?.heading ?? ''}:${h.row.locator?.line ?? ''}`;
    const g = groups.get(key);
    const ord = Number(String(h.row._id).split(':').pop()) || 0;
    if (g) g.texts.push({ ord, text: h.row.text });
    else if (groups.size < k) groups.set(key, { best: h, texts: [{ ord, text: h.row.text }] });
  }
  const top = [...groups.values()];
  if (!top.length) return [];

  const docs = await (await col(COLLECTIONS.documents)).find({ _id: { $in: [...new Set(top.map((g) => g.best.row.docId))] } }, { projection: { title: 1 } }).toArray();
  const titles = new Map(docs.map((d) => [String(d._id), d.title as string]));
  return top.map(({ best: h, texts }) => ({
    chunkId: h.row._id,
    docId: h.row.docId,
    title: titles.get(h.row.docId) ?? h.row.docId,
    text: h.row.text,
    context: texts.sort((a, b) => a.ord - b.ord).map((t) => t.text).join('\n'),
    locator: h.row.locator,
    vecScore: h.vecScore,
    rrf: h.rrf
  }));
}
