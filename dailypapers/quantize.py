"""Binary quantization of embedding vectors.

Why this exists: 768 float32 values is 3,072 bytes per paper. A 12-month corpus of
130,458 papers (measured, see README) would be ~400 MB of raw vectors -- far too large to
ship inside an app bundle. Taking the *sign* of each dimension costs 96 bytes (768 bits),
a 32x reduction. Hamming distance over those sign bits approximates angular distance well
enough to rank a feed, which is the only thing we need it for on-device.

The module is numpy-only and has no torch dependency, so quantization, packing and the
recall harness can all be exercised without a 2 GB model install.
"""

from __future__ import annotations

import numpy as np

DIM = 768
PACKED_BYTES = DIM // 8  # 96

# Popcount lookup: how many bits are set in each possible byte value.
_POPCOUNT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def l2_normalize(matrix: np.ndarray) -> np.ndarray:
    """Row-wise L2 normalization.

    Unit vectors make cosine similarity equal to the dot product, which is what lets
    Hamming distance over sign bits stand in for cosine distance.
    """
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim == 1:
        matrix = matrix[None, :]
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    np.maximum(norms, 1e-12, out=norms)
    return matrix / norms


def pack_binary(vectors: np.ndarray) -> np.ndarray:
    """(N, 768) float -> (N, 96) uint8, one sign bit per dimension."""
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] != DIM:
        raise ValueError(f"expected shape (N, {DIM}), got {vectors.shape}")
    bits = (vectors > 0).astype(np.uint8)
    return np.packbits(bits, axis=1)


def unpack_binary(packed: np.ndarray) -> np.ndarray:
    """(N, 96) uint8 -> (N, 768) float in {-1, +1}. For debugging and testing."""
    packed = np.asarray(packed, dtype=np.uint8)
    bits = np.unpackbits(packed, axis=1)[:, :DIM]
    return (bits.astype(np.float32) * 2.0) - 1.0


def hamming_distance(packed: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Distance from one packed query to every packed row. Returns (N,) int16.

    XOR then popcount via a 256-entry table -- the standard trick, and fast enough
    in numpy for corpora in the hundreds of thousands.
    """
    query = np.asarray(query, dtype=np.uint8).reshape(-1)
    if query.shape[0] != packed.shape[1]:
        raise ValueError(
            f"query has {query.shape[0]} bytes but corpus rows have {packed.shape[1]}"
        )
    return _POPCOUNT[np.bitwise_xor(packed, query)].sum(axis=1)


def cosine_scores(matrix: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Exact cosine similarity for L2-normalized inputs. Ground truth for recall tests."""
    return np.asarray(matrix, dtype=np.float32) @ np.asarray(query, dtype=np.float32).reshape(-1)


def top_k(scores: np.ndarray, k: int, *, largest: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """Indices and values of the top-k, best first."""
    scores = np.asarray(scores)
    k = min(k, scores.shape[0])
    if k <= 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=scores.dtype)
    part = np.argpartition(-scores if largest else scores, k - 1)[:k]
    ordered = part[np.argsort(-scores[part] if largest else scores[part])]
    return ordered, scores[ordered]


def binary_top_k(packed: np.ndarray, query: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Nearest neighbours by Hamming distance, nearest first."""
    distances = hamming_distance(packed, query)
    return top_k(distances.astype(np.float32), k, largest=False)


# --------------------------------------------------------------------------
# int8 scalar quantization
#
# The middle option: 8x smaller than float32 instead of 32x, but far more faithful.
# Whether the extra 672 bytes per paper are worth it is an empirical question, which
# is why eval/quantization_recall.py measures both.
# --------------------------------------------------------------------------

def quantize_int8(vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Symmetric per-vector int8 quantization.

    Returns (codes int8 of shape (N, D), scales float32 of shape (N,)). A per-vector
    scale is needed because embedding dimensions have very different magnitudes; a
    single global scale would crush most dimensions to zero.
    """
    vectors = np.asarray(vectors, dtype=np.float32)
    scales = np.abs(vectors).max(axis=1, keepdims=True) / 127.0
    np.maximum(scales, 1e-12, out=scales)
    codes = np.clip(np.rint(vectors / scales), -127, 127).astype(np.int8)
    return codes, scales.reshape(-1).astype(np.float32)


def int8_scores(codes: np.ndarray, scales: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Approximate cosine of every row against one exact float32 unit query."""
    query = np.asarray(query, dtype=np.float32).reshape(-1)
    # Integer dot product is exact in int32 for these magnitudes, then rescale.
    return (codes.astype(np.int32) @ query) * scales


def bytes_for(n_papers: int, dim: int = DIM) -> dict[str, int]:
    """Bundle size comparison for float32 / int8 / binary at a given corpus size."""
    return {
        "float32": n_papers * dim * 4,
        "int8": n_papers * dim,
        "binary": n_papers * (dim // 8),
    }


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"
