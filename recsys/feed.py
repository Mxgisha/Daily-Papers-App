"""On-device feed generation.

This mirrors what the Expo client will do: no server, just arithmetic over the shipped
bundle. Ranking weights come from `manifest.json`, so the same code path can be retuned
without shipping a new client -- which is the main thing given up by having no server-side
ranking.

The pipeline is deliberately conventional:

    seeds -> user vector -> candidate pool -> score -> MMR diversify -> explore -> feed

Every stage is inspectable, and the CLI prints the score components so a bad feed can be
attributed to a specific stage rather than guessed at.
"""

from __future__ import annotations

import json
import math
import random
import sqlite3
import tempfile
import zstandard as zstd
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from dailypapers.quantize import int8_scores, l2_normalize, top_k

DEFAULT_CONFIG = {
    "weights": {"similarity": 0.60, "recency": 0.25, "topic_overlap": 0.15},
    "mmr_lambda": 0.70,
    "exploration_epsilon": 0.15,
    "html_bonus": 0.05,
    "recency_halflife_days": 14.0,
    "feed_size": 20,
    "candidate_pool": 500,
}


@dataclass
class FeedConfig:
    weights: dict[str, float]
    mmr_lambda: float
    exploration_epsilon: float
    html_bonus: float
    recency_halflife_days: float
    feed_size: int
    candidate_pool: int

    @classmethod
    def from_dict(cls, data: dict) -> "FeedConfig":
        merged = {**DEFAULT_CONFIG, **data}
        merged["weights"] = {**DEFAULT_CONFIG["weights"], **data.get("weights", {})}
        return cls(**{k: merged[k] for k in DEFAULT_CONFIG})

    @classmethod
    def from_manifest(cls, path: Path) -> "FeedConfig":
        manifest = json.loads(Path(path).read_text())
        return cls.from_dict(manifest.get("ranking", {}))


@dataclass
class Paper:
    id: int
    arxiv_id: str
    title: str
    abstract: str
    primary_category: str
    categories: list[str]
    topics: list[str]
    published_at: datetime | None
    html_available: bool
    citation_count: int
    vec_index: int | None


@dataclass
class Scored:
    paper: Paper
    score: float
    components: dict[str, float] = field(default_factory=dict)
    stage: str = ""          # "ranked" | "diversified" | "exploration"


class Corpus:
    """Papers plus their quantized vectors, loaded from the shipped bundle."""

    def __init__(self, papers: list[Paper], codes: np.ndarray, scales: np.ndarray,
                 vec_ids: np.ndarray) -> None:
        self.papers = papers
        self.by_id = {p.id: p for p in papers}
        self.codes = codes
        self.scales = scales
        self.vec_ids = vec_ids
        # Subtracted before quantization. Kept so the same reference can be reused for
        # lazily fetched shards, and for embedding free-text queries later.
        self.centroid: np.ndarray | None = None
        self._vec_row = {int(v): i for i, v in enumerate(vec_ids)}

    # -- construction ------------------------------------------------------

    @classmethod
    def from_bundle(cls, dist: Path) -> "Corpus":
        """Load from the bundle exactly as a client would."""
        from bundle.builder import read_vectors

        db_path = Path(dist) / "app_bundle.db.zst"
        tmp = Path(tempfile.mkdtemp(prefix="recsys-bundle-")) / "bundle.db"
        with db_path.open("rb") as fin, tmp.open("wb") as fout:
            zstd.ZstdDecompressor().copy_stream(fin, fout)

        con = sqlite3.connect(tmp)
        con.row_factory = sqlite3.Row
        topic_rows = con.execute("SELECT paper_id, topic_id FROM paper_topics").fetchall()
        topic_names = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM topics")}
        by_paper: dict[int, list[str]] = {}
        for r in topic_rows:
            by_paper.setdefault(r["paper_id"], []).append(topic_names.get(r["topic_id"], ""))

        papers = []
        for r in con.execute("SELECT * FROM papers"):
            papers.append(
                Paper(
                    id=r["id"],
                    arxiv_id=r["arxiv_id"] or "",
                    title=r["title"],
                    abstract=r["abstract"] or "",
                    primary_category=r["primary_category"] or "",
                    categories=json.loads(r["categories"] or "[]"),
                    topics=by_paper.get(r["id"], []),
                    published_at=_parse(r["published_at"]),
                    html_available=bool(r["html_available"]),
                    citation_count=r["citation_count"] or 0,
                    vec_index=r["vec_index"],
                )
            )
        con.close()

        vf = read_vectors(Path(dist) / "vectors.bin")
        corpus = cls(papers, vf.codes, vf.scales, vf.ids)
        corpus.centroid = vf.centroid
        return corpus

    @classmethod
    def from_db(cls, conn) -> "Corpus":
        """Load exact float32 vectors from Postgres.

        Used for comparison: the bundle path is what ships, the DB path is the reference.
        """
        topic_rows = conn.execute(
            "SELECT pt.paper_id, t.name FROM paper_topics pt JOIN topics t ON t.id = pt.topic_id"
        ).fetchall()
        by_paper: dict[int, list[str]] = {}
        for r in topic_rows:
            by_paper.setdefault(r["paper_id"], []).append(r["name"])

        papers = []
        for r in conn.execute(
            """
            SELECT id, arxiv_base_id, title, abstract, primary_category, categories,
                   published_at, html_available, citation_count
              FROM papers ORDER BY id
            """
        ).fetchall():
            papers.append(
                Paper(
                    id=r["id"],
                    arxiv_id=r["arxiv_base_id"] or "",
                    title=r["title"],
                    abstract=r["abstract"] or "",
                    primary_category=r["primary_category"] or "",
                    categories=list(r["categories"] or []),
                    topics=by_paper.get(r["id"], []),
                    published_at=r["published_at"],
                    html_available=bool(r["html_available"]),
                    citation_count=r["citation_count"] or 0,
                    vec_index=None,
                )
            )

        ids, vecs = [], []
        for r in conn.execute(
            "SELECT id, embedding::text AS emb FROM papers WHERE embedding IS NOT NULL ORDER BY id"
        ).fetchall():
            ids.append(r["id"])
            vecs.append(np.fromstring(r["emb"].strip("[]"), sep=",", dtype=np.float32))
        matrix = l2_normalize(np.vstack(vecs)) if vecs else np.zeros((0, 768), np.float32)

        # Center to match the bundle. Skipping this would make the DB path inherit the
        # anisotropy problem and the two sources would not be comparable.
        centroid = matrix.mean(axis=0) if len(matrix) else np.zeros(768, dtype=np.float32)
        centered = l2_normalize(matrix - centroid) if len(matrix) else matrix

        # Store as "codes" so the shared int8 scoring path is used; 1/127 is near-exact.
        codes = np.round(centered * 127).astype(np.int8)
        scales = np.full(len(ids), 1.0 / 127.0, dtype=np.float32)
        corpus = cls(papers, codes, scales, np.asarray(ids, dtype=np.int64))
        corpus.centroid = centroid
        corpus._exact = {int(i): centered[n] for n, i in enumerate(ids)}
        return corpus

    # -- vectors -----------------------------------------------------------

    def _rows(self, paper_ids: list[int]) -> tuple[list[int], list[int]]:
        rows, keep = [], []
        for pid in paper_ids:
            p = self.by_id.get(pid)
            if p and p.vec_index is not None:
                row = self._vec_row.get(int(p.vec_index))
                if row is not None:
                    rows.append(row)
                    keep.append(pid)
        return rows, keep

    def dequantize(self, rows: list[int]) -> np.ndarray:
        if not rows:
            return np.zeros((0, self.codes.shape[1]), dtype=np.float32)
        block = self.codes[rows].astype(np.float32)
        return l2_normalize(block * self.scales[rows][:, None])

    def vector_for(self, paper_id: int) -> np.ndarray | None:
        exact = getattr(self, "_exact", None)
        if exact and paper_id in exact:
            return exact[paper_id]
        rows, keep = self._rows([paper_id])
        if not rows:
            return None
        return self.dequantize(rows)[0]

    def user_vector(self, seed_ids: list[int]) -> tuple[np.ndarray | None, list[int]]:
        """Normalized mean of the seed vectors -- the entire cold-start profile."""
        rows, keep = self._rows(seed_ids)
        if not rows:
            return None, []
        mean = self.dequantize(rows).mean(axis=0)
        norm = np.linalg.norm(mean)
        if norm < 1e-9:
            return None, keep
        return (mean / norm).astype(np.float32), keep

    def similarity_scores(self, query: np.ndarray) -> np.ndarray:
        """Approximate cosine of every paper against the query, via int8 codes."""
        return int8_scores(self.codes, self.scales, query)

    def score_by_paper(self, query: np.ndarray) -> dict[int, float]:
        scores = self.similarity_scores(query)
        out: dict[int, float] = {}
        for vec_index, score in zip(self.vec_ids.tolist(), scores.tolist()):
            row = self._vec_row.get(int(vec_index))
            if row is not None:
                out[int(vec_index)] = float(score)
        return out


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def recency(paper: Paper, now: datetime, halflife_days: float) -> float:
    if not paper.published_at:
        return 0.0
    age_days = max((now - paper.published_at).total_seconds() / 86400.0, 0.0)
    return math.exp(-age_days / max(halflife_days, 1e-6))


def topic_profile(seeds: list[Paper]) -> dict[str, float]:
    """Weighted topic counts from the seed papers."""
    profile: dict[str, float] = {}
    for p in seeds:
        for t in p.topics:
            profile[t] = profile.get(t, 0.0) + 1.0
    total = sum(profile.values())
    if total:
        for k in profile:
            profile[k] /= total
    return profile


def topic_overlap(paper: Paper, profile: dict[str, float]) -> float:
    if not profile or not paper.topics:
        return 0.0
    return sum(profile.get(t, 0.0) for t in paper.topics)


def generate_feed(
    corpus: Corpus,
    seed_ids: list[int],
    config: FeedConfig,
    *,
    exclude: set[int] | None = None,
    now: datetime | None = None,
    rng: random.Random | None = None,
) -> tuple[list[Scored], dict]:
    """Produce a ranked, diversified, slightly-exploratory feed."""
    exclude = exclude or set()
    now = now or datetime.now(timezone.utc)
    rng = rng or random.Random(0)

    user_vec, used_seeds = corpus.user_vector(seed_ids)
    if user_vec is None:
        raise SystemExit("none of the seed papers have vectors in this corpus")

    seed_papers = [corpus.by_id[i] for i in used_seeds if i in corpus.by_id]
    profile = topic_profile(seed_papers)
    seed_topic_names = set(profile)

    # ---- Stage 1: candidate generation -----------------------------------
    # Similarity over the whole corpus, then a recency/topic-aware trim. This mirrors the
    # bundle design: cheap scoring everywhere, expensive work only on a shortlist.
    sims = corpus.score_by_paper(user_vec)
    recent_cutoff = now.timestamp() - 400 * 86400

    candidates: list[Scored] = []
    for paper in corpus.papers:
        if paper.id in exclude or paper.id in used_seeds:
            continue
        if paper.vec_index is None:
            continue
        sim = sims.get(int(paper.vec_index))
        if sim is None:
            continue
        if paper.published_at and paper.published_at.timestamp() < recent_cutoff:
            continue
        rec = recency(paper, now, config.recency_halflife_days)
        ov = min(topic_overlap(paper, profile), 1.0)
        w = config.weights
        score = (
            w["similarity"] * sim
            + w["recency"] * rec
            + w["topic_overlap"] * ov
            + config.html_bonus * (1.0 if paper.html_available else 0.0)
        )
        candidates.append(
            Scored(
                paper=paper,
                score=score,
                components={
                    "similarity": sim,
                    "recency": rec,
                    "topic_overlap": ov,
                    "html": 1.0 if paper.html_available else 0.0,
                },
                stage="candidate",
            )
        )

    candidates.sort(key=lambda s: -s.score)
    pool = candidates[: config.candidate_pool]
    if not pool:
        return [], {"used_seeds": used_seeds, "candidates": 0}

    # ---- Stage 2: MMR diversification ------------------------------------
    rows, keep = corpus._rows([s.paper.id for s in pool])
    vecs = corpus.dequantize(rows)
    sim_to_keep = {pid: i for i, pid in enumerate(keep)}

    scores = np.array([s.score for s in pool], dtype=np.float32)
    lo, hi = float(scores.min()), float(scores.max())
    norm = (scores - lo) / (hi - lo) if hi > lo else np.ones_like(scores)

    explore_slots = max(1, round(config.exploration_epsilon * config.feed_size)) \
        if config.exploration_epsilon > 0 else 0
    ranked_slots = max(config.feed_size - explore_slots, 0)

    selected: list[int] = []
    order: list[Scored] = []
    remaining = list(range(len(pool)))

    while remaining and len(order) < ranked_slots:
        best_idx, best_val = None, -1e9
        for i in remaining:
            pid = pool[i].paper.id
            row = sim_to_keep.get(pid)
            penalty = 0.0
            if selected and row is not None:
                sims_to_selected = vecs[selected] @ vecs[row]
                penalty = float(sims_to_selected.max())
            value = config.mmr_lambda * float(norm[i]) - (1 - config.mmr_lambda) * penalty
            if value > best_val:
                best_idx, best_val = i, value
        if best_idx is None:
            break
        selected.append(sim_to_keep[pool[best_idx].paper.id])
        item = pool[best_idx]
        item.stage = "ranked"
        order.append(item)
        remaining.remove(best_idx)

    # ---- Stage 3: exploration --------------------------------------------
    # Sample from the *tail* of the pool, not the top: picking near-duplicates of what was
    # already chosen is not exploration, it is a worse version of stage 2.
    if explore_slots and remaining:
        tail = remaining[len(remaining) // 2 :] or remaining
        for idx in rng.sample(tail, min(explore_slots, len(tail))):
            item = pool[idx]
            item.stage = "exploration"
            order.append(item)
            remaining.remove(idx)

    stats = {
        "used_seeds": used_seeds,
        "seed_topic_names": sorted(seed_topic_names)[:8],
        "candidates": len(candidates),
        "pool": len(pool),
        "ranked_slots": ranked_slots,
        "explore_slots": explore_slots,
    }
    return order, stats


# --------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------

def evaluate_feed(corpus: Corpus, feed: list[Scored], now: datetime | None = None) -> dict:
    """Numbers that answer 'is this feed any good?', absent real engagement data.

    Without users there is no ground truth, so these are proxies: redundancy, catalogue
    coverage, freshness, and how concentrated the feed is on the user's existing topics
    (a filter-bubble check).
    """
    now = now or datetime.now(timezone.utc)
    if not feed:
        return {}

    cats: dict[str, int] = {}
    topics: dict[str, int] = {}
    ages: list[float] = []
    html = 0
    for item in feed:
        p = item.paper
        cats[p.primary_category] = cats.get(p.primary_category, 0) + 1
        for t in p.topics:
            topics[t] = topics.get(t, 0) + 1
        if p.published_at:
            ages.append((now - p.published_at).total_seconds() / 86400.0)
        html += 1 if p.html_available else 0

    total_topics = sum(topics.values())
    entropy = 0.0
    for n in topics.values():
        pr = n / total_topics
        entropy -= pr * math.log(pr or 1e-12)
    max_entropy = math.log(len(topics)) if len(topics) > 1 else 1.0

    rows, _ = corpus._rows([s.paper.id for s in feed])
    pairwise = 0.0
    if len(rows) > 1:
        vecs = corpus.dequantize(rows)
        sim = vecs @ vecs.T
        iu = np.triu_indices(len(rows), k=1)
        pairwise = float(sim[iu].mean())

    return {
        "size": len(feed),
        "distinct_categories": len(cats),
        "category_spread": dict(sorted(cats.items(), key=lambda kv: -kv[1])),
        "topic_entropy": round(entropy, 3),
        "topic_entropy_norm": round(entropy / max_entropy, 3) if max_entropy else 0.0,
        "mean_pairwise_similarity": round(pairwise, 3),
        "mean_age_days": round(sum(ages) / len(ages), 1) if ages else None,
        "pct_html": round(100.0 * html / len(feed), 1),
        "exploration_items": sum(1 for s in feed if s.stage == "exploration"),
    }
