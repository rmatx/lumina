# LUMINA — architecture

A Perplexity-style answer engine: ask a question, get a streamed answer whose every `[n]`
resolves to something the system actually retrieved in that request. Two gears — quick by
default, deep when a user opts in — over one MongoDB Atlas cluster.

This document is the map. [`../DESIGN.md`](../DESIGN.md) is the graded design rationale (the
five questions); this one shows the shapes and names the files.

**Live:** [UI](https://lumina-rmani.vercel.app) · [gateway](https://lumina-gateway-rmani.fly.dev/health) ·
[`/evals`](https://lumina-rmani.vercel.app/evals)

---

## 1. The system

Three processes, one database, four managed services. The accent marks the one component that
holds every provider key — which is why it also owns every spend decision.

**[Open the system architecture diagram →](diagrams/architecture.html)** · [dark](diagrams/architecture-dark.html) — self-contained HTML, no build step

| Component | Runs on | Source |
|---|---|---|
| React UI (provided, unmodified) | Vercel, static | [`web/`](../web) |
| Gateway — the public edge | Fly.io `iad`, public | [`backend/gateway/src/index.ts`](../backend/gateway/src/index.ts) |
| Agent service — the loop and the keys | Fly.io `iad`, **no public route** | [`backend/agent/src/index.ts`](../backend/agent/src/index.ts) |
| Jobs worker — indexing | forked process beside the agent | [`backend/agent/src/worker.ts`](../backend/agent/src/worker.ts) |
| MongoDB Atlas | us-east-1, M0 | — |

**The split that matters.** The browser can only reach the gateway. The gateway holds no
provider key and no database connection, so it cannot tell you what a request costs or
whether a user is over their allowance. The agent service holds every key, so every cap
lives there: a limit enforced at the edge is a limit you bypass by calling the service
directly. The agent has no public IP at all — `https://lumina-agent-rmani.fly.dev` does not
resolve to a route.

---

## 2. One question, two gears

`sources` is always emitted **before** the first `token`, so citation chips render while the
text is still arriving. The `alt` frame is the only branch: `depth` defaults to `quick`, and
the server never upgrades a request on its own.

**[Open the request lifecycle diagram →](diagrams/request-lifecycle.html)** · [dark](diagrams/request-lifecycle-dark.html) — self-contained HTML, no build step

**Quick** ([`quick.ts`](../backend/agent/src/quick.ts)) follows a fixed policy under an
8-call, 90-second cap: recall memory, route to web or documents or both, search, read the top
three pages in parallel, then one model call writes the answer. It is deliberately *not*
model-driven — two extra round trips would not fit the 2.5 s first-token budget. That file
never imports the planner, which is how a quick run is prevented from reaching
`plan_research` in code rather than by asking a model nicely.

**Deep** ([`deep.ts`](../backend/agent/src/deep.ts)) runs under 24 calls / 240 s. It plans
3–6 sub-questions **before any retrieval**, streams that plan as its first paint, researches
each sub-question in parallel, then merges everything into one contiguous citation numbering,
deduped by URL or `docId` + locator. Every retrieval step and every source carries the
sub-question index that found it.

**Six tools, and no more:** `web_search`, `fetch_page`, `search_documents`, `recall_memory`,
`save_memory`, and — deep only — `plan_research`.

---

## 3. A document is not indexed until the probe says so

Upload returns `202` in about 137 ms because nothing is parsed in the request path. The
worker does the rest, and `indexed` is *earned*: the probe queries the vector index for a
chunk it just wrote and waits until it comes back.

**[Open the document ingestion diagram →](diagrams/ingestion-lifecycle.html)** · [dark](diagrams/ingestion-lifecycle-dark.html) — self-contained HTML, no build step

Atlas Search indexes are eventually consistent, so "written" and "searchable" are different
moments. A question asked in that gap sees a document that is honestly not ready, rather than
an indexed document that silently returns nothing. The claim is atomic
(`findOneAndUpdate` on `{status: 'pending'}`), the worker heartbeats `claimedAt` every 20 s,
and a sweeper returns any `running` row with a stale claim to `pending` — which is what
happens when a worker is killed mid-job. Finished stages are recorded, so a retry does not
re-embed what it already embedded.

---

## 4. What the diagrams left out

The diagram budget is nine nodes; these earn their place in prose instead.

**Grounding.** Snippets are verbatim runs of the page's own sentences, chosen by lexical
overlap, so grounding is provable by string match rather than by trusting the model. Every
`[n]` is checked against that request's own `sources` list *as it streams*, and an unknown
number is deleted before the token leaves the process — a fabricated citation cannot reach
the browser. Empty retrieval says so and cites nothing.

**The search cache** ([`providers/search.ts`](../backend/agent/src/providers/search.ts)) is
two tiers: an in-process LRU in front of the `searchCache` collection, keyed by
`sha256(normalized query + separator + provider)`, 6-hour TTL, and time-sensitive queries
bypass both. Page text arrives *with* the search response, so reading a page costs no extra
provider call. `searchCached` is true in `done` only when every search in the request hit.

**Memory** ([`memory.ts`](../backend/agent/src/memory.ts)) is written only by an explicit
`save_memory` call, so `GET /memory` shows everything the system knows and `DELETE` genuinely
removes it. Recall merges the vector index's nearest matches with the user's last 15 minutes
of memories read straight from the collection — because a preference saved two seconds ago is
not searchable yet, and "remember this" has to work in the very next thread.

**Hybrid retrieval** ([`rag.ts`](../backend/agent/src/rag.ts)) fuses `$vectorSearch` and an
Atlas Search text index with reciprocal rank fusion (k = 60). The `spaceId` filter lives
*inside* `$vectorSearch`, never in a later `$match`, or the query returns another Space's
nearest neighbours and then hides them. Hits are grouped by citation identity, so a PDF page
split across three chunks is one citation carrying all three.

**Failing loud.** The SSE response is not committed until the first retrieval succeeds (or,
on deep, the plan is ready). So a dead search key produces a real **HTTP 502** carrying the
provider's own message, not a 200 stream containing an apology. After the stream opens, a
provider failure becomes an `error` event with status 502 and `done` with
`terminated: "error"`. A single page fetch failing is different in kind: a `fetch_page` step
with `ok: false` and the real error string, and the run continues on the other pages.

**Spend guards**, all in the agent service: per-gear caps; `DEEP_DAILY_CAP` per user per UTC
day → `429 {error, resetsAt}`; a **global** daily ceiling across all users
(`DAILY_SPEND_CAP_USD`), because anyone can invent an `X-User-Id`; and a kill switch
(`ANSWERS_ENABLED=false` → `503`, everything else keeps serving). Both are Fly secrets and
visible in `/health`.

**Evidence.** Every answer writes `runs/<requestId>.json` and mirrors it into Mongo, so a
deployed instance can export its own trajectories. One `X-Request-Id` greps both services'
logs end to end.

---

## 5. Measured on the deployment

From the full benchmark against the live gateway, not from a local run.

| Metric | Result | Target |
|---|---|---|
| Time to first token, p95 | 1,621 ms | ≤ 2,500 ms |
| Full answer, p95 | 6,638 ms | ≤ 12,000 ms |
| Upload `202` accept, p95 | 137 ms | ≤ 300 ms |
| Citation grounding | 0.966, zero dangling | ≥ 0.95 |
| Document recall@5 | 1.00 over 30 gold questions | ≥ 0.70 |
| Deep plan, p95 | 2,355 ms | ≤ 4,000 ms |
| Deep vs. quick distinct sources | 3.67× | ≥ 2× |
| Search p95 during a 60-page ingest | 0.68× idle | ≤ 1.3× |
| Cost per answer | $0.011 quick · $0.065 deep | ≤ $0.05 · ≤ $0.35 |
| Error rate | 0 | ≤ 1% |

---

## 6. Running it

```bash
npm install
cp .env.example .env            # every knob is documented there
node scripts/create-indexes.mjs # 2 vector + 1 text + TTL index
npm run dev                     # agent :8000, gateway :8787, UI :5173
```

Proving it: `node benchmark/bench.mjs` · `node quality/check.mjs .` ·
`node eval/eval.mjs --deploy-url <gateway>`.

---

## 7. About these diagrams

Built with the conventions of [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design)
— self-contained HTML with inline SVG, no Mermaid, no shadows, orthogonal connectors only,
accent reserved for one or two focal nodes, and a nine-node density ceiling that is the
reason this is three diagrams instead of one. Each ships in light and dark and passes that
skill's `self_check.py`. They use the shipped editorial skin; to rebrand them from a website's
palette, install the plugin and run its onboarding:

```text
/plugin marketplace add cathrynlavery/diagram-design
/plugin install diagram-design@diagram-design
```
