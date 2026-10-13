# Phase 0 Spike Report — arXiv HTML Coverage & Enrichment

Generated: 2026-10-13T18:27:45+00:00

Categories: `cs.LG, cs.CL, cs.CV, cs.AI` · recent sample: 336 papers (100/category) · historical sample: 281 papers

## Headline

- **HTML full text available: 322/336 = 95.8%** of recent papers
- **OpenAlex enrichment: 100/100 = 100.0%** of recent papers
- **Historical backfill: 245/281 = 87.2%** of sampled older papers

## HTTP status distribution (HTML endpoint)

| Status | Count | Share |
|---|---|---|
| 200 | 322 | 95.8% |
| 404 | 14 | 4.2% |

## HTML coverage by primary category

| Category | Papers | With HTML | Coverage |
|---|---|---|---|
| `cs.CV` | 85 | 82 | 96.5% |
| `cs.LG` | 63 | 62 | 98.4% |
| `cs.CL` | 62 | 55 | 88.7% |
| `cs.AI` | 55 | 54 | 98.2% |
| `stat.ML` | 13 | 13 | 100.0% |
| `cs.RO` | 11 | 10 | 90.9% |
| `eess.IV` | 6 | 5 | 83.3% |
| `cs.SE` | 6 | 6 | 100.0% |
| `math.OC` | 5 | 5 | 100.0% |
| `eess.AS` | 4 | 4 | 100.0% |
| `cs.SD` | 4 | 4 | 100.0% |
| `eess.SP` | 3 | 3 | 100.0% |
| `cs.IR` | 3 | 3 | 100.0% |
| `quant-ph` | 2 | 2 | 100.0% |
| `cs.DC` | 2 | 2 | 100.0% |
| `math.AT` | 1 | 1 | 100.0% |
| `cs.NI` | 1 | 1 | 100.0% |
| `cs.NE` | 1 | 1 | 100.0% |
| `physics.chem-ph` | 1 | 1 | 100.0% |
| `stat.ME` | 1 | 1 | 100.0% |
| `stat.AP` | 1 | 1 | 100.0% |
| `math.DS` | 1 | 1 | 100.0% |
| `cs.CR` | 1 | 1 | 100.0% |
| `cs.SI` | 1 | 1 | 100.0% |
| `cs.CY` | 1 | 1 | 100.0% |
| `cs.DB` | 1 | 1 | 100.0% |
| `cs.MA` | 1 | 1 | 100.0% |

## HTML coverage by paper age

| Age bucket | Papers | With HTML | Coverage |
|---|---|---|---|
| <7 days | 336 | 322 | 95.8% |

## OpenAlex enrichment detail

Matched 100/100 papers by arXiv DOI (`10.48550/arXiv.<id>`).

| Field populated | Share of matched |
|---|---|
| Venue | 100.0% |
| Topics | 100.0% |
| Concepts | 100.0% |
| Abstract | 100.0% |
| OA status | 100.0% |
| OA PDF URL | 0.0% |
| Cited by > 0 | 0.0% |

### Sample enriched records

- **Hide and Seek: HIDE Concepts to SEEK explanations for black box models**
  - venue: `arXiv (Cornell University)` · type: `preprint` · cited_by: 0 · oa: `green`
  - topics: Explainable Artificial Intelligence (XAI), Advanced Neural Network Applications, Multimodal Machine Learning Applications
- **Constructive Bounds for the Topological Expressivity of Neural Networks**
  - venue: `arXiv (Cornell University)` · type: `preprint` · cited_by: 0 · oa: `green`
  - topics: Topological and Geometric Data Analysis, Neural Networks and Applications, Homotopy and Cohomology in Algebraic Topology
- **AI Models Can Provably Hide Arbitrary Capabilities**
  - venue: `arXiv (Cornell University)` · type: `preprint` · cited_by: 0 · oa: `green`
  - topics: Adversarial Robustness in Machine Learning, Cryptography and Data Security, Security and Verification in Computing
- **KL Before and After Mixing: A Round-Complexity Separation in Parallel Sampling**
  - venue: `arXiv (Cornell University)` · type: `preprint` · cited_by: 0 · oa: `green`
  - topics: Markov Chains and Monte Carlo Methods, Simulation Techniques and Applications, Complexity and Algorithms in Graphs
- **Goal-Oriented Bundle Management and Flow Control for Deep-Space Communications v**
  - venue: `arXiv (Cornell University)` · type: `preprint` · cited_by: 0 · oa: `green`
  - topics: Opportunistic and Delay-Tolerant Networks, Age of Information Optimization, Satellite Communication Systems

## Historical backfill detail

| Submitted | Papers | With HTML | Coverage |
|---|---|---|---|
| 2017 | 137 | 112 | 81.8% |
| 2020 | 144 | 133 | 92.4% |

## Decision

**HTML-first reader confirmed.** 95.8% coverage means the majority of the feed reads as reflowed native text. Build the HTML reader as the primary path and treat PDF as a fallback for the minority.

---

Client stats: `{"requests": 699, "cache_hits": 30, "retries": 0, "failures": 0}`
