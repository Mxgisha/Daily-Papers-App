"""Polite HTTP client: per-host rate limiting, retries with backoff, and a disk cache.

Deliberately standard-library only, so the spike runs on any Python without depending on
wheel availability for a very new interpreter.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

DEFAULT_UA = "DailyPapersApp-Spike/0.1 (metadata coverage research; mailto:spike@example.com)"

RETRYABLE = frozenset({429, 500, 502, 503, 504})


@dataclass
class Response:
    url: str
    status: int
    body: str
    from_cache: bool = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class _HostLimiter:
    """Space out requests per host, across threads.

    A single lock per host serialises callers so the minimum interval is respected globally
    rather than per-thread, which is what "be polite to arXiv" actually requires.
    """

    def __init__(self, min_interval: float) -> None:
        self.min_interval = min_interval
        self._locks: dict[str, threading.Lock] = {}
        self._last: dict[str, float] = {}
        self._guard = threading.Lock()

    def wait(self, host: str) -> None:
        with self._guard:
            lock = self._locks.setdefault(host, threading.Lock())
        with lock:
            elapsed = time.monotonic() - self._last.get(host, 0.0)
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self._last[host] = time.monotonic()


class PoliteClient:
    def __init__(
        self,
        cache_dir: str | Path,
        min_interval: float = 0.6,
        max_retries: int = 4,
        timeout: float = 45.0,
        user_agent: str = DEFAULT_UA,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.limiter = _HostLimiter(min_interval)
        self.max_retries = max_retries
        self.timeout = timeout
        self.user_agent = user_agent
        self.stats = {"requests": 0, "cache_hits": 0, "retries": 0, "failures": 0}

    def _cache_path(self, url: str) -> Path:
        return self.cache_dir / f"{hashlib.sha256(url.encode()).hexdigest()[:24]}.json"

    def _save(self, path: Path, resp: Response) -> None:
        try:
            path.write_text(json.dumps({"status": resp.status, "body": resp.body}))
        except OSError:
            pass  # a cache write failure must never break the run

    def get(self, url: str, *, use_cache: bool = True) -> Response:
        path = self._cache_path(url)
        if use_cache and path.exists():
            try:
                data = json.loads(path.read_text())
                self.stats["cache_hits"] += 1
                return Response(url, int(data["status"]), data["body"], from_cache=True)
            except (ValueError, KeyError, OSError):
                path.unlink(missing_ok=True)

        host = urllib.parse.urlsplit(url).netloc
        last_err: object = None

        for attempt in range(self.max_retries):
            self.limiter.wait(host)
            self.stats["requests"] += 1
            req = urllib.request.Request(
                url, headers={"User-Agent": self.user_agent, "Accept": "*/*"}
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    resp = Response(url, r.status, r.read().decode("utf-8", "replace"))
                self._save(path, resp)
                return resp
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                if e.code == 404:
                    # A legitimate negative answer (e.g. "no HTML for this paper"), not a
                    # transient failure. Cache it so re-runs stay cheap.
                    resp = Response(url, 404, body)
                    self._save(path, resp)
                    return resp
                if e.code in RETRYABLE:
                    last_err = e
                    self.stats["retries"] += 1
                    time.sleep(2**attempt + 0.5)
                    continue
                return Response(url, e.code, body)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = e
                self.stats["retries"] += 1
                time.sleep(2**attempt + 0.5)

        self.stats["failures"] += 1
        return Response(url, 0, f"ERROR: {last_err}")
