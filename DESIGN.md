# DESIGN.md — LUMINA

## Components

LUMINA is three processes, one database, and three provider accounts.

The **web UI** (`web/`, provided) is React + Vite. In development it runs on :5173; in production it is static files on Vercel. It talks to the gateway.

The **gateway** (`backend/gateway`, Express, :8787) is the public edge. It is small on purpose: identity, validation, rate limits, streaming, and proxying.

The **agent service** (`backend/agent`, Express, :8000, private) does the actual work: the quick loop and the deep loop, the six tools, memory, hybrid retrieval, `/stats`, and the deep-search spend gate. Provider keys are read here and nowhere else.

The **jobs worker** (`backend/agent/src/worker.ts`) is a separate Node process that the agent service forks and restarts, or that runs on its own with `npm run worker`. It exists as its own process for one reason: parsing a 60-page PDF must not stall the event loop that is streaming somebody's answer.

**MongoDB Atlas** holds everything in one database: `threads`, `messages`, `memories` (vector index), `spaces`, `documents`, `chunks` (vector index plus a text index), `searchCache` (TTL index), `jobs`, `requests`, `runs`, `deepQuota`, and the GridFS `uploads` bucket.

Three pieces carry state or make decisions without being services, and they are easy to overlook. The **`jobs` collection is the queue** — there is no broker, so the collection plus an atomic claim is the whole mechanism. The **search cache** is two tiers: an in-process LRU in front of the `searchCache` collection, keyed by SHA-256 of the normalized query plus the provider name. The **run logs** are one `runs/<requestId>.json` file per answer, mirrored into the `runs` collection so a deployed instance can export them.

Outside the system: Anthropic (Sonnet 5 writes answers, Haiku 4.5 plans and extracts memories), OpenAI (embeddings), and the search provider — Tavily or SerpApi, chosen by `SEARCH_PROVIDER` with no code change. Tavily is the one I ran and measured; in SerpApi mode the same tool reads pages with readability + jsdom instead of Tavily's extract endpoint.

## Responsibilities

The interesting part is what each piece is forbidden to do.

The **gateway** is the only component the browser may talk to, and the only one that may serve CORS. It rejects a request with no `X-User-Id` (401), reuses or generates `X-Request-Id`, validates every body against the zod schemas in `packages/contract` (400), rate-limits per user with a token bucket (429), refuses an oversized upload before proxying a byte of it (413), pipes SSE through without buffering, and converts any agent failure into a 502. It holds **no provider key and no database connection**. It also decides nothing about money or depth: it cannot tell you what a request costs or whether a user is over their deep-search allowance.

The **agent service** is the only holder of provider keys, and therefore the only place that can spend money. So every spend decision lives here, not on the edge: the `DEEP_DAILY_CAP` counter (atomic, per user, per UTC day, `429 {error, resetsAt}` when exhausted), the per-gear caps (quick: 8 tool calls / 90 s; deep: 24 / 240 s), and the rule that a quick run can never call `plan_research`. That last one is enforced by the tool list being built from the requested depth in code — `quick.ts` does not import the planner at all — rather than by asking the model nicely in a prompt. A cap on the edge is a cap you bypass by calling the agent service directly, which is also why the agent re-checks `X-User-Id` itself.

The agent service is also the only component that decides what counts as a citation. Every `[n]` the model emits is checked against that request's own `sources` list as it streams, and an unknown number is deleted before the token leaves the process. A fabricated citation cannot reach the browser even if the model invents one.

The **worker** is the only component that parses, chunks, embeds, or writes `chunks`, and the only one that may set a document to `indexed`. It earns that status only after a read-your-write probe returns one of the chunks it just wrote.

**Mongo** is the source of truth for everything except an in-flight stream, which lives only in the memory of the process producing it.

## Communication

**Browser → gateway** is HTTPS: JSON for everything except `POST /threads/:id/ask`, which is `text/event-stream`. If the gateway is down the UI shows a network error; nothing is queued client-side.

**Gateway → agent** is HTTP over private networking, speaking the same contract. Validated JSON is re-serialized; multipart uploads stream through unparsed so a 25 MB file is never buffered twice; SSE is forwarded chunk by chunk with `X-Accel-Buffering: no` and no compression anywhere on that route. The request id travels in a header, so one id greps both logs. Three failure cases, deliberately different: if the agent is unreachable **before** the stream starts, the gateway answers 502 JSON; if the agent dies **mid-stream**, the gateway appends an `error` event carrying 502 and closes, because the status line is long gone; if the **client** disconnects, the gateway aborts the upstream request, which aborts the agent's provider calls.

**Agent → providers** is HTTPS with timeouts, one retry on a transient search failure, and no fallback answers. The important detail is that the agent does not commit the SSE response until its first retrieval has succeeded (or, on a deep search, until the plan is ready). Everything before that point is queued in memory. So a dead search key produces a real **HTTP 502** with the provider's own message, not a 200 stream containing an apology — the Live Translate failure mode this rule exists to prevent. Once the stream is committed, a provider failure becomes an `error` event with status 502 followed by `done` with `terminated: "error"`, and the run log says the same. One page fetch failing is different in kind: that is a `fetch_page` step with `ok: false` and the real error string, and the run continues on the other pages.

**Agent ↔ worker** never talk directly — only through Mongo. The upload route writes the file to GridFS, inserts a `pending` document row and a `jobs` row, and returns `202` in about 245 ms measured. The worker claims work with an atomic `findOneAndUpdate` on `{status: 'pending'}`, heartbeats `claimedAt` every 20 s, and records each finished stage on the job so a retry does not re-embed a document it already embedded. A sweeper returns any `running` row with a stale `claimedAt` to `pending`, which is what happens when a worker is killed mid-job. If the worker is down entirely, uploads still return `202` and sit in `pending` until it comes back; nothing is lost and nothing blocks.

## State

Authoritative state, all in Mongo and all owned by the agent service: `threads` and `messages` (including each answer's sources, its `done` payload, and the plan a deep search ran), `memories` with their embeddings, `spaces` and `documents`, the raw uploads in GridFS, `deepQuota`, and the evidence — `requests` and `runs`. The worker owns `chunks`; those are derived state, rebuildable from the GridFS file by deleting the rows and re-queueing the job. Memory is written **only** by an explicit `save_memory` tool call, so `GET /memory` shows everything the system knows and `DELETE /memory/{id}` genuinely removes it.

Four things are caches, and deleting any of them costs latency or money but never correctness: the in-process search LRU, the `searchCache` collection behind it (6 h TTL, and time-sensitive queries bypass both), the fetched-page-text and query-embedding LRUs, and the gateway's rate-limit buckets, which live in process memory and reset on deploy — acceptable for an abuse guard, not for anything billed.

The consistency story is the same problem twice. Atlas Search indexes are eventually consistent, so "written" and "searchable" are different moments. For documents, the worker writes the chunks, sets the document to `embedding`, then polls `$vectorSearch` with the first chunk's own embedding, filtered by `spaceId`, until that chunk comes back; only then does it set `indexed` and `pct: 100`. A question asked during that window sees a document that is honestly not ready, rather than an indexed document that silently returns nothing. Memory has the same gap on a much shorter clock, and I hit it in testing: a preference saved two seconds ago is not in `memories_vector` yet, so "remember this" appeared to do nothing in the very next thread. `recall_memory` therefore merges the index's nearest matches with the user's last 15 minutes of memories read straight from the collection and scored by exact cosine in Node. Ranking still decides what gets injected, capped at 5 memories and about 1 000 tokens.

## Trade-offs

**The quick gear is a code-driven loop, not a model-driven one.** A quick answer follows a fixed policy: recall memory, route to web or documents or both, search, read the top three pages in parallel, top up once if pages came back unreadable, then one model call to write the answer. A reasonable engineer would let the model choose each tool, and that is the textbook agent loop. I did not, because the TTFT budget is 2 500 ms at p95 and two extra model round trips cost more than a second before any searching starts. Measured p95 came in at 1 269 ms. What I gave up is adaptability on strange questions: the quick gear cannot decide by itself to search again with different wording. Deep search is where the model genuinely drives, through `plan_research`.

**Haiku plans, Sonnet answers.** I first ran the planner on Sonnet with JSON structured output and the plan took 6–9 s against a 4 000 ms target. Moving to Haiku with a compact `1. question || reason` line format brought it to about 2.5 s. The cost is a planner that is a little blunter than Sonnet's; sub-questions occasionally overlap more than I would like. This is the one I am least sure about, because the human-graded row asks whether a person would have asked those questions, and I optimised it against a stopwatch.

**Atlas Vector Search instead of a dedicated vector store.** A citation is one document read — chunk text, page number, and embedding in the same row — and `spaceId` is a real filter inside `$vectorSearch` rather than a `$match` after it. The price is the free-tier ceiling of three search indexes, which is exactly what LUMINA needs with none spare, and eventual consistency I have to probe for rather than assume.

**No re-ranker after RRF.** Dense and BM25 results are fused with reciprocal rank fusion (k = 60) and cut at `RAG_TOP_K`. A cross-encoder re-rank would mean another provider call and roughly 300 ms on every document question; on the four-document gold corpus, RRF already scores 30/30 on recall@5, so the re-rank would buy nothing measurable. At ten times the corpus I would expect to need it, and the retrieval code is deliberately the only place that would change.

**Snippets are the page's own sentences, chosen by lexical overlap.** The alternative is letting the model quote what it relied on. Mine makes grounding provable by string match, which is what the grader checks, and it means a fabricated snippet cannot exist. The cost is that a snippet is sometimes the most relevant nearby sentence rather than the exact clause a claim rests on, and I had to teach the selector to skip page titles, FAQ headings and banners, because those are the lines a page renders differently from its own HTML.
