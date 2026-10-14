# Daily Papers App — Implementation Plan

A mobile-first research paper reader with a daily personalized feed, progress sync,
favorites/collections, and a recommendation system that improves as it learns the user.

---

## 0. Architecture revision (Phase 1) — static bundle, no server

The stack in §2 below assumed a self-hosted FastAPI + Postgres + Redis backend with a
server-side recommender. **That was heavier than the MVP needs, and it has been revised.**

The insight is that three concerns are separable, and only one needs a server:

| Concern | Where it lives | Needs a server? |
|---|---|---|
| Paper corpus + tags | Static bundle files on a CDN | **No** — just files |
| Personalization + reading state | On-device SQLite | **No** |
| Identity + telemetry | Small managed Postgres | **Tiny one** |

Read-only content is precomputed by a nightly job and shipped as static files (`app_bundle.db.zst`,
`vectors.bin`, `delta/*.jsonl.zst`, `manifest.json`). Embeddings are precomputed at build time
and shipped as quantized vectors, so the app needs **no ML runtime at all** — the entire
content-based recommender is arithmetic over a packed binary file. The only central
component is a managed Postgres (Supabase free tier) for auth and event ingest.

**Consequences:** no FastAPI, no Redis, no server to operate, and $0/month infra at MVP
scale. What is given up: no live server-side re-ranking (mitigated by putting ranking weights
in `manifest.json`), improvements land only with a new bundle, and no collaborative filtering
(which is unavailable anyway without users).

See [README.md](README.md) for the measured artifacts, the quantization finding that drove the
int8 decision, and the bundle size plan.

---

## 1. The decision that shapes everything: HTML before PDF

Before stacking frameworks, settle this. A research paper is not one artifact:

| Format | Availability | Mobile reading UX | Progress tracking |
|---|---|---|---|
| **HTML full text** | arXiv HTML5 (`arxiv.org/html/{id}`) — **measured: 95.8% of recent papers, 82% back to 2017**; PMC (biomed) | **Excellent** — reflows to one column, resizable text, native scroll | Trivial: block index |
| **PDF** | Nearly universal (OA via Unpaywall) | Poor-to-OK — pinch-zooming a 2-column PDF on a 6" screen is the single worst part of every paper app | Page + scroll offset; workable but fiddly |

**Recommendation: render HTML when available, PDF as fallback.** This dodges the hardest
engineering problem in the app (performant PDF reading + reliable resume position) for the
majority of modern papers, and it is a genuine differentiator — almost nobody does
reflowed reading well on mobile.

This also decides your client framework, because it means the reader must be able to render
*native* scrollable text and, when needed, a *native* PDF view. A WebView wrapper (Capacitor)
can technically do both via PDF.js, but that is exactly where WebView performance hurts most.

### Phase 0 findings — measured, not assumed

The spike in `spike/` measured this over 336 recent papers across `cs.LG, cs.CL, cs.CV, cs.AI`
plus a 281-paper historical sample:

| Sample | Papers | HTML full text | Coverage |
|---|---|---|---|
| Recent (submitted <7 days) | 336 | 322 | **95.8%** |
| Submitted 2020 | 144 | 133 | 92.4% |
| Submitted 2017 | 137 | 112 | 81.8% |
| Historical total | 281 | 245 | 87.2% |

**HTML-first is confirmed, and more strongly than expected.** Two planning assumptions above
turned out to be wrong in a useful direction:

- **Backfill is far deeper than "post-Dec-2023."** Papers from 2017 render at 81.8%, so
  cold-start seeding can draw on a large historical corpus rather than only recent papers.
- **There are no soft-404s.** `200` and `404` are cleanly separable, so coverage is reliably
  measurable and cacheable per paper. This *requires* checking the LaTeXML `ltx_page_content`
  marker and not merely the status code — arXiv serves a styled HTML error page for missing
  full text, and the abs page is itself HTML. A naive check inflates the number.

Consequences for scope:

- **PDF is a ~4% fallback path, not a co-equal workstream.** Implement it simply (native PDF
  view, page-level progress) instead of engineering a sophisticated reflow pipeline. This is a
  meaningful reduction in the largest single workstream.
- **`cs.CL` is the weakest category at 88.7%** vs `cs.LG` at 98.4%. Worth revisiting if you
  narrow the target audience to NLP.
- **OpenAlex matched 100/100 recent papers with zero ingestion lag**, including same-day
  preprints — so the daily feed can be fully enriched at ingest time rather than backfilled.
  Its `best_oa_location.pdf_url` was empty 100% of the time, which is irrelevant here because
  arXiv always serves its own PDF. Citations are 0 for new papers, so treat `citation_count` as
  a signal that matures over time, not a day-one feed-ranking feature.

Reproduce with `python3 -m spike.run_spike`; full output in `reports/spike_report.md`.

---

## 2. Stack

### Client — Expo (React Native) + Expo Router, with web as a build target

| Option | Verdict |
|---|---|
| **Expo / React Native + Expo Router** | **Recommended.** One codebase → iOS, Android, *and* a real web app via React Native Web. Native PDF view, native scroll, real offline file storage, first-class push notifications. |
| Next.js + Capacitor | Viable, and great if your team is web-only. But it wraps your app in a WebView — worst exactly at the reader, and it risks App Store rejection (see §6). |
| Flutter | Strong native performance and good PDF viewers, but you give up the JS/TS ecosystem and web output is weaker. Fine choice if you prefer Dart. |
| PWA only | No store presence, iOS push is fragile, and Safari can evict storage for unused sites. Good as a bonus target, not as the product. |

⚠️ Beware [vendor comparison pages](https://nextnative.dev/comparisons/nextjs-vs-expo) on this
topic — that one is written by a company selling a Next.js+Capacitor starter, and its claims
("Expo cannot share code with web", "Expo has no backend") are overstated. Expo's web output is
real; you just have to accept that some screens need `.web.tsx` variants.

**The right mental model is not "build web then convert."** It is: *build one Expo app that
compiles to web, iOS, and Android from day one.* You get the fast web iteration loop (`expo start
--web`, instant reload, browser DevTools) without building a throwaway web app you later rewrite.
Share ~80–90% of code; the reader screen and navigation chrome are the parts that legitimately
diverge.

### Backend

- **API: FastAPI (Python) or NestJS/Fastify (TypeScript).** Pick Python if you want the
  recommendation/ML stack in one language (recommended, since the recsys is the product).
- **Postgres + pgvector** — papers, users, events, and embeddings in one store. Start here;
  do not add a vector DB until pgvector's HNSW index actually hurts.
- **Redis** — feed cache, rate limiting, job queue.
- **Worker** (Celery / ARQ / BullMQ) — ingestion, PDF fetch + parse, embedding, daily feed build.
- **Object storage + CDN** (Cloudflare R2 or S3) — cached OA PDFs and extracted HTML.
- **Analytics** — PostHog (self-hostable) or just query your own `events` table. Your event log
  is the training data for the recommender, so own it.

Estimated running cost at MVP scale: **$5–25/month** (Fly.io/Railway + Neon/Supabase free tier + R2).

---

## 3. Data sources (all free, no paid keys needed)

| Source | What it gives you | Use for |
|---|---|---|
| **arXiv API** | Atom XML: title, abstract, authors, categories, PDF link; filter by `submittedDate` | The **daily delta firehose** — this is your "New today" feed |
| **Semantic Scholar Graph API** | Citation counts, references, venue, TLDR summaries, and a `/recommendations` endpoint | Enrichment + a **free recsys baseline on day one** |
| **OpenAlex** | ~250M works, topics/concepts, `related_works`, OA status, no key required | Broad metadata graph + subject tagging |
| **Unpaywall** | Legal OA PDF location by DOI | Getting a downloadable PDF |
| **PubMed E-utilities / PMC** | Biomed metadata + full-text HTML/JATS | If you target life sciences |
| **Crossref** | Canonical DOI metadata | Dedup / identity resolution |

**Identity resolution matters.** A paper may arrive as an arXiv preprint and later be published
under a DOI. Model `papers` (the work) separately from `paper_versions` (preprint v1, v2, published),
or you will show users the same paper twice and split your engagement signal.

**Legal:** only ingest and rehost open-access content. Deep-link to the publisher for everything
else. Do not build a paywall-circumvention pipeline.

---

## 4. Data model (sketch)

```sql
papers(id, doi, arxiv_id, s2_id, openalex_id, title, abstract, venue, year,
       oa_status, pdf_url, html_url, tldr, citation_count,
       embedding vector(768), created_at)
paper_versions(id, paper_id, version, source, published_at)
authors(id, name, orcid, h_index)
paper_authors(paper_id, author_id, position)
topics(id, name, source, parent_id)
paper_topics(paper_id, topic_id, score)
users(id, email, created_at, onboarding_seeds jsonb, prefs jsonb)
collections(id, user_id, name, created_at)
collection_items(collection_id, paper_id, added_at)
reading_state(user_id, paper_id, status, progress_pct,
              locator jsonb,          -- renderer-agnostic resume point
              last_read_at, total_dwell_ms)
events(id, user_id, paper_id, type, ts, session_id, position, metadata jsonb)
feed_impressions(user_id, paper_id, feed_date, rank, score, model_version)
```

Two notes that pay off later:

1. **`locator jsonb`** is deliberately opaque — `{renderer: "html", block: 42}` or
   `{renderer: "pdf", page: 7, y: 0.31}`. This lets you resume across devices *and* across a
   format switch without a migration.
2. **`feed_impressions` is not optional.** Without logged impressions you cannot tell whether a
   user ignored a paper because it was irrelevant or because you ranked it 90th. Every serious
   recommender evaluation depends on this table, and you cannot backfill it.

---

## 5. Recommendation system — staged, not one big ML project

You cannot train collaborative filtering on day one, because you have no users. Build it in stages
where each stage is genuinely useful on its own.

### Stage 0 — Cold start (ship this in the MVP, no training required)

- **Onboarding:** user picks ≥5 papers they like, or ≥5 topics (arXiv categories / OpenAlex topics).
- **User vector** = mean of the **SPECTER2** embeddings of those seed papers.
- **Candidate generation:** recent papers (last 30 days) in those categories + Semantic Scholar's
  `/recommendations` for each seed.
- **Ranking:** cosine similarity → **MMR** for diversity → recency boost → filter already-seen.
- **Exploration:** ε-greedy (ε ≈ 0.15) so users see things outside their bubble and you collect
  the signal needed for Stage 1.

Why SPECTER2: it is trained specifically on scientific documents (citation-informed) and reliably
beats general-purpose embedding models on paper similarity. Abstract + title is enough — you do not
need full text to embed.

### Stage 1 — Content-based with feedback (weeks after launch)

- Weighted user vector with **exponential time decay** (half-life ~30 days):

  | Event | Weight |
  |---|---|
  | Save / favorite | +3.0 |
  | Read past 80% | +2.5 |
  | Scroll past 50% | +1.5 |
  | Open | +1.0 |
  | Open then immediate close | −1.5 |
  | Explicit "not interested" | −2.0 |

- Add **LightFM** (hybrid: content features + item co-occurrence). One small model, handles cold
  items gracefully, trains in seconds.
- `more like this` on any paper = ANN lookup in pgvector.

### Stage 2 — Collaborative + learned ranking (once you have real engagement)

- **Implicit ALS** on the user × paper engagement matrix as a cheap, strong baseline.
- **Two-tower retrieval**: user tower (reading history + profile) and item tower (SPECTER2 +
  metadata) → ANN index for candidate generation.
- **Re-ranker** (LambdaMART or a small MLP) over the top ~200 candidates, using features like
  semantic similarity, topic/author affinity, venue, freshness, and predicted dwell time.

### Stage 3 — LLM layer

- "Why am I seeing this?" explanations (cheap, and it makes personalization feel trustworthy).
- Natural-language search and chat-with-paper.
- Summaries: use S2's TLDR, or generate your own with a small model.

### Serving architecture — a large simplification

This is a **daily** app. You do not need real-time ranking.

1. **Nightly batch job** precomputes a ranked candidate list (~100 papers) per active user into Redis.
2. **At request time**, cheaply re-rank those candidates to filter already-read papers and apply
   session context.
3. Push the digest notification at the user's preferred hour.

That single decision removes most of the latency and infrastructure complexity from the recsys.

### Evaluation

- **Offline:** Recall@k and NDCG@10 on held-out saves (not clicks — clicks are cheap).
- **Online:** A/B tests, or interleaving (far more sample-efficient).
- **Guardrails:** 7/30-day retention, dwell time, save rate, and **topic diversity** — otherwise you
  optimize yourself into a filter bubble.
- Log `model_version` on every impression so you can attribute metric shifts.

---

## 6. Packaging: how this becomes an APK and an IPA

There are two mechanisms, and you should use both for different purposes.

### Android → APK / AAB

```bash
# Cloud build (no local Android SDK needed)
eas build -p android --profile preview     # .apk — sideloadable, share with testers
eas build -p android --profile production  # .aab — for Google Play

# Or fully local, works fine on Linux
npx expo prebuild -p android
cd android && ./gradlew assembleRelease     # → app/build/outputs/apk/release/app-release.apk
```

- Local Android builds need **JDK 17 + Android SDK** and work on Linux — no blocker.
- Set `android.buildType: "apk"` in your preview profile to get a sideloadable APK.
- **Guard your keystore.** Losing it means you can never update the app on Play under the same
  listing. EAS can manage it for you; if you self-manage, back it up.
- Google Play: **$25 one-time**. Personal accounts created after Nov 2023 must run a closed test
  with 12+ testers for 14 days before applying for production access — budget for that lead time.

### iOS → IPA

```bash
eas build -p ios --profile preview    # ad hoc / internal distribution
eas build -p ios --profile production # App Store / TestFlight
```

**You are on Linux, so you cannot build iOS locally.** Your options:

1. **EAS Build cloud** (recommended) — runs on macOS runners, no Mac required. [Per Expo's pricing](https://expo.dev/pricing.md),
   the free tier includes **15 Android and 15 iOS builds/month** (low-priority queue); beyond that
   it is ~$1 per Android build and ~$2 per iOS build on medium workers.
2. A physical Mac with Xcode.
3. A macOS CI runner (GitHub Actions macOS minutes, Codemagic).

Apple Developer Program is **$99/year**. Distribution paths: TestFlight (external testers need a
review), Ad Hoc (requires registering device UDIDs, 100-device cap), or the App Store.

### ⚠️ The App Store trap for "web app wrapped in a shell"

App Store Review Guideline **4.2 (Minimum Functionality)** is routinely used to reject apps that are
thin WebView wrappers around a website. If you go the Capacitor/PWA-wrap route, expect to defend
this. A native-feeling React Native app with offline reading, push notifications, and native
gestures does not have this problem. **This is a second, independent reason to choose Expo.**

### Over-the-air updates

EAS Update lets you ship JS-only changes (bug fixes, UI tweaks, ranking logic on the client) without
a store review cycle. The free tier covers 1,000 MAUs. This meaningfully de-risks launch.

### Cost summary

| Item | Cost |
|---|---|
| Development tooling | $0 |
| Expo EAS free tier | 15 Android + 15 iOS builds/mo |
| Google Play account | $25 one-time |
| Apple Developer Program | $99/year |
| Backend hosting | ~$5–25/month |
| Embeddings | Self-host SPECTER2 (free, CPU is slow) or HF Inference API |

**Realistic minimum to ship on both stores: ~$124/year plus hosting.**

---

## 7. MVP scope

### In scope

- **Auth** — email magic link or OAuth (Apple Sign-In is *mandatory* if you offer Google Sign-In on iOS).
- **Onboarding** — pick ≥5 seed papers or topics; this is your cold-start fuel.
- **Daily feed** — ~20 ranked papers, refreshed daily, "New today" + "For you" tabs.
- **Paper detail** — title, authors, venue, abstract, TLDR, links.
- **Reader** — HTML reflow preferred, PDF fallback; font size, light/sepia/dark.
- **Progress** — auto-save position, "Continue reading" shelf, cross-device sync.
- **Favorites + collections** — save, tag, organize.
- **Push notifications** — the daily digest. This *is* the retention loop.
- **Telemetry** — full event logging from day one. This is the real asset.
- **Recsys v0** — Stage 0 above (embeddings + MMR + exploration).

### Explicitly out of scope for MVP

Collaborative filtering · highlights and annotations · social features · chat-with-paper ·
citation graph explorer · offline sync engine · monetization · curated/polished web version ·
iPad/tablet layouts.

### Suggested 8-week sequence

| Week | Focus | Milestone |
|---|---|---|
| 1 | ~~Phase 0 spike + ingest pipeline~~ **DONE** | HTML coverage measured at 95.8%; schema + ingestion pipeline live |
| 2–3 | API, auth, feed endpoint, event logging | Feed served over HTTP; events hitting the DB |
| 3–5 | Client: feed → detail → reader → progress → collections | Usable app on a real phone via Expo Go |
| 5–6 | Push notifications + daily feed batch job | Digest arrives on schedule |
| 6–7 | Recsys Stage 0 + onboarding seeds | Ranked feed measurably better than recency |
| 8 | Offline caching, polish, store assets | TestFlight + Play internal testing builds |

---

## 8. How it all fits together

```
                 ┌──────────────────────────────────────────────┐
                 │  arXiv API   S2 API   OpenAlex   Unpaywall   │
                 └──────────────────┬───────────────────────────┘
                                    │  nightly + hourly
                                    ▼
                    ┌───────────────────────────────┐
                    │  Worker: fetch, dedup, parse  │
                    │  embed (SPECTER2), tag topics │
                    └───────────────┬───────────────┘
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  Postgres + pgvector      Redis        R2/S3 + CDN    │
        │  papers, users, events,   feed cache,  PDFs, HTML     │
        │  embeddings               queue                       │
        └───────────────────────────┬───────────────────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │  API (FastAPI)                │
                    │  feed · reader · progress ·   │
                    │  collections · events         │
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │  Expo app (one codebase)      │
                    │  ├── web    (expo start --web)│
                    │  ├── Android → .apk / .aab    │
                    │  └── iOS     → .ipa           │
                    │      via EAS Build (cloud)    │
                    └───────────────────────────────┘
```

---

## 9. Risks and gotchas

1. **Cold start is the real problem, not the model.** With 0 users there is no collaborative signal.
   Onboarding seeds + exploration are what make the first session feel personalized.
2. **HTML/OA coverage.** Validate before committing to a reader design. Some fields (e.g. older
   humanities work) are almost entirely paywalled — that may steer your target audience.
3. **Retention.** You are competing with arXiv listings, HF Daily Papers, Scholar Inbox, and email
   digests that already have users' attention. Your edge is mobile-native reading + push + a queue
   that respects "read later". Design that loop deliberately.
4. **You cannot embed 250M papers.** Embed **lazily** — only papers entering a candidate pool
   (recent papers in target categories, plus neighbors of seed papers). This keeps it tractable.
5. **Duplicate papers across preprint/published versions.** Model versions explicitly (§4).
6. **App Store 4.2 rejection** for thin wrappers — see §6.
7. **iOS build requires macOS.** Budget for EAS Build or a Mac; do not discover this in week 8.
8. **Store review latency.** Android's 12-tester/14-day rule and iOS review times both need
   lead time. EAS Update softens the impact.

---

## 10. Competitive context

Study these before finalizing scope: **Hugging Face Daily Papers**, **Semantic Scholar feeds**,
**arXiv Sanity**, **Scholar Inbox**, **Zeta Alpha**, **Papers with Code**, **ReadCube**,
**Mendeley**, **Zotero** (mobile reader is weak — an opening).

The gap worth attacking: **nobody owns the mobile reading experience well.** Desktop-first tools
treat mobile as an afterthought, and search-first tools treat the daily habit as an afterthought.
A phone-native reader with reflowed HTML and a genuinely personalized daily queue is a defensible
position.

---

## 11. Immediate next steps

1. ~~**Validate HTML coverage.**~~ ✅ **Done — 96.4% recent, 82% back to 2017** (`spike/`).
2. ~~**Stand up Postgres + pgvector** and the schema.~~ ✅ **Done — 12 tables, HNSW index live.**
3. ~~**Build the ingestion job** end to end.~~ ✅ **Done — arXiv → OpenAlex → Postgres, idempotent.**
4. ~~**Add SPECTER2 embeddings.**~~ ✅ **Done — 1,633 papers; proximity adapter verified active.**
5. ~~**Decide the vector encoding.**~~ ✅ **Done — int8 at 99.8% recall@20, vs binary at 78.5%**, after
   the mean-centering fix below.
6. ~~**Build the static bundle builder.**~~ ✅ **Done — SQLite + FTS5 + centered int8 + manifest + delta.**
7. ~~**Reader feasibility spike.**~~ ✅ **Done — reflow works at a true 390×844; zero page overflow; long
   papers are ~91 screens and figures are 28 MB against 388 KB of text** (`reader/`).
8. ~~**Feed generator prototype.**~~ ✅ **Done — centering fixed anisotropy: pairwise similarity
   0.856 → 0.154, categories 5 → 8** (`recsys/`).
9. ~~**Scaffold the Expo client.**~~ ✅ **Done — core logic cross-verified against the Python
   reference; feed reproduces the ranking exactly on the real bundle** (`mobile/`).
10. ~~**Phase 2: make the client actually run.**~~ ✅ **Done — binary encoding removed and builds
    now self-validate; manifest checksums verified; the delta was fixed (it carried no id,
    vec_index or vector, and no topics, so it was unusable and silently zeroed the topic_overlap
    term); a browser harness executes the real core over real HTTP — 8/8 checks** (`mobile/harness/`).
11. **Downscale figure images.** 28 MB of figures per paper makes lazy loading *and* server-side
    resizing a requirement, not an optimisation. Still the largest known cost in the reader.
12. **Verify on a real device.** `expo-file-system`, `expo-sqlite`, the WebView reader and Hermes
    remain unexercised; the harness covers the browser-equivalent path only.
13. **Bundle the LaTeX math fallback.** Every arXiv math element embeds its original LaTeX, so
    KaTeX with bundled fonts removes the dependency on the device shipping a math font.
14. **Re-measure quantization at ≥20k papers.** int8 is 99.8% at n=1,633; binary degraded with
    corpus size, so confirm int8 stays flat rather than assuming it.
15. **Add persistence and telemetry**: reading progress, favorites, collections, and the local
    event queue with idempotent upload. `client_event_id` exists server-side; the client is
    unwritten, so **no data is being collected at all**.
16. **Then** move beyond content-based: those events are what make collaborative filtering possible.
