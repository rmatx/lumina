/**
 * The jobs worker: its own process (forked by index.ts, or `npm run worker`), so parsing a
 * 60-page PDF never stalls the thread streaming someone's answer.
 *
 * index_document → GridFS read → parse (page-aware) → chunk → embed → insert chunks →
 *                  READ-YOUR-WRITE PROBE → status: 'indexed'
 *
 * Claims are atomic. A heartbeat keeps claimedAt fresh; a sweeper returns a job whose
 * claimedAt went stale (a killed worker) to `pending`. `job.stage` records finished stages so
 * a retried job does not re-embed a document it already embedded.
 */
import { GridFSBucket, ObjectId } from 'mongodb';
import { COLLECTIONS, GRIDFS_BUCKETS, SEARCH_INDEXES } from '@lumina/contract';
import { env } from './env.js';
import { col, db } from './db.js';
import { chunkPdfPages, chunkText, parsePdf } from './chunking.js';
import { embedMany } from './providers/embed.js';
import { errMsg, log } from './util.js';

const workerId = `wkr_${process.pid}_${Date.now().toString(36)}`;
const STALE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setDoc(docId: string, patch: Record<string, unknown>) {
  await (await col(COLLECTIONS.documents)).updateOne({ _id: docId }, { $set: patch });
}

async function readFile(fileId: string): Promise<Buffer> {
  const bucket = new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
  const parts: Buffer[] = [];
  for await (const chunk of bucket.openDownloadStream(new ObjectId(fileId))) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function embedStage(jobId: string, doc: Record<string, unknown>) {
  const docId = String(doc._id);
  await setDoc(docId, { status: 'parsing', pct: 10 });
  const buf = await readFile(String(doc.fileId));
  const isPdf = doc.mimeType === 'application/pdf' || String(doc.title).toLowerCase().endsWith('.pdf');

  let chunks;
  let pages: number | undefined;
  if (isPdf) {
    const texts = await parsePdf(buf);
    pages = texts.length;
    chunks = chunkPdfPages(texts);
  } else {
    chunks = chunkText(buf.toString('utf8'), String(doc.title));
  }
  if (!chunks.length) throw new Error('no extractable text in the document');

  await setDoc(docId, { status: 'embedding', pct: 30, ...(pages ? { pages } : {}) });
  const chunksCol = await col(COLLECTIONS.chunks);
  await chunksCol.deleteMany({ docId }); // idempotent: a re-run replaces, never duplicates

  const BATCH = 64;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const { vectors } = await embedMany(batch.map((c) => c.text));
    await chunksCol.insertMany(
      batch.map((c, j) => ({
        _id: `${docId}:${i + j}`,
        docId,
        spaceId: doc.spaceId,
        userId: doc.userId,
        text: c.text,
        locator: c.locator,
        ord: i + j,
        embedding: vectors[j],
        createdAt: new Date()
      }))
    );
    await setDoc(docId, { pct: Math.round(30 + (50 * Math.min(chunks.length, i + BATCH)) / chunks.length) });
  }
  await (await col(COLLECTIONS.jobs)).updateOne({ _id: jobId }, { $set: { stage: 'embedded', chunks: chunks.length } });
  return chunks.length;
}

/** "Upserted" is not "searchable": wait until the vector index returns one of this document's chunks. */
async function probe(doc: Record<string, unknown>): Promise<void> {
  const docId = String(doc._id);
  await setDoc(docId, { pct: 90 });
  const chunksCol = await col(COLLECTIONS.chunks);
  const first = await chunksCol.findOne({ docId }, { sort: { ord: 1 } });
  if (!first) throw new Error('probe: no chunks were written');
  if (env.vectorBackend === 'mongo-cosine-scan') return; // an exact scan reads its own writes

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const hits = await chunksCol
      .aggregate([
        { $vectorSearch: { index: SEARCH_INDEXES.chunksVector, path: 'embedding', queryVector: first.embedding, numCandidates: 50, limit: 5, filter: { spaceId: doc.spaceId } } },
        { $project: { docId: 1 } }
      ])
      .toArray();
    if (hits.some((h) => h.docId === docId)) return;
    await sleep(1500);
  }
  throw new Error('probe: vector index never returned the document’s chunks (is chunks_vector queryable?)');
}

async function runJob(job: Record<string, unknown>) {
  const jobs = await col(COLLECTIONS.jobs);
  const docId = String((job.payload as { docId: string }).docId);
  const heartbeat = setInterval(() => void jobs.updateOne({ _id: job._id, workerId }, { $set: { claimedAt: new Date() } }), 20000);
  try {
    const doc = await (await col(COLLECTIONS.documents)).findOne({ _id: docId });
    if (!doc) throw new Error(`document ${docId} no longer exists`);
    let chunks = job.chunks as number | undefined;
    if (job.stage !== 'embedded') chunks = await embedStage(String(job._id), doc);
    else log.info({ docId }, 'embed stage already done; resuming at probe');
    await probe(doc);
    await setDoc(docId, { status: 'indexed', pct: 100, chunks });
    await jobs.updateOne({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date() }, $unset: { error: '' } });
    log.info({ docId, chunks, workerId }, 'document indexed');
  } catch (e) {
    const error = errMsg(e);
    const attempts = Number(job.attempts ?? 1);
    const final = attempts >= MAX_ATTEMPTS;
    await jobs.updateOne({ _id: job._id }, { $set: { status: final ? 'failed' : 'pending', error }, $unset: { claimedAt: '', workerId: '' } });
    if (final) await setDoc(docId, { status: 'failed', error });
    log.error({ docId, attempts, error }, final ? 'indexing failed' : 'indexing attempt failed; will retry');
  } finally {
    clearInterval(heartbeat);
  }
}

async function sweep() {
  const res = await (await col(COLLECTIONS.jobs)).updateMany(
    { status: 'running', claimedAt: { $lt: new Date(Date.now() - STALE_MS) } },
    { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
  );
  if (res.modifiedCount) log.warn({ count: res.modifiedCount }, 'swept stale jobs back to pending');
}

async function main(): Promise<void> {
  // Embedding a long document is many calls to one host: pool the sockets here too.
  (await import('./warmup.js')).poolConnections();
  log.info({ workerId }, 'jobs worker up');
  process.on('disconnect', () => process.exit(0)); // parent agent went away
  let lastSweep = 0;
  for (;;) {
    try {
      if (Date.now() - lastSweep > 30000) {
        await sweep();
        lastSweep = Date.now();
      }
      const job = await (await col(COLLECTIONS.jobs)).findOneAndUpdate(
        { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
        { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' }
      );
      if (job) await runJob(job);
      else await sleep(500);
    } catch (e) {
      log.error({ err: errMsg(e) }, 'worker loop error');
      await sleep(3000);
    }
  }
}

void main();
