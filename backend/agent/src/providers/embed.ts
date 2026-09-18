import OpenAI from 'openai';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from '../env.js';
import { Lru, UpstreamError, errMsg, sha256 } from '../util.js';

const openai = new OpenAI({ apiKey: secrets.openai || undefined, maxRetries: 2, timeout: 20000 });
const cache = new Lru<number[]>(2000, 6 * 3600 * 1000);

/** Embed many texts in batches. Returns vectors in order plus billed tokens. Throws on any provider failure. */
export async function embedMany(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const vectors: number[][] = new Array(texts.length);
  const missing: number[] = [];
  texts.forEach((t, i) => {
    const hit = cache.get(sha256(t));
    if (hit) vectors[i] = hit;
    else missing.push(i);
  });
  let tokens = 0;
  for (let b = 0; b < missing.length; b += 96) {
    const idx = missing.slice(b, b + 96);
    try {
      const res = await openai.embeddings.create({ model: env.embeddingModel, input: idx.map((i) => texts[i]!) });
      tokens += res.usage?.total_tokens ?? 0;
      res.data.forEach((d, j) => {
        if (d.embedding.length !== EMBEDDING_DIMS) throw new Error(`expected ${EMBEDDING_DIMS} dims, got ${d.embedding.length}`);
        vectors[idx[j]!] = d.embedding;
        cache.set(sha256(texts[idx[j]!]!), d.embedding);
      });
    } catch (e) {
      throw new UpstreamError(`embeddings ${env.embeddingModel}: ${errMsg(e)}`);
    }
  }
  return { vectors, tokens };
}

export async function embedOne(text: string): Promise<{ vector: number[]; tokens: number }> {
  const { vectors, tokens } = await embedMany([text]);
  return { vector: vectors[0]!, tokens };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
