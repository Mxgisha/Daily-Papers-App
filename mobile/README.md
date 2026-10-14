# Daily Papers — mobile client

An Expo (React Native) app. **Current focus: a minimal reader.** List papers, tap one, read it.

The bundle/vector/recommendation machinery still exists in this repo (`bundle/`, `recsys/`,
`mobile/src/core/`) but is deliberately **off the app path**. The reader does not depend on it.

## What the reader MVP does

Two screens and one source.

**List** (`app/index.tsx`) — a bundled list of 300 papers with one input that serves two
intents: type anything to filter the list, or paste an arXiv ID (new-style `2610.13948` or
old-style `math.GT/0309136`) to get an "open this paper" affordance at the top. One field,
no mode switch.

**Reader** (`app/read/[id].tsx`) — the paper's HTML full text in a WebView, with the reader
stylesheet injected before first paint so arXiv's desktop CSS never flashes. Papers without
HTML fall back to the PDF, which hands off to the OS viewer.

That's it. No download step, no database, no vectors, no ranking. The app opens and shows
papers.

## How the paper gets there

```
assets/papers.json   (517 KB, 300 papers)  ->  list screen
        tap
arxiv.org/html/{id}  ->  WebView + injected reader CSS  ->  reader screen
        (no HTML rendering on arXiv -> PDF fallback)
```

The list is generated from Postgres by `scripts/export_papers.py` and bundled, so the list
works with no network. The paper itself is fetched live from arXiv.

## Verified by running it, not compiling it

`harness/run_reader_mvp.py` exports the app for web, serves it, drives a headless Chromium
through WebDriver mobile emulation, screenshots both screens, and reads the DOM back:

```bash
npx expo export --platform web --output-dir ../dist-web
python3 harness/run_reader_mvp.py --web ../dist-web --out ../reports/reader-mvp
```

Result on an emulated iPhone 14 viewport:

| | |
|---|---|
| List | 300 papers, filter input present, cards render with title/authors/abstract |
| Reader | loaded `2610.13948`, iframe → reader proxy, title, byline and abstract all render |

Screenshots: `reports/reader-mvp/01-list.png`, `reports/reader-mvp/02-reader.png`.

One wrinkle worth knowing: on **web** the reader loads through a same-origin proxy
(`reader/server.py`) because a browser will not let you inject styles into a cross-origin
iframe. On **native** the WebView injects directly and needs no proxy — so the proxy is a
verification device, not part of the product.

## Running it

```bash
npm install

# web, for a look in a browser
npx expo export --platform web --output-dir ../dist-web
python3 harness/run_reader_mvp.py --web ../dist-web

# device / simulator
npm start
```

Regenerate the paper list (needs Postgres + the Python venv):

```bash
../.venv/bin/python scripts/export_papers.py --out assets/papers.json --limit 300
```

## Layout

```
app/
  _layout.tsx        stack + navigation chrome
  index.tsx          the paper list
  read/[id].tsx      reader — WebView + injected stylesheet (native)
  read/[id].web.tsx  reader — iframe through a same-origin proxy (web only)
assets/papers.json   the bundled paper list
scripts/
  export_papers.py   regenerate the list from Postgres
harness/
  run_reader_mvp.py  export -> serve -> drive -> screenshot both screens
  run_harness.py     (earlier) executes the bundle/feed core in a browser
src/core/            feed + vector logic — NOT used by the reader
src/platform/        bundle loader — NOT used by the reader
```

## Deliberately excluded

No bundle download. No SQLite. No embeddings or vectors. No recommendations. No reading
progress, favourites or telemetry. No auth.

These were built earlier and are still in the repository and still verified — they are
simply not on the reader's path, so the reader can be understood, run and changed without
them.

## Known limits

- **The reader has not run on a device.** Web is verified; the native WebView path is not.
  There is no KVM or Android SDK in this environment, so a simulator was not available.
- **Math rendering depends on the device having a math font.** arXiv serves native MathML;
  if a device lacks a math font, equations degrade. Every arXiv math element embeds its
  original LaTeX, so bundling KaTeX is the fix.
- **Figures are lazy-loaded but not downscaled.** Opening a paper no longer pulls all 62
  figures (~28 MB), but the ones you do reach are full size.
- **The list is a snapshot.** 300 papers, rebuilt by hand; there is no refresh.
