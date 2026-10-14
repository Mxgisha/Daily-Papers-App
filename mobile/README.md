# Daily Papers — mobile client

Expo (React Native) client for the Daily Papers App. One codebase for iOS, Android, and web.

This is the client half of the static-bundle architecture: there is no server. Read-only
content is downloaded as prebuilt static files and all personalization runs on device.

## What is verified, and what is not

Being precise about this matters more than the feature list.

**Verified here, by execution:**

| Check | Command | Result |
|---|---|---|
| `vectors.bin` parses and verifies against the manifest | `npm test` | passes |
| Feed reproduces the **Python reference ranking exactly** | `npm test` | passes |
| Row-offset mapping (`vec_index`) regression | `npm test` | passes |
| Integrity: a single flipped byte is rejected | `npm test` | passes |
| Truncated download rejected on size, before hashing | `npm test` | passes |
| **Full pipeline in a real browser** over real HTTP | `harness/run_harness.py` | 8/8 checks |
| App and test typecheck | `npm run typecheck` | clean |
| Metro bundles the app | `npx expo export --platform android` | 2.9 MB Hermes bundle |

**Not verified — needs a device or simulator.** Bundle download, file writes, `expo-sqlite`
and the WebView reader, because they are native APIs. Hermes is not exercised either (the
harness runs in V8). These remain the client's largest unknowns.

The split is deliberate: `src/core/` holds pure logic with no React Native imports, so it is
fully testable, and `src/platform/` holds thin device adapters.

## The browser harness

`expo export` proves Metro resolves imports. It proves nothing about whether a bundle can be
downloaded, decompressed, parsed, and turned into a feed. The harness closes that gap:

```bash
../.venv/bin/python harness/run_harness.py --bundle ../dist --out ../reports/harness
```

It bundles the real `src/core/` modules with esbuild, stages them beside the real artifacts,
serves them, and drives a headless Chromium via WebDriver mobile emulation. It is not a mock:
it fetches the real manifest, verifies `vectors.bin` by SHA-256, `fzstd`-decompresses the real
delta, parses the real vectors, and generates a feed — all in a browser engine. It writes a
screenshot and a JSON result alongside.

Measured on the current corpus (1,633 papers): manifest 6 ms · vectors download + verify +
parse 46 ms · delta download + decompress 124 ms · corpus build 3 ms · feed generation 136 ms.

**The harness found two real bugs that nothing else could**, both in the delta format, which
had never been consumed by anything:

1. **The delta carried no `id`, no `vec_index`, and no vector.** A client could download it and
   still be unable to place a single new paper in a feed, because nothing linked metadata to an
   embedding. It now carries all three, making it self-sufficient.
2. **The delta omitted `topics`**, silently zeroing `topic_overlap` — 15% of the ranking weight —
   for every delta-sourced paper. `topicEntropy` measured **0.0**; after the fix, **3.065**
   (normalized 0.901).

Both now have harness checks that fail loudly if they regress.

## Layout

```
src/core/            Pure TypeScript, no RN imports, fully tested in Node
  vectors.ts         vectors.bin parser + int8 scoring (port of dailypapers/quantize.py)
  feed.ts            candidates, scoring, MMR, exploration, evaluation
  seeds.ts           onboarding seed selection
src/platform/        Device adapters (NOT covered by tests)
  bundle.ts          download -> fzstd -> SQLite -> Corpus
  readerCss.generated.ts   generated from reader/static/reader.css
app/                 Expo Router screens
  _layout.tsx
  index.tsx          the daily feed
  read/[id].tsx      WebView reader
tests/
  make_fixtures.py   exports fixtures from the real bundle via the Python reference
  feed.test.ts       cross-verification against Python
```

## Cross-verification

`recsys/feed.py` is the definition of correct. `tests/make_fixtures.py` runs it against the
real `dist/` bundle and writes `tests/fixtures/`, and `feed.test.ts` asserts the TypeScript
implementation produces the identical feed — same ordering, same score components within
float tolerance.

The fixtures are generated, not committed, so they always describe the current bundle:

```bash
npm run fixtures     # requires ../dist and the Python venv
npm test
```

**This caught a real bug.** Porting surfaced that `papers.vec_index` *is* a row offset, but
the Python `_rows()` treated it as a paper id and looked it up in the paper-id→row map — so
it returned a different paper's vector for almost every row. It failed silently: the feed
still looked plausible because the recency and topic components were correct, so the
similarity term was effectively noise. Both implementations are now fixed, and
`vec_index is a row offset whose id matches the paper (regression)` guards the invariant.

## Decompression: why zstd

Measured on the real bundle, in pure JS (Hermes cannot use WASM, which rules out `zstd-wasm`):

| Codec | Library | Speed | 90-day download |
|---|---|---|---|
| zstd | `fzstd` | 59.7 MB/s | ~46 MB |
| gzip | `pako` | 60.9 MB/s | ~52 MB |

Identical speed, 13% smaller download — so zstd stays. One format detail matters: frames are
written one-shot by the bundle builder rather than streamed, so they declare a content size
and a client can preallocate. Streamed frames omit it, and a decompressor requiring the size
rejects them outright.

## Running it

```bash
npm install
npm run gen:reader-css      # regenerate the WebView stylesheet from the spike CSS
npm run fixtures && npm test
npm run typecheck

# Serve the bundle, then start the app
npm run serve:bundle        # serves ../dist on :8000
npm start
```

The app reads the bundle URL from `EXPO_PUBLIC_BUNDLE_URL` (default `http://10.0.2.2:8000`,
which reaches the host from an Android emulator). For a physical device use the host's LAN IP:

```bash
EXPO_PUBLIC_BUNDLE_URL=http://192.168.1.20:8000 npm start
```

`npm run serve:bundle` is a plain static file server — the same thing a CDN would do. No
server logic exists on the content path.

## Known gaps

- **Nothing here has run on a device.** Treat `src/platform/` as unproven.
- **Readers use a WebView** for the reader screen only. That reuses the verified
  `reader.css` and gives native MathML, but MathML rendering quality depends on the device
  having a math font. Every arXiv math element embeds its original LaTeX in an
  `<annotation encoding="application/x-tex">`, so bundling KaTeX is the fallback that
  removes that dependency — and would shrink the math payload ~12x.
- **Figures are unbounded.** A 15k-word paper carries ~28 MB of images against ~388 KB of
  text. Lazy loading plus server-side downscaling is required before this is usable on
  mobile data.
- **No persistence yet**: no reading progress, favorites, or event logging. The schema and
  the `client_event_id` idempotency design exist server-side; the client side is not written.
- **No auth.** Device-first anonymous users are the design; nothing is implemented.
- `fzstd` decompresses in one shot, so peak memory tracks bundle size. Fine for the
  recommended 90-day window; a year-long bundle would want its streaming API.
