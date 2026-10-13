"""Does quantized vector encoding preserve enough ranking quality to ship a feed?

The bundle ships compressed vectors instead of float32 ones, because 3,072 bytes per paper
is 400 MB for a 12-month corpus (measured: 130,458 papers) -- far too large for an app
bundle. This measures what that compression actually costs in ranking quality.

Encodings compared:
  float32  3,072 B/paper  exact cosine -- the ground truth
  int8       768 B/paper  per-vector symmetric scalar quantization
  binary      96 B/paper  one sign bit per dimension, ranked by Hamming distance

The decision-relevant number is recall at K=20 (a feed page). "rescore" is a two-stage
variant: take a shortlist by the cheap encoding, then re-rank that shortlist exactly. It
shows the ceiling if we were to ship a float32 reservoir alongside the compressed vectors.

IMPORTANT on interpreting results: recall under quantization depends on the *intrinsic
dimensionality* of the vectors. Random or near-isotropic vectors in 768 dimensions are the
worst case and quantize badly; real neural embeddings are strongly anisotropic and behave
differently. The `--source synth --embedder hashing` mode exists to exercise this code
path offline, and its absolute numbers are NOT transferable to production. Only
`--source db` (real SPECTER2 vectors) should inform the design decision.

Usage:
    python3 -m eval.quantization_recall --source db
    python3 -m eval.quantization_recall --source synth --n 5000
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from dailypapers.embed import get_embedder, paper_text
from dailypapers.quantize import (
    DIM,
    PACKED_BYTES,
    cosine_scores,
    hamming_distance,
    human_bytes,
    int8_scores,
    l2_normalize,
    pack_binary,
    quantize_int8,
    top_k,
)

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"

KS = (10, 20, 50, 100)
FEED_K = 20
SHORTLIST = 500

_TOPIC_WORDS = [
    "graph neural network message passing node embedding",
    "diffusion model denoising score matching generative sampling",
    "reinforcement learning policy gradient reward shaping agent",
    "transformer attention sparse routing context length",
    "protein folding structure prediction sequence alignment",
    "federated learning privacy differential client update",
    "quantization compression inference latency throughput",
    "causal inference treatment effect confounder estimation",
    "optimal transport wasserstein divergence matching",
    "speech recognition acoustic model phoneme decoding",
]


def synth_corpus(embedder, n: int, seed: int = 0) -> np.ndarray:
    """Cluster-structured synthetic documents."""
    rng = np.random.default_rng(seed)
    docs = []
    for _ in range(n):
        words = _TOPIC_WORDS[rng.integers(len(_TOPIC_WORDS))].split()
        picked = [words[rng.integers(len(words))] for _ in range(rng.integers(8, 30))]
        docs.append(paper_text(" ".join(picked[:5]), " ".join(picked)))
    return embedder.encode(docs)


def load_from_db() -> np.ndarray:
    """Real SPECTER2 vectors, straight from Postgres."""
    from dailypapers.config import load_settings
    from dailypapers.db import connect

    with connect(load_settings().database_url) as conn:
        cur = conn.execute(
            "SELECT embedding::text AS emb FROM papers "
            "WHERE embedding IS NOT NULL ORDER BY id"
        )
        rows = cur.fetchall()

    if not rows:
        raise SystemExit("No embeddings in the database. Run: python3 -m ingest embed")

    matrix = np.vstack(
        [np.fromstring(r["emb"].strip("[]"), sep=",", dtype=np.float32) for r in rows]
    )
    return l2_normalize(matrix)


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Spearman correlation, without pulling in scipy."""
    ra = np.argsort(np.argsort(a)).astype(np.float64)
    rb = np.argsort(np.argsort(b)).astype(np.float64)
    ra -= ra.mean()
    rb -= rb.mean()
    denom = np.linalg.norm(ra) * np.linalg.norm(rb)
    return float(ra @ rb / denom) if denom else float("nan")


def evaluate(matrix: np.ndarray, n_queries: int, seed: int = 0, corr_sample: int = 800) -> dict:
    rng = np.random.default_rng(seed)
    packed = pack_binary(matrix)
    codes, scales = quantize_int8(matrix)
    n = matrix.shape[0]
    max_k = max(KS)

    query_idx = rng.choice(n, size=min(n_queries, n), replace=False)
    hits = {enc: {k: 0 for k in KS} for enc in ("binary", "int8", "binary_rescore", "int8_rescore")}
    corr = {"binary": [], "int8": []}
    corr_cos = []

    # The shortlist must be strictly wider than the largest K, otherwise "rescore"
    # degenerates into "no rescoring at all" and silently reports the cheap encoding's
    # own recall.
    short_k = min(max(SHORTLIST, max_k), n)

    for qi in query_idx:
        q = matrix[qi]
        cos_all = cosine_scores(matrix, q)
        ham_all = hamming_distance(packed, packed[qi]).astype(np.float32)
        i8_all = int8_scores(codes, scales, q)

        exact_idx, _ = top_k(cos_all, max_k)
        bin_short, _ = top_k(ham_all, short_k, largest=False)
        i8_short, _ = top_k(i8_all, short_k)
        bin_idx = bin_short[:max_k]
        i8_idx = i8_short[:max_k]

        # Correlations must be measured on identical indices; negate Hamming so a
        # positive correlation means "the cheap score agrees with cosine".
        sample = rng.choice(n, size=min(corr_sample, n), replace=False)
        corr_cos.append(cos_all[sample])
        corr["binary"].append(-ham_all[sample])
        corr["int8"].append(i8_all[sample])

        bin_rescored = bin_short[top_k(cos_all[bin_short], max_k)[0]]
        i8_rescored = i8_short[top_k(cos_all[i8_short], max_k)[0]]

        for k in KS:
            exact_set = set(exact_idx[:k].tolist())
            hits["binary"][k] += len(exact_set & set(bin_idx[:k].tolist()))
            hits["int8"][k] += len(exact_set & set(i8_idx[:k].tolist()))
            hits["binary_rescore"][k] += len(exact_set & set(bin_rescored[:k].tolist()))
            hits["int8_rescore"][k] += len(exact_set & set(i8_rescored[:k].tolist()))

    total = len(query_idx)
    return {
        "n_corpus": n,
        "n_queries": total,
        "shortlist": short_k,
        # recall@k = matches / (queries * k)
        "recall": {enc: {k: hits[enc][k] / (total * k) for k in KS} for enc in hits},
        "correlation": {
            enc: spearman(np.concatenate(corr_cos), np.concatenate(vals))
            for enc, vals in corr.items()
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["db", "synth"], default="db")
    ap.add_argument("--embedder", default="hashing", choices=["hashing", "specter2"])
    ap.add_argument("--n", type=int, default=5000, help="synthetic corpus size")
    ap.add_argument("--queries", type=int, default=100)
    ap.add_argument(
        "--no-center",
        action="store_true",
        help="skip mean-centering; only useful to reproduce pre-centering numbers",
    )
    ap.add_argument(
        "--project",
        type=int,
        default=130_458,
        help="corpus size to project bundle sizes onto (default: measured 12-month volume)",
    )
    args = ap.parse_args()

    REPORTS.mkdir(exist_ok=True)

    if args.source == "db":
        matrix = load_from_db()
        source_desc = f"Postgres, real SPECTER2 vectors ({matrix.shape[0]} papers)"
        trustworthy = True
    else:
        embedder = get_embedder(args.embedder)
        matrix = l2_normalize(synth_corpus(embedder, args.n))
        source_desc = f"synthetic ({args.n} docs, embedder={embedder.name})"
        trustworthy = False

    # Center by default, because that is what the bundle actually ships. SPECTER2 is
    # severely anisotropic (measured mean-vector norm 0.92), and centering changes the
    # vector distribution enough that recall numbers measured without it do not describe
    # the shipped encoding.
    if not args.no_center:
        matrix = l2_normalize(matrix - matrix.mean(axis=0))
        source_desc += ", mean-centered"

    result = evaluate(matrix, args.queries)
    n = result["n_corpus"]

    L: list[str] = []
    L.append("# Quantization recall — how much ranking quality does compression cost?\n")
    L.append(f"Generated: {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n")
    L.append(f"Source: {source_desc} · dim={DIM} · queries={result['n_queries']}\n")
    if not trustworthy:
        L.append(
            "> ⚠️ **Synthetic source.** Sign quantization depends on the intrinsic "
            "dimensionality of the vectors. These numbers exercise the code path but are "
            "**not transferable to production** — only `--source db` should inform design.\n"
        )

    L.append("## Agreement with exact cosine\n")
    L.append("| Encoding | Spearman vs cosine |")
    L.append("|---|---|")
    for enc in ("binary", "int8"):
        L.append(f"| {enc} | {result['correlation'][enc]:.3f} |")
    L.append("")

    L.append("## Recall vs exact float32 ranking\n")
    L.append("| K | binary (96 B) | binary → rescore | int8 (768 B) | int8 → rescore |")
    L.append("|---|---|---|---|---|")
    for k in KS:
        r = result["recall"]
        L.append(
            f"| {k} | {100 * r['binary'][k]:.1f}% | {100 * r['binary_rescore'][k]:.1f}% | "
            f"{100 * r['int8'][k]:.1f}% | {100 * r['int8_rescore'][k]:.1f}% |"
        )
    L.append("")

    L.append(
        f"## Bundle size — measured sample (n={n}) vs projected ({args.project:,} papers)\n"
    )
    L.append("| Encoding | Bytes/paper | Sample | Projected |")
    L.append("|---|---|---|---|")
    for enc in ("float32", "int8", "binary"):
        per = {"float32": DIM * 4, "int8": DIM, "binary": PACKED_BYTES}[enc]
        L.append(
            f"| {enc} | {per} | {human_bytes(per * n)} | "
            f"{human_bytes(per * args.project)} |"
        )
    L.append("")
    L.append(
        f"Rescore shortlist used: {result['shortlist']} candidates "
        f"({'saturated — corpus smaller than the shortlist, so rescore is optimistic' if result['shortlist'] >= n else 'narrower than the corpus'}).\n"
    )

    r = result["recall"]
    b, i = r["binary"][FEED_K], r["int8"][FEED_K]
    proj_int8 = human_bytes(DIM * args.project)
    proj_bin = human_bytes(PACKED_BYTES * args.project)

    L.append("## Verdict\n")
    if n < 1000:
        L.append(
            f"⚠️ **Sample is small (n={n})**, so treat these numbers as directional. "
            "Sign-quantization recall depends on intrinsic dimensionality and on corpus size; "
            "re-measure on several thousand papers before committing. The int8-vs-binary "
            "*gap* is the robust signal here, not the absolute values.\n"
        )
    L.append(
        f"At K={FEED_K} (one feed page): **binary {100 * b:.1f}%** vs **int8 {100 * i:.1f}%**, "
        f"for {proj_bin} vs {proj_int8} projected across {args.project:,} papers.\n"
    )
    if b >= 0.95 and i >= 0.95:
        L.append(
            "**Ship binary.** Both hold up, so take the 32x saving and skip the extra bytes."
        )
    elif i >= 0.95 and b < i - 0.05:
        L.append(
            f"**Ship int8, not binary.** Binary drops {100 * (1 - b):.1f}% of feed slots, which "
            f"is too much to hand-wave; int8 keeps {100 * i:.1f}% at 8x compression. The cost is "
            f"{proj_int8} instead of {proj_bin} projected — which is why the bundle should ship "
            "int8 only for the recent window the feed actually draws from, and a cheaper "
            "encoding (or a lazy fetch) for older papers used by search and 'related'."
        )
    elif b < 0.95 and i < 0.95:
        L.append(
            f"**Neither is sufficient alone** (binary {100 * b:.1f}%, int8 {100 * i:.1f}%). "
            "The standard fix is product quantization, which approaches int8 fidelity at "
            "binary size, or a two-stage design shipping float32 for the recent window."
        )
    else:
        L.append(
            f"**Binary is close but lossy** ({100 * b:.1f}% vs int8 {100 * i:.1f}%). Prefer int8 "
            f"({proj_int8} projected) unless bundle size is the binding constraint."
        )
    L.append("")

    report = "\n".join(L)
    (REPORTS / "quantization_recall.md").write_text(report)
    print(report)
    print(f"wrote {REPORTS / 'quantization_recall.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
