"""Vector helpers shared by ingestion.

One function, because one is all that is left. Embedding storage used to have a whole
quantisation module here — binary packing, Hamming distance, int8 codes, recall
benchmarks — from a recommendation study that was later dropped in favour of the reader.
That work is in the git history if it is ever wanted back; keeping the shell of it in a
module called `quantize` would have implied the app still quantises something.
"""

from __future__ import annotations

import numpy as np


def l2_normalize(matrix: np.ndarray) -> np.ndarray:
    """Row-wise L2 normalisation.

    Unit vectors make cosine similarity equal to a dot product, which is what lets the
    database compare embeddings with a cheap inner-product index.
    """
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim == 1:
        matrix = matrix[None, :]
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    np.maximum(norms, 1e-12, out=norms)
    return matrix / norms
