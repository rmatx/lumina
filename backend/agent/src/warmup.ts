import { Agent, setGlobalDispatcher } from 'undici';
import { env, secrets } from './env.js';
import { pingDb } from './db.js';
import { anthropic } from './providers/llm.js';
import { embedMany } from './providers/embed.js';
import { errMsg, log } from './util.js';

/**
 * Keep provider sockets alive between requests. Node closes an idle connection after 4 s,
 * so without this a quiet minute costs a fresh DNS lookup and TLS handshake on the next
 * answer — and that lands inside the time-to-first-token budget, where there is no room.
 */
export function poolConnections(): void {
  setGlobalDispatcher(
    new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 10 * 60_000, connections: 64 })
  );
}

/**
 * Pay the cold-start costs at boot rather than inside the first user's answer: the Atlas
 * handshake, plus one tiny call to each provider (a few thousandths of a cent) so the TLS
 * session and the SDK clients are live before anyone asks a question. A cold process
 * measured 2 649 ms to first token against a 2 500 ms target; warm it measures ~1 300 ms.
 *
 * Never fatal. A provider that is down at boot must fail loudly inside a request, with a
 * 502 and a real error string, not stop the service from starting.
 */
export async function warmUp(): Promise<void> {
  poolConnections();
  if (!env.warmup) return;
  const t0 = Date.now();
  const results = await Promise.allSettled([
    pingDb(),
    secrets.openai ? embedMany(['warmup']) : Promise.resolve(),
    // The planner model shares api.anthropic.com with the answer model, so one call warms both.
    secrets.anthropic
      ? anthropic.messages.create({
          model: env.llmModelPlanner,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'hi' }]
        })
      : Promise.resolve(),
    // A real search would spend a provider credit, so only the handshake is warmed here.
    fetch(env.searchProvider === 'serpapi' ? 'https://serpapi.com/' : 'https://api.tavily.com/', {
      signal: AbortSignal.timeout(4000)
    })
  ]);
  const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => errMsg(r.reason));
  log.info({ ms: Date.now() - t0, ...(failed.length ? { failed } : {}) }, 'warmup complete');
}
