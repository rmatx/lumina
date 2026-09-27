# LUMINA — demo script

A 110-second take that hits all five beats the rubric asks for. Cut the two shots marked
**[cut for 85 s]** if you want to land inside the 60–90 s window.

Every number below was measured on the live deployment on 2026-09-27. If your take differs
wildly, something is wrong — stop and check rather than shipping the take.

---

## Before you hit record

1. **Open** <https://lumina-rmani.vercel.app>
2. **Set the user id to `demo`** in the header field. This matters: the Space and the saved
   memory below belong to that id. A fresh browser gets a random id and an empty app.
3. **Confirm the state is there** — Memory panel shows one row, Spaces shows
   *Demo · retrieval notes* with both documents `indexed`.
4. **Deep allowance: 5 of 5.** The take spends one. If you re-record more than four times,
   the sixth deep search returns `429` — switch the user id to `demo2` and re-seed, or wait
   for 00:00 UTC.
5. Browser at ~1440×900, bookmarks bar hidden, one tab. Close the terminal — nothing in this
   demo needs it.
6. **Have both queries on your clipboard** (below). Typing them live burns 8 seconds each.

**Query A** (used twice — quick, then deep):

```
Should we move our RAG stack off Atlas Vector Search onto a dedicated vector database?
```

**Query B** (the document question):

```
What is the common default value of the k1 parameter in BM25?
```

**Query C** (the memory question, deliberately unrelated):

```
What colour is a flamingo, and why?
```

---

## The shot list

| Time | Do this | What the grader must see | Say this |
|---|---|---|---|
| **0:00–0:10** | Paste **Query A**, leave the toggle on **Quick**, send. | Trace steps appear one by one; the sources rail fills **before** the first word of prose; text then streams. | "Quick is the default. Sources land before the first token, so the citation chips resolve as the answer arrives." |
| **0:10–0:20** **[cut for 85 s]** | Click citation chip **[2]**. Come back. Point at the `done` pill. | The cited page opens. Pill reads `done`, the model, and the cost. | "Every bracket resolves to a page this run actually fetched — about two cents." |
| **0:20–0:50** | Same query, flip the toggle to **Deep**, send. Let the plan land, then **speed the middle 15 s to 2× in your editor.** | **Plan panel appears at ~2.4 s, before any retrieval** — four sub-questions, each with a reason. Trace steps then stream tagged `1`–`4`. Sources rail reaches 12, each tagged with its sub-question. | "Deep is opted into, never drifted into. It says what it's going to find out before it fetches anything — then researches each part and merges everything into one numbering." |
| **0:50–0:58** | Scroll the deep answer. | Sections per sub-question, ending in **"What's still unknown"**. Citations `[1]`–`[12]`, contiguous. | "Twelve distinct sources against quick's three — four times the reading, and it ends by admitting what it couldn't establish." |
| **0:58–1:12** | Open the **Memory** panel. Start a **new thread**. Paste **Query C**. | The saved preference is listed. In the new thread the trace shows `recall_memory`, and the answer comes back ~50 words in British English — "grey", "colour", "metabolise". | "A preference saved in one thread changes the answer in a different one. Nothing is remembered that this panel doesn't show." |
| **1:12–1:26** | Select Space **Demo · retrieval notes**, mode **auto**, paste **Query B**. | Router picks the documents unprompted. Citation chip reads **`retrieval-basics.pdf, p. 1`**. Answer: k1 defaults to **1.2**. | "My own documents, cited down to the page — and the router chose them over the web on its own." |
| **1:26–1:38** | Open **/stats**. | `deepToday 1/5`, `costUsdToday`. | "The deep cap is enforced in the agent service, not the edge — and that service has no public route at all, so the cap can't be bypassed." |
| **1:38–1:50** **[cut for 85 s]** | Open **/evals**, scroll to the SLA table and the trajectories. | 85/100, every SLA row ✓, and both trajectories — including the failing one that ended in a real `502`. | "Every number there came from a benchmark run against this deployment, including the run I broke on purpose." |

---

## What you should expect to see

| Beat | Measured 2026-09-27 |
|---|---|
| Quick first token | ~1.8 s |
| Quick, end to end | ~8 s · $0.019 · 3 sources |
| Deep plan appears | **2.37 s**, before any retrieval · 4 sub-questions |
| Deep, end to end | ~25 s · $0.064 · 12 sources (4.0× quick) |
| Document answer | first token 0.9 s · cites `p. 1` · $0.008 |
| Memory answer | 52 words, British spelling · `recall_memory` returned 1 |

---

## Three ways this take goes wrong

1. **A random user id.** No memory, no Space, and the document beat dies on camera. Set the
   field to `demo` first and check the Memory panel before recording.
2. **Waiting out deep in real time.** 25 seconds of silence is a quarter of your video. Let
   the plan land at 2.4 s, keep narrating, and speed the fetch phase to 2× in the editor.
3. **A cold first request.** If the app has been idle, the very first answer pays connection
   setup. Throw away one quick question before you record, then start.

---

## After recording

Upload to YouTube or Loom, then wire the link into the evidence page so the manual row fills:

```bash
node eval/build-report.mjs --student "Raj Mani" --design DESIGN.md \
  --repo https://github.com/rmatx/lumina --video <URL> \
  --successful req_17aba78683204542 --failing req_385a67732ad74724 \
  --successful-notes "$(cat notes-successful.txt)" --failing-notes "$(cat notes-failing.txt)" \
  --notes "claude-sonnet-5 answers · claude-haiku-4-5 planner · tavily (fast) · Atlas M0 us-east-1 · Fly.io iad + Vercel"
fly deploy . --config backend/gateway/fly.toml --dockerfile backend/gateway/Dockerfile --remote-only --ha=false
```

The report is rebuilt from the same run artifacts, so no measured number changes — only the
video row fills in.
