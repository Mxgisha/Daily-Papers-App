"""Local reader spike: serve arXiv HTML full text reflowed for a phone viewport.

This is a spike, not the app. It exists to answer one question -- is reflowed HTML reading
actually viable on a phone -- and to measure what it costs in bytes and layout. The
extractor and the CSS are the parts that would carry over to the real client.
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dailypapers.http import PoliteClient

from .extract import BASE_HREF, NotRenderable, fetch_article, reflow_risk

STATIC = Path(__file__).resolve().parent / "static"
TITLE_RE = re.compile(
    r'<h1[^>]*class="[^"]*ltx_title_document[^"]*"[^>]*>(.*?)</h1>', re.S | re.I
)
TAG_RE = re.compile(r"<[^>]+>")

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<base href="{base_href}">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<div id="__bar">
  <button id="__dec" aria-label="Decrease text size">A&minus;</button>
  <button id="__inc" aria-label="Increase text size">A+</button>
  <button id="__theme" aria-label="Toggle theme">&#9686;</button>
  <span class="spacer"></span>
  <span class="title">{arxiv_id}</span>
</div>
{article}
<pre id="__metrics"></pre>
<script>{js}</script>
</body>
</html>
"""

ERROR_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not renderable</title>
<style>body{{font:16px/1.6 system-ui;margin:2rem;max-width:34rem}}code{{background:#f0f0f0;padding:.1em .3em}}</style>
</head><body><h1>No HTML full text</h1>
<p><code>{arxiv_id}</code> could not be rendered: {reason}</p>
<p>~4% of arXiv papers have no HTML rendering and need the PDF fallback path.</p>
</body></html>
"""


def _title(article_html: str, fallback: str) -> str:
    m = TITLE_RE.search(article_html)
    if not m:
        return fallback
    text = " ".join(TAG_RE.sub(" ", m.group(1)).split())
    return text or fallback


def _static(name: str) -> str:
    return (STATIC / name).read_text()


class ReaderHandler(BaseHTTPRequestHandler):
    client: PoliteClient | None = None
    server_version = "DailyPapersReader/0.1"

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def _send(self, status: int, body: str, content_type: str = "text/html; charset=utf-8"):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # The client is served from a different port during verification, so a fetch that
        # probes renderability is cross-origin. No credentials are involved -- this is a
        # local development reader for public arXiv content.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self) -> None:  # noqa: N802
        """Status only, no body.

        The web reader probes this to decide whether a paper has HTML full text, so it can
        show the PDF fallback instead of an iframe of arXiv's error page. Without it the
        fallback would be unreachable on web.
        """
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        m = re.match(r"^/(?:read|article)/(.+)$", path)
        status = 200
        if path != "/" and not m:
            status = 404
        elif m:
            try:
                fetch_article(self.client, m.group(1))
            except NotRenderable:
                status = 404
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/":
            return self._index()

        m = re.match(r"^/(read|metrics|article)/(.+)$", path)
        if m:
            route, arxiv_id = m.group(1), m.group(2)
            try:
                article = fetch_article(self.client, arxiv_id)
            except NotRenderable as exc:
                if route == "metrics":
                    return self._send(404, json.dumps({"error": str(exc)}), "application/json")
                return self._send(404, ERROR_PAGE.format(arxiv_id=arxiv_id, reason=exc))

            if route == "metrics":
                payload = {
                    "arxiv_id": article.arxiv_id,
                    "page_bytes": article.page_bytes,
                    "article_bytes": article.article_bytes,
                    "article_share": round(article.article_bytes / article.page_bytes, 3),
                    **article.metrics,
                    "reflow_risks": reflow_risk(article.metrics),
                }
                return self._send(200, json.dumps(payload, indent=2), "application/json")

            if route == "article":
                return self._send(200, article.html)

            title = _title(article.html, arxiv_id)
            return self._send(
                200,
                PAGE.format(
                    base_href=BASE_HREF,
                    title=_escape(title),
                    css=_static("reader.css"),
                    js=_static("reader.js"),
                    article=article.html,
                    arxiv_id=_escape(arxiv_id),
                ),
            )

        self._send(404, "<h1>Not found</h1>")

    def _index(self) -> None:
        """Landing page listing papers already in the corpus, for quick manual testing."""
        rows: list[tuple[str, str]] = []
        try:
            from dailypapers.config import load_settings
            from dailypapers.db import connect

            with connect(load_settings().database_url) as conn:
                cur = conn.execute(
                    """
                    SELECT arxiv_base_id, title FROM papers
                     WHERE html_available IS TRUE
                     ORDER BY published_at DESC LIMIT 40
                    """
                )
                rows = [(r["arxiv_base_id"], r["title"]) for r in cur.fetchall()]
        except Exception as exc:  # noqa: BLE001 - the index must render regardless
            rows = []
            note = f"<p><em>Could not read the corpus: {exc}</em></p>"
        else:
            note = ""

        items = "".join(
            f'<li><a href="/read/{aid}">{_escape(title[:110])}</a> <code>{aid}</code></li>'
            for aid, title in rows
        )
        self._send(
            200,
            f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reader spike</title>
<style>
body{{font:16px/1.6 system-ui;margin:0 auto;max-width:44rem;padding:1.5rem}}
code{{background:#f2f2f2;padding:.1em .3em;border-radius:3px;font-size:.85em}}
li{{margin:.45rem 0}} ol{{padding-left:1.2rem}}
form{{margin:1.25rem 0}} input{{font:inherit;padding:.4rem;width:12rem}}
button{{font:inherit;padding:.4rem .8rem}}
</style></head><body>
<h1>Reader spike</h1>
<p>Reflowed arXiv HTML full text at phone width. {len(rows)} renderable papers in the corpus.</p>
<form action="/read/" method="get" onsubmit="location.href='/read/'+this.id.value;return false">
  <input name="id" placeholder="arXiv id e.g. 2610.13935" required>
  <button>Read</button>
</form>
{note}
<ol>{items}</ol>
</body></html>""",
        )


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def serve(
    host: str = "127.0.0.1",
    port: int = 8765,
    cache_dir: Path = Path("data/cache"),
    min_interval: float = 0.6,
) -> ThreadingHTTPServer:
    ReaderHandler.client = PoliteClient(cache_dir, min_interval=min_interval)
    httpd = ThreadingHTTPServer((host, port), ReaderHandler)
    return httpd
