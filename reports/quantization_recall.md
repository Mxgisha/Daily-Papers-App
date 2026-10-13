# Quantization recall — how much ranking quality does compression cost?

Generated: 2026-10-13T19:47:08+00:00

Source: Postgres, real SPECTER2 vectors (1633 papers) · dim=768 · queries=150

## Agreement with exact cosine

| Encoding | Spearman vs cosine |
|---|---|
| binary | 0.910 |
| int8 | 0.999 |

## Recall vs exact float32 ranking

| K | binary (96 B) | binary → rescore | int8 (768 B) | int8 → rescore |
|---|---|---|---|---|
| 10 | 62.2% | 100.0% | 94.3% | 100.0% |
| 20 | 63.7% | 100.0% | 95.3% | 100.0% |
| 50 | 67.6% | 99.9% | 95.9% | 100.0% |
| 100 | 70.5% | 99.5% | 96.7% | 100.0% |

## Bundle size — measured sample (n=1633) vs projected (130,458 papers)

| Encoding | Bytes/paper | Sample | Projected |
|---|---|---|---|
| float32 | 3072 | 4.8 MB | 382.2 MB |
| int8 | 768 | 1.2 MB | 95.6 MB |
| binary | 96 | 153.1 KB | 11.9 MB |

Rescore shortlist used: 500 candidates (narrower than the corpus).

## Verdict

At K=20 (one feed page): **binary 63.7%** vs **int8 95.3%**, for 11.9 MB vs 95.6 MB projected across 130,458 papers.

**Ship int8, not binary.** Binary drops 36.3% of feed slots, which is too much to hand-wave; int8 keeps 95.3% at 8x compression. The cost is 95.6 MB instead of 11.9 MB projected — which is why the bundle should ship int8 only for the recent window the feed actually draws from, and a cheaper encoding (or a lazy fetch) for older papers used by search and 'related'.
