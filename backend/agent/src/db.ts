import { MongoClient, type Collection, type Db } from 'mongodb';
import { env } from './env.js';

let client: MongoClient | null = null;

/** One client per process. The driver pools connections; do not open one per request. */
export async function db(): Promise<Db> {
  if (!env.mongoUri) throw new Error('MONGODB_URI is not set — copy .env.example to .env');
  if (!client) {
    client = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
  }
  return client.db(env.mongoDb);
}

/** Loosely typed collection handle; documents are validated against the contract where it matters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function col(name: string): Promise<Collection<any>> {
  return (await db()).collection(name);
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
}

export async function pingDb(): Promise<'ok' | 'down'> {
  try {
    await (await db()).command({ ping: 1 });
    return 'ok';
  } catch {
    return 'down';
  }
}
