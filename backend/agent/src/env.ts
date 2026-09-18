import { config } from 'dotenv';
import { resolve } from 'node:path';

// The single .env at the assignment root. Provider keys are read HERE and nowhere else.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const env = {
  port: num(process.env.PORT_AGENT ?? process.env.PORT, 8000),
  mongoUri: process.env.MONGODB_URI ?? '',
  mongoDb: process.env.MONGODB_DB ?? 'lumina',
  vectorBackend: (process.env.VECTOR_BACKEND ?? 'atlas-vector-search') as
    | 'atlas-vector-search'
    | 'mongo-cosine-scan',

  llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
  llmModel: process.env.LLM_MODEL ?? 'claude-sonnet-5',
  /** The quick gear's synthesis model. Defaults to LLM_MODEL; a faster model buys TTFT. */
  llmModelQuick: process.env.LLM_MODEL_QUICK ?? process.env.LLM_MODEL ?? 'claude-sonnet-5',
  /** Planner + memory extraction: short structured outputs where latency matters most. */
  // Haiku by default: a compact plan lands in ~2.3 s vs ~4 s on Sonnet, and deep_plan_p95_ms is 4 000.
  llmModelPlanner: process.env.LLM_MODEL_PLANNER ?? 'claude-haiku-4-5',

  // Retrieval knobs live in config, not code.
  quickPagesToFetch: num(process.env.QUICK_PAGES_TO_FETCH, 3),
  deepPagesPerSubQuestion: num(process.env.DEEP_PAGES_PER_SUB_QUESTION, 3),
  deepConcurrency: num(process.env.DEEP_CONCURRENCY, 3),
  ragTopK: num(process.env.RAG_TOP_K, 5),
  ragCandidates: num(process.env.RAG_CANDIDATES, 20),
  ragRrfK: num(process.env.RAG_RRF_K, 60),
  /** Min cosine for the top doc hit before `auto` trusts the Space over the web. */
  ragAutoMinScore: num(process.env.RAG_AUTO_MIN_SCORE, 0.35),
  memoryTopK: num(process.env.MEMORY_TOP_K, 5),
  memoryMinScore: num(process.env.MEMORY_MIN_SCORE, 0),
  fetchTimeoutMs: num(process.env.FETCH_TIMEOUT_MS, 8000),
  workerInProcess: (process.env.WORKER_IN_PROCESS ?? 'true') !== 'false',
  /** Pay Atlas and provider cold-start costs at boot instead of inside the first answer. */
  warmup: (process.env.WARMUP ?? 'true') !== 'false',
  /**
   * Kill switch. ANSWERS_ENABLED=false makes /ask return 503 before any provider call, while
   * /health, /stats, /evals and the rest of the contract keep working.
   */
  answersEnabled: (process.env.ANSWERS_ENABLED ?? 'true') !== 'false',
  /**
   * Spend ceiling for one UTC day, summed across EVERY user. The deep cap is per X-User-Id,
   * which protects a user from themselves; since anyone can invent a user id, this is the only
   * limit that bounds the bill against strangers. 0 = no ceiling.
   */
  dailySpendCapUsd: num(process.env.DAILY_SPEND_CAP_USD, 0),
  /** Also write run logs to Mongo (needed for a deployed instance; export-runs reads it). */
  runsToMongo: (process.env.RUNS_TO_MONGO ?? 'true') !== 'false',

  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily') as 'tavily' | 'serpapi',
  searchCacheTtlSeconds: num(process.env.SEARCH_CACHE_TTL_SECONDS, 21600),
  /** Tavily depth. "fast" returns page text with the results in ~0.6 s; "basic" took ~1.5 s. */
  searchDepth: process.env.TAVILY_SEARCH_DEPTH ?? 'fast',

  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',

  // Deep search is the expensive gear, so its limits are configuration, not code.
  deepSubQuestionsMin: num(process.env.DEEP_SUB_QUESTIONS_MIN, 3),
  deepSubQuestionsMax: num(process.env.DEEP_SUB_QUESTIONS_MAX, 6),
  deepDailyCap: num(process.env.DEEP_DAILY_CAP, 5),

  // The hard caps from AGENTS.md. Raising these to make a gate pass is the failure mode
  // the caps exist to catch. Two gears, two envelopes.
  maxToolCalls: num(process.env.MAX_TOOL_CALLS, 8),
  maxWallClockSec: num(process.env.MAX_WALL_CLOCK_SEC, 90),
  maxToolCallsDeep: num(process.env.MAX_TOOL_CALLS_DEEP, 24),
  maxWallClockSecDeep: num(process.env.MAX_WALL_CLOCK_SEC_DEEP, 240),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Where the per-answer run logs land. quality/check.mjs reads this folder. */
  runsDir: resolve(process.cwd(), '../../runs')
} as const;

/** Never log or return these. /health names the model; it never echoes a key. */
export const secrets = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  openai: process.env.OPENAI_API_KEY ?? '',
  tavily: process.env.TAVILY_API_KEY ?? '',
  serpapi: process.env.SERPAPI_API_KEY ?? ''
} as const;
