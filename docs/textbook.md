# Building a Mobile Reader for Scientific Papers

*A textbook in six parts, using this repository as the worked example.*

---

## Contents

**Part I — The Document Problem**
1. Two incompatible models of a page
2. How arXiv publishes a paper
3. The box model, and why things overflow
4. Measuring layout

**Part II — Crossing the Boundary**
5. Two JavaScript contexts
6. Styling a document you do not own
7. Theme as state, not as preference

**Part III — Position in a Changing Document**
8. Why scroll offsets do not survive
9. Anchors
10. Timing, and the closed loop

**Part IV — State**
11. What to persist, what to derive
12. Caches that lie
13. Repair
14. Effects, and work that must finish

**Part V — Verification**
15. The oracle problem
16. The harness as a first-class artifact

**Part VI — Shipping**
17. What ends up in the bundle
18. Building

**Appendices** — A: glossary · B: the message protocol · C: checkpoints · D: reading list

---

# Part I — The Document Problem

## 1. Two incompatible models of a page

A scientific paper is a page. Not a page in the loose sense of "a web page", but a physical
sheet with fixed dimensions, a fixed measure, and a typesetter's decisions about where every
glyph sits. TeX was built for exactly this: you tell it the paper size, and it computes
coordinates. A PDF page is a list of instructions — put this glyph at this x, this rule at
this y. Nothing in it says "this is a paragraph".

The web is the opposite. There is no page. There is a viewport of unknown width, a tree of
elements, and an algorithm that resolves sizes recursively. Text reflows; the document grows
downwards forever; a "page break" is not a concept.

These models cannot be reconciled by scaling. Zooming a two-column A4 layout into a 6-inch
viewport produces text that is technically visible and practically unreadable: the measure is
too long for the eye, and the reader spends the session panning. The content has to be
**restructured from semantics**, not transformed from geometry.

That single observation determines the entire architecture of this app. Everything that
follows — a WebView, injected CSS, a scroll anchor model — is downstream of it.

### The consequence: you need semantics

To restructure you must know what each piece of the document *is*: this is a paragraph, this
is an equation, this is a figure caption, this is a footnote body. A PDF does not tell you. An
HTML document can, if it was generated from the source rather than typeset from it.

This is why the app reads arXiv's **HTML** rendering rather than its PDF. The PDF is the
finished artifact and knows nothing about structure. The HTML is a reconstruction of the
source document's tree, and its classes name roles.

---

## 2. How arXiv publishes a paper

LaTeXML is a converter from LaTeX to XML/HTML. It does not screenshot the page; it parses the
document and emits a tree that preserves the author's structure.

What it produces looks like this, in outline:

```
<article class="ltx_document">
  <div class="ltx_page_header">      site chrome, arXiv's logo and link
  <nav class="ltx_page_navbar">      table of contents, position: fixed
  <div class="ltx_page_content">
    <h1 class="ltx_title_document">  the title
    <div class="ltx_authors">        byline, one span per author
    <div class="ltx_abstract">       the abstract
    <section class="ltx_section">    body, recursively
      <p class="ltx_para">
      <figure class="ltx_figure">
      <table class="ltx_tabular">
      <math>                          native MathML
      <span class="ltx_note_outer">   a footnote, body included
```

Two properties of this tree matter more than the rest.

**The classes are semantic, not presentational.** `ltx_para` means "paragraph". It does not
mean "12pt, ragged right". That is what makes restyling possible: you can give every
`ltx_para` a different measure, and the document still works, because the class encodes role
rather than appearance.

**But the accompanying stylesheet assumes a wide canvas.** LaTeXML ships CSS written for a
journal column; arXiv adds its own site chrome on top. Load the page in a phone browser and
you get a desktop layout squeezed into 390 pixels.

### What you actually encounter

Reading several papers is the only way to learn this. A partial inventory of what shows up and
what it implies:

| Markup | What it is | What it implies |
|---|---|---|
| `ltx_page_header`, `arxiv-html-header`, `html-header-nav` | arXiv's site header and icon toolbar | Must be removed; it is not the paper |
| `#announcement-banner` | A site-wide banner | Same |
| `ltx_page_navbar` | Table of contents, `position: fixed` | Must be removed; it overlays the text |
| `ltx_note_outer` | Footnote body, rendered **inline** | LaTeXML's own CSS hides it until hover. Remove that CSS and the bodies join the text flow |
| `ltx_math_unparsed` | A formula LaTeXML could not convert | Unstyled inline blob |
| `ltx_ref` | A cross-reference — **and also URLs** | The class is overloaded; see §3 |
| `ltx_eqn_table`, `ltx_tabular` | Fixed-width table layout | Cannot reflow; must scroll inside itself |
| `math` | Native MathML | Rendered by the browser; width is intrinsic and fixed |

The `ltx_note_outer` row is the important lesson. Removing a stylesheet does not just *change*
appearance; it removes behaviour the markup was *relying on*. The document was written
assuming a stylesheet would hide those bodies. Delete the stylesheet and the document is
still well-formed HTML and no longer means what it meant.

When you replace someone's stylesheet, you inherit every implicit contract it was holding up.

### Checkpoint

Fetch five papers from different categories. For each, list the distinct `ltx_*` classes. The
ones that appear across all five are the ones your stylesheet must handle first.

---

## 3. The box model, and why things overflow

Horizontal overflow on a reflowed document has a small number of root causes. Knowing them
turns "the page is too wide" into a specific diagnosis.

### How widths resolve

Every element's width is resolved against its **containing block** — normally the content box
of its nearest block-level ancestor. For a block-level element, `width: auto` means "fill the
containing block, minus margins and borders". That element can never overflow.

Overflow happens when an element's width is *not* determined by its container:

1. **Replaced elements** — `<img>`, `<svg>`, `<video>`, `<canvas>` — have intrinsic dimensions.
   A 1200-pixel-wide image in a 390-pixel column overflows unless constrained.
2. **Tables** — `display: table` computes column widths from content. A five-column table has a
   `min-content` width that is the sum of its columns' minimums, and it will grow past its
   container rather than wrap.
3. **Unbreakable inline content** — a long URL, or a run given `white-space: nowrap`, has a
   minimum width equal to its full length. `overflow-wrap: anywhere` is what allows it to break.
4. **Inline-block and intrinsic sizing** — an element with `display: inline-block` and no width
   shrink-wraps its contents, so it takes their width, whatever the container is.
5. **Positioned or fixed elements** — out of flow, sized against a different containing block.

### `min-content` is the underlying quantity

The clean mental model: for any element, CSS computes a *minimum content width* below which it
cannot go. A block box's minimum is the largest minimum among its children. If any descendant
has a minimum wider than the viewport, something will overflow, and `width: auto` on the
ancestors will not help.

This is why "constrain the container" fails and "constrain the offending element" works. The
fixes are therefore structural: cap images, give tables their own scroll container, allow
words to break, cap MathML.

### `overflow-x` — three different things

These are not interchangeable, and the difference matters for touch devices:

- `overflow-x: hidden` — clips, **and establishes a scroll container**. The element is
  scrollable programmatically, and the browser may still respond to a gesture.
- `overflow-x: clip` — clips **without** creating a scroll container. There is nothing to
  scroll, by any means.
- `overflow-x: auto` — creates a scroll container that shows scrollbars when needed.

For a reader you usually want `clip` on the document, and `auto` on the *individual* wide
things (tables, equations) so they remain reachable.

### The layer CSS does not cover

Here is the subtlety that cost real time on this project. Clipping the page horizontally does
not stop a **touch gesture**. A WebView can still translate the document sideways on a drag,
even when `scrollWidth === clientWidth`.

That is because scrolling is driven by the *gesture* layer, not purely by overflow. The
control for it is `touch-action`:

```css
html, body {
  touch-action: pan-y;          /* vertical panning only; horizontal drags do nothing */
  overscroll-behavior-x: none;  /* no rubber-band at the edges */
}
```

`touch-action` is the direct answer to "swiping left drags the page off the edge". It is
independent of layout. If your measurement says the page does not overflow and the phone still
pans, this is the missing piece.

### Case study: the rule that was itself the bug

A rule added early to keep numeric citation markers — `[12]` — from breaking across lines:

```css
.ltx_ref { white-space: nowrap; }
```

The intent is reasonable. It produced a bug that took a while to *see*, because the symptom
was not overflow but **absence**: a bibliography entry was simply missing from the page.

The cause: LaTeXML reuses `ltx_ref` for URLs, emitting `<a class="ltx_ref ltx_url">`. `nowrap`
makes a URL unwrappable. Once the page was also prevented from scrolling sideways, the part
that hung past the edge was **clipped** — not wrapped, not scrollable. The text was gone.

Two lessons generalize:

- **A class name may be overloaded.** Read the markup before styling a selector you did not
  see emitted.
- **Clipping converts an overflow bug into a missing-content bug**, which is harder to notice.
  Prefer allowing breaks (`overflow-wrap: anywhere`) over forbidding them.

### When you must override

You are styling markup you do not control, alongside stylesheets you do not control, loaded in
an order you do not control. This is the one situation where `!important` is the correct tool
rather than a smell: you are deliberately winning a cascade against a third-party stylesheet.

---

## 4. Measuring layout

You cannot fix overflow by looking at it. The judgement "it seems to fit" is unreliable at
phone size, and it is wrong in both directions — clipping looks fine, and a 12-pixel overflow
is invisible.

### The three widths

Three numbers get conflated and must not be:

- `window.innerWidth` — the **visual viewport**, affected by pinch-zoom.
- `document.documentElement.clientWidth` — the **layout viewport**, what CSS lays out against.
- `window.screen.width` — the physical screen, in CSS pixels, unrelated to the window.

Layout questions are answered by `clientWidth`.

### The overflow oracle

```js
const de = document.documentElement;
const overflowX = de.scrollWidth - de.clientWidth;
```

Zero means the document does not overflow horizontally. This is a single number, it is
monotonic in badness, and it can be asserted in a test. Use it instead of an opinion.

To find the *cause*, walk the tree and report elements whose border box is wider than the
viewport or whose right edge extends past it — the offenders are almost always one of the five
categories in §3.

### Why headless browsers lie

Chromium enforces a **minimum window width of roughly 500 CSS pixels**. Passing
`--window-size=390,844` does not give you a 390-pixel layout viewport; the layout viewport is
clamped. Every measurement taken that way describes a 500-pixel phone, and a page can pass at
500 while overflowing at 390.

The fix is not a flag but **device emulation**, which overrides the viewport metrics rather
than the window: Chrome DevTools' device mode, or WebDriver's
`mobileEmulation.deviceMetrics`.

The guard that would have caught this immediately:

```js
if (document.documentElement.clientWidth !== 390) throw new Error('wrong viewport');
```

Assert the viewport before measuring anything. It is the cheapest check in this document and
it invalidates an entire afternoon of results.

### Device pixels versus CSS pixels

`devicePixelRatio` is how many physical pixels back one CSS pixel. A phone reporting `3` means
a 390-CSS-pixel viewport is 1170 physical pixels wide.

This matters in exactly one place in this app — rasterisation — and it is the difference
between a PDF that renders quickly and one that does not. See §17.

### Checkpoint

Build the measurement harness before the app. A page that loads one paper, applies your
stylesheet, and prints `overflowX` and the offending elements. Confirm the viewport is 390
first. If you cannot make one paper measure zero, no amount of app code will help.

---

# Part II — Crossing the Boundary

## 5. Two JavaScript contexts

A WebView is not a component. It is a browser, and it runs its own JavaScript in its own
global scope, isolated from yours.

There are two runtimes:

```
   your app (Hermes / JSC)          │        the page (WebKit / Blink)
   ────────────────────────         │        ────────────────────────
   React, state, storage            │        DOM, window, document
                                    │
   injectJavaScript(code) ──────────┼──────▶ evaluates `code` in the page
                                    │
   onMessage(event) ◀───────────────┼──────── window.ReactNativeWebView.postMessage(s)
```

Both directions are **asynchronous and have no return value**. `injectJavaScript` is
fire-and-forget: it evaluates the string and returns nothing. So any operation that produces a
result — "how many matches did you find?", "where did the scroll land?" — must be structured as
*request and callback*: you inject a call, and the page posts the answer back.

This shapes the whole protocol. It is worth naming: **the bridge is message-passing between
two processes**, and the discipline that follows is the same one you would apply to any RPC —
typed messages, one channel, and no shared mutable state.

### Injection timing

Two props, and the difference between them is the whole game:

| Prop | Runs | What exists |
|---|---|---|
| `injectedJavaScriptBeforeContentLoaded` | at document start, before the parser builds the tree | `document.documentElement` may exist; `document.head` may not; no body, no elements |
| `injectedJavaScript` | after the load event | the full tree |

The first is what prevents a flash of unstyled content: your stylesheet lands before the page
paints. The second is your backstop.

The trap: **the first does not fire on every load on every WebView.** When it silently does
not, the page renders with the original stylesheets and your injected state does not exist.
The symptom is not a crash; it is the old layout reappearing — which reads as "it happens on
some papers" and sends you looking at the papers.

The fix is not to switch props. It is to accept that the early injection is best-effort, and
make everything it does **idempotent** so it can be safely repeated later:

```js
// Safe to call at document start, at load, and on every theme change.
function applyCss() {
  let el = document.getElementById('__reader_css');
  if (!el) {
    el = document.createElement('style');
    el.id = '__reader_css';
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = CSS;
}
```

An idempotent function that runs twice is a no-op the second time. A function that *appends* is
a bug the second time. In a boundary where you cannot guarantee call counts, idempotence is not
a nicety; it is the correctness condition.

### Why not just fetch the HTML and render it ourselves?

Because the page is not a string, it is a document with dependencies: relative image URLs,
external stylesheets, fonts, MathML that only the browser can lay out. Re-hosting it means
rewriting every relative URL and keeping the base correct.

Loading the page in a WebView preserves all of that for free — relative URLs resolve against
the page's own location, and the browser does what it was built to do. The cost is that you
inherit someone else's document, which is what Part II is about.

---

## 6. Styling a document you do not own

### The cascade as a negotiation

Four origins compete: the browser's defaults, arXiv's stylesheet, LaTeXML's stylesheet, and
yours. Yours is injected last but has no control over specificity.

Practical rules:

- Prefer matching the **existing semantic classes** over tags, since the markup uses classes
  deliberately.
- Use `!important` for anything layout-critical. You are not fighting yourself; you are
  overriding a third-party stylesheet whose author did not know you existed.
- Set the base on `html, body` early, because LaTeXML's rules often target the same elements
  with higher specificity.

### The single-source-of-truth problem

There are two consumers of the stylesheet: the verification harness (which serves a local
page) and the app (which injects a string). If those diverge, you verify one thing and ship
another.

The solution here is codegen: one CSS file is the source, a script wraps it with app-specific
overrides, and the app imports the generated string. The generated file is committed so builds
do not require the script, and it carries a header saying it is generated.

A codegen step is a real cost — an extra build dependency and a file that must not be hand-
edited. It is worth it when the alternative is silent divergence between tested and shipped.

### The remount trap

A React `key` identifies a component instance. Changing it **unmounts and remounts**. For a
WebView, unmounting destroys the native browser view, and remounting creates a new one that
loads the URL again.

So the `key` must contain only values that are **fixed for the lifetime of the screen**. If it
contains anything that changes during use — the current scroll position, the theme — the page
reloads whenever that changes.

This produced a specific, confusing bug: toggling the theme reloaded the article and jumped to
the position the paper had been *opened* at. Two symptoms — "the theme reloads the page" and
"it jumps to the wrong place" — with one cause.

The rule generalizes beyond WebViews: **`key` is for identity, not for state.** State that
changes goes in props.

---

## 7. Theme as state, not as preference

The obvious way to support dark mode is `@media (prefers-color-scheme: dark)`. For a reader it
is wrong, for two reasons.

**The article and the chrome can disagree.** The operating system sets one preference. The app
has its own colours. Using the media query independently in the article's CSS lets the page
render dark inside a light app — the reader cannot fix it, because the preference is the
system's.

**The user cannot override it per-app.** Some people prefer dark for the app but want papers
on white. A system preference cannot express that.

So theme is **application state**: a stored `'light' | 'dark'`, applied explicitly.

### Propagating theme without reloading

The page is already loaded. You need to change its appearance without a reload, which rules
out re-injecting the whole script and rules out remounting.

Two mechanisms, both cheap:

```js
document.documentElement.setAttribute('data-theme', theme);
```

with the stylesheet written as

```css
:root { --bg: #fff; --fg: #1a1a1a; --font-size: 18px; }
html[data-theme='dark'] { --bg: #16181c; --fg: #e6e6e6; }
body { background: var(--bg); color: var(--fg); font-size: var(--font-size); }
```

Everything downstream reads **custom properties**, so a single attribute flips the palette and
a single `style.setProperty` changes the text size. This is the same mechanism that makes the
text-size control a one-line operation rather than a second stylesheet.

### The native header is a separate problem

The app's navigation header is drawn by the platform, not by your React tree. It reads the
platform appearance, so setting a `headerStyle` background is not always enough — the native
header can keep the system appearance independently.

On React Native the lever is `Appearance.setColorScheme(theme)`, which overrides the system
scheme for the whole app. It is not implemented on every platform, so it must be guarded:

```js
try {
  if (typeof Appearance?.setColorScheme === 'function') Appearance.setColorScheme(theme);
} catch { /* platform does not support forcing a scheme */ }
```

The unguarded call is not a no-op on platforms that lack it — it throws during mount and
blanks the screen.

A further subtlety: React Navigation memoises header options. An inline `headerRight` closure
can keep rendering a captured value after the state changes. The fix is to make the control its
own component that subscribes to the context, so it re-renders on its own rather than relying
on the navigator to re-render it.

---

# Part III — Position in a Changing Document

## 8. Why scroll offsets do not survive

Restoring a reading position looks trivial and is not. The difficulty is not storage; it is
that **the thing you are measuring is not stable**.

Three failure modes, in increasing subtlety:

**Reflow.** `window.scrollY` is a distance in pixels from the top of the document. If any
content above the reader's position changes height — a font loads, an image arrives, the text
size changes — everything below shifts, and the same pixel offset now points somewhere else.

**A moving denominator.** The natural repair is to store a fraction: `scrollY / (scrollHeight -
innerHeight)`. But `scrollHeight` is the document height, and in a document with lazy-loaded
figures it grows after load. The numerator is fixed at save time and the denominator is not, so
the stored fraction no longer describes the same place.

**Different structure.** Enabling an "offline copy" or changing the renderer can produce a
document whose element order differs from the live one. Any position expressed in terms of that
order shifts.

The requirement is therefore not "a number" but **an invariant**: something that identifies the
same piece of content across all of these changes.

---

## 9. Anchors

An anchor is a stable reference into the document. Two families:

**Structural — an index into a filtered element list.** Choose a selector describing block
content, take the index of the topmost visible element:

```js
const BLOCK_SELECTOR =
  'article p, article h2, article h3, article figure, article table, article li';

function currentAnchor() {
  const nodes = document.querySelectorAll(BLOCK_SELECTOR);
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getBoundingClientRect().bottom > 8) return i;
  }
  return -1;
}
```

Cheap, and cheap to restore (`scrollIntoView`). Its weakness is that it depends on the element
list being the same between sessions — which is why the selector list should be **generous**.
A paper with an unusual structure still yields *some* elements; an index into a longer list is
no less stable than one into a shorter list.

**Content — a text snippet.** Store a few words of the top visible paragraph and search for
them on restore. Robust to structure changes, but requires matching, and fails on text that
repeats.

The engineering answer here is a **hybrid**: anchor first, fraction as the fallback, and a
record that carries both.

```ts
interface ReadingSpot { fraction: number; anchor: number }  // anchor = -1 when unknown
```

Restore tries the anchor; if the element does not exist (older record, different structure), it
falls back to the fraction. This also gives a migration path for free: a record written by an
older version that only had a fraction is still readable.

### Why the anchor leads

The fraction is derived from a denominator that changes; the anchor is not. So when they
disagree, the anchor is more likely right. Assertions in the harness compare against the
anchor's actual position, not the fraction target — an early version of the test asserted the
fraction and reported a failure for a restore that had done exactly the right thing.

---

## 10. Timing, and the closed loop

Even a correct anchor is useless if it is applied at the wrong moment.

### The document arrives in pieces

At `DOMContentLoaded` the tree exists but images have not loaded and the height is provisional.
By `load` most subresources are in, but lazy content is not. In a document that renders figures
on demand, the height can keep changing for seconds.

Restoring into a provisional layout puts the reader at the anchor's *old* position in the *new*
document, which is wrong by however much the document has grown above it.

### The stability heuristic, and its bug

A natural fix: re-apply the restore on a loop until the document height stops changing.

```js
let lastHeight = -1, stableFor = 0;
(function settle() {
  applyRestore();
  const h = document.documentElement.scrollHeight;
  if (h === lastHeight) { if (++stableFor >= 3) return; }
  else { stableFor = 0; lastHeight = h; }
  setTimeout(settle, 350);
})();
```

The bug is in the premise. **A page that has not started loading also has a stable height.** On
a slow connection the loop observes an unchanging blank page, concludes the layout has settled,
and exits before there is anything to scroll. The position is saved correctly and never
applied — which reads as "restore is broken", not "restore ran too early".

The correction is to require that loading has actually finished before stability means anything:

```js
if (document.readyState === 'complete' && h > 0 && h === lastHeight) { /* stable */ }
```

This is a general lesson about heuristics: a heuristic built on "no change" must first establish
that the process has *started*.

### Why a fixed retry count is worse

Replacing the stability check with "try 14 times" looks safer and is not: it hard-codes a
duration. Fourteen attempts at 350 ms is about five seconds, which is generous for a fast page
and too short for a slow one. The correct budget is not a time but a **condition**.

### Closed loop

Any open-loop restore — fire and hope — can be wrong without knowing it. The improvement is to
close the loop: act, observe the result, correct.

```
page  ──▶ {type:'ready'}
app   ──▶ __dpRestore()
page  ──▶ {type:'restored', fraction, anchor}
app   compares to target; if off by > 2%, re-issues, up to 3 times
```

This is why the app has three restore mechanisms, and they are not redundant — they give
different guarantees:

| Mechanism | Guarantee |
|---|---|
| page-side settle loop | works without the app being involved; best-effort, timing-dependent |
| app-side verify and retry | converges; depends on the bridge |
| header button | runs on a page that has definitely settled; depends on the user |

The button is not a fallback for a broken feature. It is the mechanism with the strongest
precondition — a human deciding the page is ready.

---

# Part IV — State

## 11. What to persist, what to derive

A mobile app's local state splits into two kinds, and conflating them causes trouble.

**Records** — created by using the app. Saved papers, reading history, positions. The user
would notice their loss, and there is no way to recompute them.

**Settings** — created by choosing. Text size, theme, a reminder time. Loss is annoying, not
serious, and the values are from a small fixed domain.

Keeping them apart has a concrete benefit: settings can be validated and defaulted in one
place, and records can have a repair policy (§13), without either concern leaking into the
other. The reference implementation has `src/settings.tsx` and `src/library.tsx` for this
reason, and the split was made after the library had already grown to hold five kinds of
record.

### Denormalization, and its price

A saved paper stores its own title, authors and abstract — not just an id.

The reason is offline behaviour: a paper reached through search is not in the bundled list, so
an id alone leaves the saved screen with nothing to render without a network round trip.

The price is duplication, and with duplication comes the possibility of **inconsistency**: the
stored copy can be older or worse than the truth. That possibility is not hypothetical, and it
is what §12 and §13 are about. Denormalizing is a trade — accepting a repair obligation in
exchange for a self-contained record.

---

## 12. Caches that lie

A cache is a promise: *this value is authoritative enough to skip recomputation.* Every cache
bug is a broken promise.

### The self-poisoning cache

The cache in this app maps paper id → metadata, so a paper can be opened cold and still have a
title. It is populated whenever a paper appears on screen.

The bug: the Saved screen renders the same card component as everywhere else, and that card
registers what it renders. So a *broken* saved record — title equal to its id, no abstract —
registered itself as the cached metadata for its own id.

Then the repair path read the cache, got a hit, found nothing had changed, and stopped. The
cache had absorbed the bug and was now enforcing it.

```
saved record (broken)  ──renders──▶  cache[ id ] = broken
repair                 ──reads───▶  cache[ id ] ✓ hit
                       ──compares─▶  identical
                       ──stops───▶  record stays broken forever
```

Two rounds of fixes failed before this was found, and because the cache is persisted, the
poisoned entry survived app restarts.

### The general rules

**A display layer must not write to a source of truth.** Rendering is not an opinion about
correctness; a component that renders arbitrary input must not promote that input into a cache.

**Validate on write, and again on read.** The write-side guard (`refuse to cache a placeholder`)
prevents new poisoning. The read-side guard catches devices that were already poisoned — because
you can fix the code but you cannot fix the data already on someone's phone.

**A cache hit is not a repair.** "The cache has an answer" and "the cache has a *correct* answer"
are different claims. If a repair path treats any hit as success, it will treat a cached copy of
the bug as success.

---

## 13. Repair

The general situation: **records written before their data was known.** A user opens a paper
cold, taps save before the metadata lookup returns, and a record exists with a placeholder title.

There are three responses, and only one of them is right:

- **Reject the record.** Loses data; the user's tap appears to do nothing.
- **Leave it.** The placeholder persists; the record is permanently degraded.
- **Repair it in place.** Read-repair: when a record is displayed, if it is incomplete, fetch
  what is missing and update it.

Read-repair is the right shape for local storage because there is no background process and no
server to run a migration. The display path is the only place you reliably get attention.

### Properties a repair loop needs

**Idempotent.** Running it twice must not duplicate work or corrupt data. The test is `needs()`,
which must return false once repaired.

**Batched.** The repair queue may see hundreds of records, and each lookup is a network round
trip. Process a bounded number per pass and let the next pass continue. The effect re-runs when
records change, so the queue resumes by itself.

**Resumable.** If a lookup fails, do not mark the record as attempted forever. Clear the
in-flight marker either way; a later render will retry.

**In-flight tracked separately from attempted.** An `inFlight` set prevents a re-render from
starting a duplicate lookup; it is cleared on completion. An `attempted` set that is never
cleared is a trap — see §14.

---

## 14. Effects, and work that must finish

React's `useEffect` has a lifecycle that is easy to hold slightly wrong, and the wrongness
shows up as work that silently does not happen.

### What cleanup means

The function returned from an effect runs when the effect's dependencies change or the
component unmounts. Its purpose is to undo what the effect set up: unsubscribe, cancel a timer,
close a connection.

The subtlety: **cleanup means "this work is no longer needed for this render", not "cancel
everything you started".** For a subscription those coincide. For a network write they do not.

### The double-invoke

In development, React deliberately mounts, unmounts and remounts, running effects twice. This
surfaces effects that are not idempotent.

An effect that claims an item, starts an async lookup, and sets `alive = false` in its cleanup
fails this test in a specific way:

```
pass 1:  claim item, start lookup, set alive = true
cleanup: alive = false
pass 2:  item already claimed  →  pending is empty  →  return
         lookup completes      →  alive is false    →  abort
result:  nothing repaired, no error, no log
```

The guard designed to prevent a *stale update* prevented the *work*. And because the item was
already marked attempted, no later pass would pick it up.

### Classifying effects

The question to ask of any effect: **if this is torn down and re-run, is my work still needed?**

- Subscriptions, listeners, timers → cancellable. Clean up.
- Async reads that feed state → cancellable *if you re-run the read*. The double-invoke is safe
  because the second pass performs the read again.
- **Writes** — persisting a record, scheduling a notification → must complete. Do not tie them
  to a flag that a re-render can clear.

The pattern that satisfies both: apply results through a **functional state update**, which is
safe whenever it lands, and let the work finish.

```ts
void (async () => {
  try { const patch = await lookup(id); if (patch) apply(id, patch); }
  finally { inFlight.delete(id); }
})();
```

### Why functional updates matter here

`apply(id, patch)` should be `setState(prev => merge(prev, id, patch))`, not a closure over a
captured value. A closure computed at the start of a slow async operation will overwrite
everything that changed in the meantime. The functional form always sees the current state.

---

# Part V — Verification

## 15. The oracle problem

An automated check needs an oracle: a way to decide whether the result is right. For a compiler
the oracle is "does it produce the expected output". For a user interface it is harder, because
the thing you are checking is *what appears*.

Typechecking is not an oracle for this. It proves internal consistency — every value has the
type its consumer expects — and says nothing about whether a page scrolls, a title renders, or a
position restores. The bugs in this project were all type-correct:

- a stylesheet rule that clipped a bibliography entry (valid CSS)
- an effect that aborted its own work (valid React)
- a cache that recorded a bug (valid TypeScript)

### What can be measured

Three things, and they cover most of what matters:

**Rendered state.** Load the page at a known viewport and read the DOM: does an element exist,
what does `innerText` contain, what is `clientWidth`.

**Geometry.** `scrollWidth - clientWidth`, `getBoundingClientRect()`, `window.scrollY`. Geometry
is where layout bugs live.

**State transitions.** After an interaction, what do the counts say. Counts are better than
pixels because they are stable and readable.

### Screenshots are evidence, not oracles

A screenshot is invaluable for *understanding* a failure and dangerous as a *pass condition*.
Two identical screenshots can mean "the feature works" or "nothing happened at all" — and an
early harness in this project reported success on two byte-identical images.

If a screenshot is part of an assertion, compare it against something known, or pair it with a
numeric check.

### Assert on readable state, not on simulated gestures

Simulating a tap is fragile: the synthetic event may not reach the handler (a React Native Web
`Pressable` ignores a bare `.click()`), and a failure looks identical to a broken feature.

Prefer asserting on state you can read directly. When you must simulate, dispatch the full
pointer sequence and verify the state changed — never assert that the dispatch itself succeeded.

---

## 16. The harness as a first-class artifact

The harness is code. It has bugs, and its bugs produce false confidence, which is worse than no
test.

### Test the real thing

The most important property: **the harness must exercise the shipped code, not a copy of it.**

The position harness imports the actual injected-script module from the app, via the same
TypeScript toolchain, so the script under test and the script in the app are the same file. A
duplicated copy would drift, and the drift would be invisible — the test would keep passing
against a version nobody runs.

The general form: generate the artifact from the source at test time
(`npx tsx harness/make_script.ts` printing the script), rather than reimplementing it.

### Two traps already met

**A driver does not return from an IIFE.** When a WebDriver script is wrapped in a function
body, `return` inside an IIFE returns from the IIFE. The inspection call yields `null`, and it
looks like the DOM is wrong. Use a top-level `return`, or a trailing expression — never both
half-and-half.

**Element search may not see what rendering shows.** Some elements inside a React Native Web
virtualised list were present (52 via `querySelectorAll`) and unfindable via the driver's
element search. When that happens, drive the page with `executeScript` instead of element
handles.

### Measuring the landing, not the intent

The position harness does not ask "did the restore run". It scrolls, reads the reported
position, reloads with it, and measures where the page ended up in pixels. That is what
distinguishes "restore was called" from "the reader is back where they were" — and only the
second one is the feature.

### A failing test can be wrong

The first run of the position harness failed, and the failure was the test's fault: it asserted
against the fraction target while the restore was anchor-first, and the document height differed
between the two loads. A test that fails on correct behaviour will be "fixed" by weakening the
code. When a test fails, confirm the expected value is derived from the same quantity the code
is optimising.

---

# Part VI — Shipping

## 17. What ends up in the bundle

### Reachability

A JavaScript bundler includes modules reachable from the entry point. Files that nothing
imports are not bundled — which is why code can sit in a source tree at zero runtime cost, and
why an architecture test asserting the import boundary is worth more than a comment saying
"do not import this".

### Native modules are not free

A different rule applies to dependencies. **Native modules are autolinked**: a declared
dependency containing native code is compiled into the application whether or not JavaScript
calls it. An unused SQLite package is measured in megabytes of shipped binary.

The consequence is a discipline: dependencies must be justified by reachable use, and code that
needs heavy dependencies should live outside the app's source tree so the dependencies can be
removed.

### Paying only for what is read

The bundled paper list is a JSON asset. The dominant cost per record is the abstract: a full
abstract averages ~1,480 characters against a title of ~80. At 1,765 bytes per record, 300
records is ~530 KB.

Nothing in the UI displays more than two lines of an abstract. Truncating to the first ~320
characters at a sentence boundary drops the record to 482 bytes — so **1,000 records fit in
471 KB**, less than the 300 it replaced.

Two techniques make the truncation invisible:

- **Cut at a sentence boundary**, not at a character count. A sentence that stops mid-clause
  reads as a bug.
- **Fall back to a word boundary with an ellipsis** when no sentence end is near, and say so in
  the data.

The general principle: bundle what is displayed, fetch what is not. The full text is available
from the API when something needs it.

### Rasterisation and device pixels

The PDF renderer draws each page to a canvas. The canvas backing store is
`viewport.width × devicePixelRatio` pixels wide.

On a phone reporting `3`, rendering at the native ratio means nine times the pixel work of
ratio 1, for detail that is not visible at this size. Capping at `2` roughly halves the cost
and is one of the two changes that made PDFs open quickly.

The other is **ordering**: draw page one and await it *before* attaching the scroll observer.
Otherwise the first visible content waits for an observer callback that was never on the
critical path.

These are worth generalizing: when a pipeline feels slow, find the work that is not on the
critical path (defer it) and the work that is disproportionate to its visible effect (cap it).

---

## 18. Building

### Generated native projects

An Expo app has no `android/` directory in source control. It is generated by `expo prebuild`,
which reads `app.json`, resolves config plugins, and emits a native project with a manifest.

This is a real advantage for a small project: the native configuration is declarative, and the
generated directory is disposable. It also means **build errors surface late** — a config
plugin that does not resolve fails at prebuild, not at import. Running
`npx expo prebuild --platform android --no-install` is a cheap check that the configuration is
valid without needing the Android SDK.

### Two routes to an APK

**Cloud build.** A service runs prebuild and Gradle on its own machines and returns an artifact.
It needs an account but no local SDK. This is the only route available on a machine without
one, and it is also the only route to an iOS binary without a Mac.

**Local build.** Install the Android SDK and a compatible JDK, run prebuild, then Gradle.
`assembleDebug` produces an installable APK with a debug keystore; `assembleRelease` requires
a signing key you have created and configured.

A detail worth knowing before it costs an afternoon: **JDK versions matter**. Recent Gradle and
Android Gradle Plugin releases reject JDK versions newer than the ones they support. "Java is
installed" is not the same as "the right Java is installed".

### Versions

Two numbers, and they serve different purposes:

- `version` — human-facing, `1.2.0`.
- `versionCode` — an integer Android uses to compare installs. It **must increase** for each
  release; the platform refuses to install the same or a lower code over an existing app.

### Distribution

An APK belongs on a release page, not in the repository. A binary committed to git is cloned by
everyone forever; a release asset attaches to a tag and can be replaced.

---

# Appendices

## A — Glossary

| Term | Meaning here |
|---|---|
| **LaTeXML** | LaTeX → XML/HTML converter; produces the semantic tree the reader restyles |
| **layout viewport** | The width CSS lays out against; `documentElement.clientWidth` |
| **visual viewport** | The visible region, affected by zoom; `window.innerWidth` |
| **devicePixelRatio** | Physical pixels per CSS pixel |
| **min-content width** | The narrowest an element can be without overflowing its contents |
| **overflow: clip** | Clipping that creates no scroll container |
| **touch-action** | Which touch gestures the browser handles; `pan-y` allows only vertical |
| **anchor** | A structural reference into the document, stable under reflow |
| **read-repair** | Fixing an incomplete record at the moment it is displayed |
| **autolinking** | Native modules compiled in because they are declared dependencies |
| **prebuild** | Generating a native project from declarative app config |

## B — The message protocol

Everything crossing the bridge, in one place. Strings carrying JSON, one channel, discriminated
by `type`.

**Page → app**

| Message | Payload | When |
|---|---|---|
| `ready` | — | the document has loaded |
| `position` | `fraction`, `anchor` | on scroll, throttled |
| `restored` | `ok`, `fraction`, `anchor` | in reply to `__dpRestore()` |
| `find` | `count`, `index` | after a search or a step |
| `loaded` | `pages` | PDF only, when the document is parsed |
| `error` | `message` | PDF only, on failure |

**App → page**

| Call | Effect |
|---|---|
| `__dpTheme(theme)` | sets `data-theme` |
| `__dpRestore()` | restores and reports where it landed |
| `__dpFind(term)` / `__dpFindStep(n)` / `__dpFindClear()` | in-page search |
| `setProperty('--font-size', px)` | text size |

Rules the protocol implies: every call is idempotent; no call returns a value; anything the app
needs to know arrives as a later message.

## C — Checkpoints

A rebuild is on track if each of these holds when it is reached.

1. **After the stylesheet:** six papers, six categories, `scrollWidth - clientWidth === 0`, and
   `clientWidth === 390` asserted before measuring.
2. **After the reader:** a real paper renders on a device in both themes, with no arXiv chrome
   and no horizontal pan.
3. **After state:** scroll past the first screen, leave, return; the ⟲ is lit and lands within a
   screen of where you were — three times in a row.
4. **After the harness:** the position test fails if you deliberately break the anchor, and
   passes when you fix it. A test that cannot fail is not a test.
5. **Before shipping:** `clientWidth` measured on the real device, not just the emulator.

## D — Reading list

- **CSS `overflow` and formatting contexts** — the specifications for `overflow`, `min-content`,
  and `touch-action`; short and denser than any tutorial.
- **WebDriver `executeScript`** — the wrapping-and-return semantics, because the trap in §16 is
  documented and still easy to walk into.
- **React `useEffect`** — the "when does cleanup run" section of the docs, and the StrictMode
  discussion of double-invocation.
- **`expo prebuild` and config plugins** — how declarative config becomes a native project.
- **PDF.js** — the `getDocument` options, particularly `rangeChunkSize` and `isEvalSupported`,
  and the difference between the classic and module builds.

---

*The reference implementation for every mechanism described here is this repository. The
chapter headings map to directories: Part I to `reader/` and `mobile/src/platform/`, Part II to
`mobile/src/readerScript.ts`, Part III to `mobile/src/library.tsx`, Part IV to `library.tsx` and
`useRepair.ts`, Part V to `mobile/harness/`, Part VI to `mobile/app.json` and `docs/release.md`.*
