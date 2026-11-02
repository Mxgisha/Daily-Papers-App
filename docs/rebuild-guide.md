# Rebuilding Daily Papers from first principles

A build order and a list of traps, derived from the constraints rather than from the feature
list. The repository is the reference implementation; every claim here can be checked against
it.

---

## 0. The problem, in one sentence

arXiv papers are typeset for A4. On a 6-inch screen the reader is pinch-zooming around a
two-column layout. The app's job is to present the same content as **one column of text sized
for the device**, and to remember where the reader was.

Everything below follows from that sentence.

---

## 1. Four constraints that decide the architecture

Work these out before writing code. Each one eliminates a large class of designs.

### C1 — The paper content is not yours

You do not control the markup. You can fetch arXiv's HTML and present it; you cannot change
how it is emitted. So the question is not "how do I model a paper" but **"how do I restyle a
document I didn't write"**.

*Consequence:* CSS against LaTeXML's class names, injected into someone else's page. Not a
component tree.

### C2 — Equations are MathML, tables are fixed-width

Parsing arXiv's HTML into native components means parsing deeply nested HTML and then
reproducing MathML with native views. There is no good answer for equations.

*Consequence:* a WebView, for this one screen. This is a deliberate exception; a WebView
wrapping a website would be a different, worse decision.

### C3 — Figures dominate the payload

Measured on the reference corpus: figures total ~28 MB against ~388 KB of text for a paper.

*Consequence:* lazy-loading figures is not an optimisation, it is a requirement. Text is the
cheap part; treat it as such.

### C4 — Content is already public and free

arXiv serves the HTML and the PDFs. There is nothing to cache centrally and nothing to sell.

*Consequence:* no backend. Every content path is either a bundled asset or a direct request
from the device to arXiv. That removes deployment, cost, and an entire class of failure.

**Two facts to verify before you commit to the PDF path** (both checkable with `curl -I`):

- arXiv serves PDFs with `access-control-allow-origin: *`
- arXiv supports range requests (`accept-ranges: bytes`, `206` on a ranged GET)

Those two together mean PDF.js can stream a PDF from a WebView with no proxy and no download
step. Verify them yourself rather than trusting this document.

---

## 2. What to build first

**Not the app.** The risk is not "can I make a list screen" — it is **"does arXiv's HTML
actually reflow into a phone width without breaking"**. If that fails, the product fails, and
you want to know on day one.

Build a throwaway page that fetches one paper's HTML, applies a stylesheet, and renders in a
mobile-width browser. Screenshot it. If text overflows, you have found the real work.

Only after that is proven should you create the app project.

---

## 3. Build order

Each stage ends with something you can check. Do not start the next one until it passes.

### Stage 1 — Prove the reflow (no app)

Effort: a day. Output: one paper, readable, no horizontal scroll.

1. Fetch `https://arxiv.org/html/<id>` server-side and write it to a file.
2. Write a stylesheet that: sets `max-width` on the article column, hides site chrome, sizes
   text for a phone, and makes wide things scroll inside themselves.
3. Render it in a browser at 390×844, with **real mobile emulation** (see Trap 1).
4. Measure `document.documentElement.scrollWidth - clientWidth`. It must be 0.

Test at least six papers from different categories. The failures are structural and
paper-specific: footnotes, unparsed formulas, wide tables, long URLs.

**You are done when** six papers in six categories all report zero overflow and zero elements
wider than the viewport.

Classes you will need to handle (all observed on real papers):

| Selector | Why |
|---|---|
| `.ltx_note_outer` | Footnote bodies render inline; 16 of them made one page 869 px wide |
| `.ltx_math_unparsed` | Formulas LaTeXML could not convert; unstyled inline blobs, one measured 673 px |
| `.ltx_table table`, `table.ltx_equation` | Fixed-width tables; give each its own horizontal scroller |
| `math` | Inline MathML wider than the line |
| `.arxiv-html-header`, `.html-header-nav` | arXiv's own site header and icon toolbar, sticky and dark |
| `#announcement-banner` | arXiv's site-wide banner |
| `.ltx_page_navbar` | LaTeXML's fixed table-of-contents sidebar, 760 px tall |

### Stage 2 — The app shell

```bash
npx create-expo-app@latest daily-papers --template blank-typescript
cd daily-papers
npx expo install expo-router react-native-webview react-native-safe-area-context react-native-screens expo-system-ui
```

Two structural decisions to make here:

- **Routing.** `expo-router` with a Stack. The reader is a pushed screen; the list screens get
  a drawer control on the left.
- **Theme.** Do not use `prefers-color-scheme`. An article that disagrees with the app chrome
  around it is a bug the user cannot fix. Store an explicit light/dark choice and set it on
  the document — see Trap 4.

**You are done when** an empty screen renders at phone width in Expo Go on a real device.

### Stage 3 — The reader, injected

This is the core. The WebView loads arXiv's page directly (top-level navigation has no CORS
problem; fetching the HTML in JS does).

1. Build the stylesheet as a **string**, imported into the app. Generate it from a source CSS
   file so the thing you tested in Stage 1 and the thing you ship cannot drift.
2. Inject it with `injectedJavaScriptBeforeContentLoaded`, so it applies before arXiv's CSS
   paints.
3. Add a small JS surface the app can call:

```
window.__dpTheme(theme)        set data-theme
window.__dpRestore()           scroll to the saved spot, report where it landed
window.__dpFind(term)          highlight, report a count
```

4. Have the page post messages back:
`{type:'position', fraction, anchor}`, `{type:'ready'}`, `{type:'restored', ...}`.

**Design the position format now** (next stage depends on it): store
`{fraction: 0..1, anchor: index-of-topmost-block-element}`. A fraction alone drifts because
lazy figures change the document height; a pixel offset is meaningless after reflow. The
anchor is an index into `document.querySelectorAll(blockSelector)` where `blockSelector` is a
generous list (`article p, article h2, … article figure, article table, article li`).

**You are done when** a real paper renders on a device, in both themes, with no horizontal
scroll and no arXiv chrome.

### Stage 4 — State, and position restore

`AsyncStorage` is enough; a database is not.

Store: saved papers, history, recent searches, and positions. Two rules that matter:

- **Saved entries carry their own metadata**, not just an id. A paper reached through search
  is not in your bundled list, so an id alone leaves the saved screen blank offline.
- **The metadata cache must refuse placeholders.** If a record's title equals its id, it is
  not information. See Trap 5.

Restore needs three mechanisms, because one is not reliable:

1. The page re-applies the restore on a loop **until `readyState === 'complete'` and the
   height stops changing**. It must not stop on a stable height alone — a page that has not
   begun loading also has a stable height.
2. The app listens for `ready`, calls `__dpRestore()`, reads the reported landing position,
   and re-issues up to three times if it is more than ~2% off.
3. A header button does it on demand, on a page that has definitely settled.

**You are done when** you can scroll halfway, leave, return, and land within a screen of where
you were, repeatedly.

### Stage 5 — Content and discovery

- Bundle a paper list as a JSON asset. **Trim the abstracts.** Measured: a full abstract
  averages ~1,480 characters and dominates each record. At 1,765 bytes/paper, 300 papers is
  530 KB. Cutting to the first ~320 characters at a sentence boundary gives 482 bytes/paper —
  1,000 papers in 471 KB, smaller than the 300 it replaced. Nothing in the UI shows more than
  two lines.
- Search arXiv's API on submit, not per keystroke. Two parameters: `search_query` for terms
  and `id_list` for a known paper.
- **Old-style ids need translating.** `math.GT/0309136` returns nothing from the API;
  `math/0309136` returns the paper. Strip the category.

### Stage 6 — The second renderer

Only for the ~4% of papers with no HTML (measure your own rate). Detect it from the HTTP
status of the HTML page and fall back.

Use PDF.js 3.11.174's **classic UMD build**, not the v4 ESM one: module loading from a
null-origin document is exactly what WebViews differ on. Load it from a CDN with a
`<link rel="preconnect">`.

Two things that make it feel fast, both measured:

- Cap the canvas at `devicePixelRatio` **2**. A phone reporting 3 rasterises every page at
  3× for detail nobody can see at this size.
- Render page 1 and await it **before** attaching the scroll observer. Otherwise the paper
  appears after the first observer callback.

Use the same position model: anchor = page index.

### Stage 7 — Comforts

Text size (one CSS variable), find-in-page (wrap matches in `<mark>` by walking text nodes),
share, offline text, a daily reminder. Add these only once Stages 1–6 are solid; each is
another way for the app to be broken during the week you are trying to judge it.

---

## 4. The traps

Every one of these cost real time and produced a wrong fix first. They are listed with the
symptom, because the symptom is what you will actually notice.

**1. Headless Chromium clamps the viewport to 500 px.**
Symptom: your measurements say the page fits, the phone says it does not.
Cause: `--window-size=390,844` does not produce a 390 px layout viewport.
Fix: WebDriver with `mobileEmulation.deviceMetrics`. Verify by asserting
`document.documentElement.clientWidth === 390` before measuring anything.

**2. `white-space: nowrap` on citation markers clips bibliography URLs.**
Symptom: text is *missing*, not overflowing — the bibliography entry is just gone.
Cause: LaTeXML reuses `.ltx_ref` for URLs (`<a class="ltx_ref ltx_url">`). `nowrap` makes the
URL unwrappable; the page cannot scroll sideways; the overflow is clipped.
Fix: no `nowrap` on `.ltx_ref`. Numeric markers have no break opportunity and stay together
anyway.

**3. `injectedJavaScriptBeforeContentLoaded` does not fire on every load.**
Symptom: the old layout and the horizontal swipe come back **on some papers**. It looks
paper-specific; it is timing.
Fix: pass the same stylesheet again as `injectedJavaScript` (runs after load) and re-apply.
Idempotent, so a page that already has it is untouched.

**4. Putting anything that changes during use into the WebView's `key`.**
Symptom: toggling the theme reloads the article and jumps to the position it was opened at.
Cause: a React `key` change remounts the component; for a WebView that means a reload.
Fix: inject the change (`setProperty` on a CSS variable, `setAttribute` for the theme). The
`key` may contain only values fixed for the lifetime of the screen.

**5. A metadata cache that records its own bug.**
Symptom: entries that showed an id instead of a title never repair, even after you write the
repair.
Cause: the saved screen renders the same card as everywhere else; the card registers what it
renders; so the broken entry registered itself as the cached metadata for its id. The repair
read that back, found nothing changed, and stopped. The cache is persisted, so it survived
restarts.
Fix: refuse to cache a placeholder (title === id, or empty abstract), and check again on read.

**6. An effect cleanup that cancels work that has to finish.**
Symptom: a repair loop processes one item and then silently stops.
Cause: React runs effects twice in development. The first pass claimed the item and started
the work; the cleanup set `alive = false`; the second pass saw the item already claimed and
returned.
Fix: do not tie work that must complete to an effect's lifetime. Apply results through
functional state updates.

**7. WebDriver does not return a value from an IIFE.**
Symptom: an inspection script returns `null` and you conclude the DOM is wrong.
Cause: the script is wrapped in a function body; `return` inside an IIFE returns from the
IIFE.
Fix: a top-level `return`, with no IIFE wrapper.

**8. A synthetic `.click()` does not drive a React Native Web `Pressable`.**
Symptom: a test passes because two screenshots are byte-identical, or fails because the state
never changes.
Fix: dispatch the full sequence (`pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`),
or better, assert on state you can read rather than on a simulated gesture.

**9. `expo-router` imports `expo-linking`.**
Symptom: removing an apparently unused dependency breaks the bundle with an error inside
`node_modules/expo-router`.
Fix: grep what the framework imports, not only what your code imports.

---

## 5. How to verify

Typechecking proves almost nothing about a reader. Two harnesses, both in
`mobile/harness/`, are worth copying:

**`run_reader_mvp.py`** — exports the web build, serves it, drives headless Chromium at an
emulated phone viewport, and screenshots each screen. Checks: the list renders, a paper opens,
the saved screen works.

**`check_restore.py`** — the important one. It imports the *actual* injected script from the
app (via `tsx`, so it cannot drift), loads **real arXiv HTML**, scrolls, reads the reported
position, then reloads with that position and measures where the page lands. It asserts on
pixels, not on intent.

That harness is how the restore bug was finally found, after two fixes reasoned about the
wrong layer.

---

## 6. When to stop

Build Stages 1–5 and you have the product. Everything after that is preference.

Things that look essential and are not: an account system, a recommendation engine, a
backend, a design system. The app works with none of them.

The one thing worth adding before a long test: **a diagnostics screen that reports version,
device and state counts, and can copy them.** During a week of use you will otherwise be
unable to describe what you saw.

---

## Appendix — where to look in the reference implementation

| Concern | File |
|---|---|
| The reflow stylesheet (source of truth) | `reader/static/reader.css` |
| Its app-side overrides | `mobile/scripts/gen-reader-css.mjs` |
| The generated string the app imports | `mobile/src/platform/readerCss.generated.ts` |
| The injected script and its message protocol | `mobile/src/readerScript.ts` |
| The PDF renderer | `mobile/src/pdfViewer.ts` |
| Position, saves, history, metadata cache | `mobile/src/library.tsx` |
| Repair of records written before their metadata | `mobile/src/useRepair.ts` |
| The reader screen | `mobile/app/read/[id].tsx` |
| Verification | `mobile/harness/` |
