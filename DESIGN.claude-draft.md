# DESIGN.md — LUMINA

## Components

Five things run, and three more carry state.

- **Web UI** (`web/`, provided). React + Vite, served by the gateway in production (and by Vercel). It only ever calls the gateway.
- **Gateway** (`backend/gateway`, Express, :8787). The public edge.
- **Agent service** (`backend/agent`, Express, :8000, private). The answer loop (quick and deep gears), the tools, memory, retrieval, `/stats`, and the deep-search spend gate.
- **Jobs worker** (`backend/agent/src/worker.ts`). A separate Node process, forked and supervised by the agent service (or run on its own with `npm run worker`). It indexes documents.
- **MongoDB Atlas.** One cluster for everything: threads, messages, memories (vector index), spaces, documents, chunks (vector + text index), `searchCache` (TTL), `jobs`, `requests`, `runs`, `deepQuota`, and GridFS `uploads`.
- **External providers.** Anthropic (synthesis and planning), OpenAI (embeddings), and Tavily or SerpApi (search and page extraction).
- **State-carrying non-services.** The `jobs` collection is the queue. The two-tier search cache is an in-process LRU over `searchCache`. The run logs are `runs/<requestId>.json` on disk plus the `runs` collection when deployed.

## Responsibilities

- **Gateway: the only thing the browser talks to.** It checks `X-User-Id` (401), makes or reuses `X-Request-Id`, validates bodies against the zod contract (400), rate-limits per user (429), rejects oversized uploads early (413), streams SSE through without buffering, and turns any upstream failure into a 502. It holds **no provider key and no database connection**. It does not decide anything about cost or depth.
- **Agent service: the only holder of provider keys and the only place that spends money.** So it alone enforces `DEEP_DAILY_CAP` (an atomic per-user, per-UTC-day counter → `429 {error, resetsAt}`), the per-gear tool-call and wall-clock caps, and the rule that a quick run never gets `plan_research`. The tool list is filtered by depth in code, not by prompt. It alone decides what counts as a citation: every `[n]` is filtered against the `sources` list of that request before the token leaves the process. It also rechecks `X-User-Id`, so reaching it directly does not bypass identity.
- **Worker: the only thing that parses, chunks, embeds, and marks a document `indexed`.** It marks `indexed` only after its read-your-write probe gets a chunk back from the vector index.
- **Mongo: the source of truth for everything except in-flight streams.**

## Communication

- **Browser → gateway:** HTTPS. JSON for CRUD; `POST /threads/:id/ask` returns `text/event-stream`. If the gateway is down, the UI shows a network error.
- **Gateway → agent:** HTTP over private networking, using the same contract. JSON routes are re-serialized after validation. Uploads stream through unparsed. SSE is piped chunk by chunk with `X-Accel-Buffering: no` and no compression. The request id rides along in a header.
  - Agent unreachable before the stream starts → the gateway returns 502 JSON.
  - Agent dies mid-stream → the gateway writes a final `error` event (502) and closes.
  - Client disconnects → the gateway aborts the upstream request, and the agent aborts its provider calls.
- **Agent → providers:** HTTPS with timeouts.
  - The agent **does not commit the SSE response until its first retrieval succeeds** (or the plan is ready, on deep). A provider failure before that point becomes a real HTTP 502, never a 200 with a polite answer.
  - After the stream has started, a provider failure becomes an `error` event with status 502, then `done` with `terminated: "error"`. The run log records it.
  - A single page fetch that fails is a `fetch_page` trace step with `ok:false` and the error text, and the run continues on the other pages.
- **Agent ↔ worker:** only through Mongo, never directly.
  - The upload handler writes the GridFS file, the `documents` row (`pending`) and the `jobs` row, then returns 202.
  - The worker claims a job with an atomic `findOneAndUpdate` and heartbeats `claimedAt`.
  - A sweeper returns `running` jobs with a stale `claimedAt` to `pending`.
  - Each finished stage is recorded on the job (`stage`), so a retried job skips finished stages.
  - If the worker is down, uploads still return 202 and sit in `pending` until it comes back.

## State

| State | Where | Owner | Authoritative? |
| --- | --- | --- | --- |
| threads, messages (with sources, done, plan) | Mongo | agent | yes |
| memories + embeddings | Mongo `memories` (vector index, `userId` filter) | agent, written only by `save_memory` | yes |
| spaces, documents, raw files | Mongo + GridFS | agent (writes), worker (status) | yes |
| chunks + embeddings + locators | Mongo `chunks` (vector + text index) | worker | derived from GridFS; can be rebuilt |
| jobs | Mongo `jobs` | agent inserts, worker claims | yes, it is the queue |
| deep quota | Mongo `deepQuota` (`userId:YYYY-MM-DD`) | agent | yes |
| requests, runs | Mongo + `runs/*.json` | agent | yes, the evidence |
| search results | in-process LRU → Mongo `searchCache` (TTL 6 h) | agent | **no, a cache**; deleting it costs money and latency, not correctness |
| fetched page text, query embeddings | in-process LRU | agent | **no, a cache** |
| rate-limit buckets | gateway memory | gateway | no; resets on restart, which is acceptable for an abuse guard |

**The same gap bites memory.** A preference saved seconds ago may not be in `memories_vector` yet. So `recall_memory` merges the index's nearest matches with the user's last 15 minutes of memories, read directly from the collection and scored by exact cosine. "Remember X" then works in the very next thread.

**Written but not yet searchable.** Atlas Search indexes are eventually consistent. A document's chunks are upserted with status `embedding`. The worker then polls `$vectorSearch` (filtered by `spaceId`, using the first chunk's own embedding) until that chunk comes back, and only then sets `indexed` and `pct: 100`. A question asked in the gap sees the document as not yet indexed rather than as silently empty.

## Trade-offs

1. **The quick gear is a code-driven loop, not a model-driven tool loop.**
   - A quick run follows a fixed policy: recall memory, route (web / docs / both), search, fetch the top pages, then observe and top up if too few pages were readable, all under the 8-call cap. The model is called once, to write the answer.
   - A reasonable engineer would let the model choose each tool. I didn't, because TTFT p95 ≤ 2.5 s cannot absorb two extra model round trips.
   - What I gave up is flexibility on odd questions: the quick gear cannot decide on its own to search twice with different phrasings.
   - Deep search is where the model drives the research, through `plan_research`.
2. **Deciding what to save to memory: a regex pre-filter, then a small model call.**
   - Cheaper and faster than asking the model on every question, and it keeps trivia out of `/memory`.
   - It will miss preferences phrased in ways the regex doesn't catch. That is the one I'm least sure about.
3. **Atlas Vector Search instead of a dedicated vector store.**
   - Each citation is one document read, and `spaceId` is a real filter inside `$vectorSearch`.
   - The cost is the M0 three-search-index ceiling and eventual consistency I have to probe for.
4. **No re-ranker after RRF.**
   - Vector and BM25 lists are fused with reciprocal rank fusion (k = 60), top-k set by `RAG_TOP_K`.
   - A cross-encoder re-rank adds a provider call and ~300 ms to every doc question. On a four-document corpus, RRF already beats the recall target.
   - I'd revisit this at 10× the corpus.
5. **Snippets are verbatim page sentences chosen by lexical overlap, not the model's own quote.**
   - This makes grounding provable by string match.
   - The cost: a snippet is sometimes the nearest sentence rather than the exact clause a claim rests on.
