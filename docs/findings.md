# Findings

Measured results that shaped this app. Several come from a recommendation study that was
built, measured, and then dropped in favour of the reader — the code is in the git history,
and the numbers are kept here because they are the reason the current design looks the way it
does.

---

## The reader

### Figures are the payload, not the text

Measured on one 15,028-word paper:

| | size |
|---|---|
| arXiv page HTML | 423 KB |
| extracted article (text only) | 388 KB (91.6% of the page) |
| 62 figure images | **28.0 MB** (largest single figure 710 KB) |

The figures are **72× the article text**. Stripping arXiv's chrome saves only 8% — the win is
layout, not bytes. This is why figures are lazily loaded and why the offline copy stores text
only.

### Figures are not always `<img>`

LaTeXML emits raster figures as `<img src="…png">` and vector figures as
`<object type="image/svg+xml" data="…svg">`. `loading="lazy"` exists for the first and not the
second, and `<object>` has no equivalent. On the sample above, 12 of 17 graphics were raster.

### Figure paths carry the version

A figure is `2610.13947v3/teaser_rooms.png`, written relative to the paper's own URL. Any base
URL used to resolve them must be that URL exactly — a trailing slash resolves one directory
too deep and every figure 404s.

### arXiv publishes no lazy-loading attributes

0 of 12 `<img>` tags on a sample paper. The attributes have to be added before the document is
parsed, because the preload scanner consults them at that moment.

---

## Embeddings

### SPECTER2 is severely anisotropic

`allenai/specter2` embeddings on this corpus:

| | value |
|---|---|
| norm of the mean vector | **0.919** |
| pairwise cosine, p5–p95 spread | **0.114** |
| same, after mean-centring | **0.565** |

With a spread of 0.114, ranking is decided by differences at the noise floor, and diversity
reranking has nothing to work with. Mean-centring improves the spread **4.9×**.

### int8 beats binary for this data

Recall@20 against exact cosine, after centring:

| encoding | bytes/paper | recall@20 | Spearman vs exact |
|---|---|---|---|
| binary | 96 | 63.7% | 0.910 |
| int8 | 768 | **95.3%** | **0.999** |

Binary is 8× smaller and loses a third of the top-20. Int8 costs 768 bytes per paper — 1.2 MB
for 1,600 papers — and is very nearly exact.

---

## Corpus coverage

| | |
|---|---|
| Recent papers with an HTML full text | **96.4%** |
| …of papers back to 2017 | 87% |
| OpenAlex enrichment available same-day | 99.7% |

The first number is what makes an HTML reader viable at all, and the reason a PDF fallback
exists for the remainder.

---

## How to reproduce

The measurement scripts for these were removed with the code they measured; the numbers above
are recorded from runs against a corpus of 1,633 papers crawled on 2026-10-14. The reader
figures can be reproduced with `mobile/harness/check_restore.py` and the layout harness
alongside it.
