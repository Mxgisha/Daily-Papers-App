"""Paper embedding.

SPECTER2 is `allenai/specter2_base` plus a task adapter. Two footguns worth stating:

  * The Aug 2023 rename means `allenai/specter2` is the *proximity adapter*, not a model.
    Loading it as a base model is the common mistake.
  * The embedding is the **CLS token** (`last_hidden_state[:, 0, :]`), not a mean pool.
    Getting this wrong degrades quality silently rather than raising.

torch / transformers / adapters are imported lazily inside `Specter2Embedder.__init__` so
that the rest of the codebase -- and the test suite -- runs without a 2 GB install.
"""

from __future__ import annotations

import hashlib
import re
from typing import Protocol, Sequence, runtime_checkable

import numpy as np

DIM = 768
SEP = "[SEP]"  # the separator SPECTER2 was trained with

_WORD = re.compile(r"[a-z0-9]+")


def paper_text(title: str, abstract: str | None) -> str:
    """SPECTER2 represents a paper as title[SEP]abstract."""
    return f"{title}{SEP}{abstract or ''}".strip()


@runtime_checkable
class Embedder(Protocol):
    name: str
    dim: int

    def encode(self, texts: Sequence[str], batch_size: int = 16) -> np.ndarray: ...


class Specter2Embedder:
    """The real thing. Requires torch + transformers + adapters."""

    def __init__(
        self,
        base: str = "allenai/specter2_base",
        adapter: str = "allenai/specter2",
        device: str | None = None,
    ) -> None:
        import torch
        from adapters import AutoAdapterModel
        from transformers import AutoTokenizer

        self._torch = torch
        self.name = f"{base}+{adapter}"
        self.dim = DIM

        self.tokenizer = AutoTokenizer.from_pretrained(base)
        self.model = AutoAdapterModel.from_pretrained(base)
        self.model.load_adapter(adapter, source="hf", load_as="proximity", set_active=True)
        self.model.eval()

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

    def encode(self, texts: Sequence[str], batch_size: int = 16) -> np.ndarray:
        torch = self._torch
        chunks: list[np.ndarray] = []
        with torch.no_grad():
            for i in range(0, len(texts), batch_size):
                batch = list(texts[i : i + batch_size])
                inputs = self.tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    return_tensors="pt",
                    return_token_type_ids=False,
                    max_length=512,
                ).to(self.device)
                hidden = self.model(**inputs).last_hidden_state
                chunks.append(hidden[:, 0, :].to(torch.float32).cpu().numpy())
        if not chunks:
            return np.zeros((0, self.dim), dtype=np.float32)
        return np.vstack(chunks)


class HashingEmbedder:
    """Deterministic offline stand-in for the real model.

    A signed hashed bag-of-words projection: not a good retriever, but it produces
    *structured* vectors (documents sharing vocabulary land near each other), which is
    what the quantization and recall code needs in order to be tested honestly without
    downloading a model. Using pure random vectors here would misrepresent recall,
    because sign quantization behaves differently on structured input.
    """

    name = "hashing-v1"
    dim = DIM

    def __init__(self, seed: int = 0x5EED) -> None:
        self.seed = seed

    def encode(self, texts: Sequence[str], batch_size: int = 16) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            for token in _WORD.findall(text.lower()):
                digest = hashlib.blake2b(
                    f"{self.seed}:{token}".encode(), digest_size=8
                ).digest()
                value = int.from_bytes(digest, "little")
                out[i, value % self.dim] += 1.0 if (value >> 63) & 1 else -1.0
            # Character trigrams add robustness to the word-level signal.
            for j in range(len(text) - 2):
                tri = text[j : j + 3].lower()
                digest = hashlib.blake2b(
                    f"{self.seed}:{tri}".encode(), digest_size=8
                ).digest()
                value = int.from_bytes(digest, "little")
                out[i, value % self.dim] += 0.5 if (value >> 63) & 1 else -0.5
        return out


def get_embedder(kind: str = "specter2", **kwargs) -> Embedder:
    """Factory so callers can fall back to the offline embedder with one flag."""
    if kind in ("specter2", "real"):
        return Specter2Embedder(**kwargs)
    if kind in ("hashing", "offline"):
        return HashingEmbedder(**kwargs)
    raise ValueError(f"unknown embedder kind: {kind!r}")
