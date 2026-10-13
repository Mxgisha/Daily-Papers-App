"""Configuration loaded from the environment (optionally via a .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Minimal .env loader, so the project needs no runtime dependency for it."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


@dataclass(frozen=True)
class Settings:
    database_url: str
    contact_email: str
    categories: list[str]
    http_min_interval: float
    data_dir: Path
    cache_dir: Path

    @property
    def user_agent(self) -> str:
        return f"DailyPapersApp/0.1 (metadata ingestion; mailto:{self.contact_email})"


def load_settings() -> Settings:
    _load_dotenv()
    data_dir = ROOT / "data"
    return Settings(
        database_url=os.environ.get(
            "DATABASE_URL",
            "postgresql://dailypapers:dailypapers@localhost:5433/dailypapers",
        ),
        contact_email=os.environ.get("CONTACT_EMAIL", "spike@example.com"),
        categories=[
            c.strip()
            for c in os.environ.get("ARXIV_CATEGORIES", "cs.LG,cs.CL,cs.CV,cs.AI").split(",")
            if c.strip()
        ],
        http_min_interval=float(os.environ.get("HTTP_MIN_INTERVAL", "0.6")),
        data_dir=data_dir,
        cache_dir=data_dir / "cache",
    )
