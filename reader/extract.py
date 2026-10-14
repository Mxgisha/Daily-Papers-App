"""Fetch arXiv HTML and extract just the readable article.

arXiv's HTML wraps the paper in site chrome -- header, license banner, watermark, nav --
and styles it with desktop CSS (a wide measure, fixed table widths, small type). A reader
needs the article alone, restyled for a narrow viewport. That transformation is the whole
question this spike exists to answer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from dailypapers.http import PoliteClient

# <article> appears exactly once per arXiv HTML page and wraps the whole paper.
ARTICLE_RE = re.compile(r"<article\b[^>]*>.*?</article>", re.S | re.I)
SCRIPT_RE = re.compile(r"<script\b.*?</script>", re.S | re.I)
STYLE_RE = re.compile(r"<style\b.*?</style>", re.S | re.I)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
IMG_RE = re.compile(r"<img\b[^>]*>", re.I)
TABLE_RE = re.compile(r"<table\b.*?</table>", re.S | re.I)
MATH_DISPLAY_RE = re.compile(r'<math\b[^>]*display="block"', re.I)

# Images are relative to /html/, e.g. "2610.13935v1/Flow.png".
BASE_HREF = "https://arxiv.org/html/"

WORDS_PER_MINUTE = 220


class NotRenderable(Exception):
    """arXiv has no HTML full text for this paper."""


@dataclass
class Article:
    arxiv_id: str
    html: str
    page_bytes: int
    article_bytes: int
    metrics: dict = field(default_factory=dict)


IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)


def _lazy(match: re.Match) -> str:
    """Add native lazy loading to a figure tag.

    arXiv's markup never marks figures lazy, so opening a 15k-word paper eagerly fetches all
    62 figures -- 28 MB against 388 KB of text. Native `loading="lazy"` makes the browser
    fetch only what comes near the viewport, which is the largest reduction available without
    running an image-resizing service.
    """
    tag = match.group(0)
    if "loading=" in tag.lower():
        return tag
    addition = ' loading="lazy" decoding="async"'
    return tag[:-2] + addition + "/>" if tag.endswith("/>") else tag[:-1] + addition + ">"


def extract(page_html: str) -> str:
    """Pull the <article> out, strip scripts/styles, and lazy-load its figures."""
    match = ARTICLE_RE.search(page_html)
    if not match:
        raise NotRenderable("no <article> element found")
    body = match.group(0)
    body = SCRIPT_RE.sub("", body)
    body = STYLE_RE.sub("", body)
    return IMG_TAG_RE.sub(_lazy, body)


def _widest_table_columns(article_html: str) -> int:
    """The most cells in any single row -- a proxy for whether a table can reflow."""
    widest = 0
    for table in TABLE_RE.findall(article_html):
        for row in re.findall(r"<tr\b.*?</tr>", table, re.S | re.I):
            widest = max(widest, len(re.findall(r"<t[dh]\b", row, re.I)))
    return widest


def _class_count(article_html: str, name: str) -> int:
    """Count elements carrying a LaTeXML class.

    Matching `class="ltx_para"` exactly is wrong: LaTeXML emits multi-class attributes
    such as `class="ltx_para ltx_noindent"`, which an exact match silently misses.
    """
    return len(re.findall(rf'class="[^"]*\b{re.escape(name)}\b[^"]*"', article_html))


def measure(article_html: str) -> dict:
    """Structural metrics that predict reflow problems, computable without a browser."""
    text = WS_RE.sub(" ", TAG_RE.sub(" ", article_html)).strip()
    words = len(text.split())
    images = IMG_RE.findall(article_html)
    tables = TABLE_RE.findall(article_html)

    return {
        "words": words,
        "reading_minutes": round(words / WORDS_PER_MINUTE, 1),
        "paragraphs": _class_count(article_html, "ltx_para"),
        "headings": len(re.findall(r"<h[123]\b", article_html, re.I)),
        "figures": len(re.findall(r"<figure\b", article_html, re.I)),
        "images": len(images),
        "images_without_alt": sum(1 for i in images if "alt=" not in i.lower()),
        "math": len(re.findall(r"<math\b", article_html, re.I)),
        "display_math": len(MATH_DISPLAY_RE.findall(article_html)),
        "tables": len(tables),
        "widest_table_columns": _widest_table_columns(article_html),
        "references": _class_count(article_html, "ltx_bibitem"),
        "has_abstract": _class_count(article_html, "ltx_abstract") > 0,
    }


def _head_content_length(client: PoliteClient, url: str) -> int | None:
    """Content-Length via HEAD, reusing the polite client's per-host rate limiter."""
    import urllib.error
    import urllib.request

    client.limiter.wait(urlsplit(url).netloc)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": client.user_agent})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            length = resp.headers.get("Content-Length")
            return int(length) if length else None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def image_payload(client: PoliteClient, article_html: str, limit: int = 250) -> dict:
    """Total bytes of figure images, measured by HEAD on the resolved URLs.

    The browser cannot answer this: Resource Timing reports transferSize 0 for cross-origin
    resources unless the server sends Timing-Allow-Origin, and arxiv.org does not. So the
    real payload number has to come from the server side.

    Opt-in, because it costs one request per figure.
    """
    srcs = re.findall(r'<img\b[^>]*src="([^"]+)"', article_html)
    total = 0
    measured = 0
    unknown = 0
    largest = ("", 0)
    for src in srcs[:limit]:
        size = _head_content_length(client, urljoin(BASE_HREF, src))
        if size is None:
            unknown += 1
            continue
        total += size
        measured += 1
        if size > largest[1]:
            largest = (src, size)
    return {
        "images_measured": measured,
        "images_unknown": unknown,
        "image_bytes": total,
        "largest_image": largest[0],
        "largest_image_bytes": largest[1],
    }


def fetch_article(client: PoliteClient, arxiv_id: str) -> Article:
    url = f"{BASE_HREF}{arxiv_id}"
    resp = client.get(url)
    if resp.status != 200:
        raise NotRenderable(f"arXiv returned HTTP {resp.status} for {arxiv_id}")

    article_html = extract(resp.body)
    return Article(
        arxiv_id=arxiv_id,
        html=article_html,
        page_bytes=len(resp.body),
        article_bytes=len(article_html),
        metrics=measure(article_html),
    )


def reflow_risk(metrics: dict) -> list[str]:
    """Human-readable warnings about likely layout problems on a phone."""
    warnings: list[str] = []
    if metrics["widest_table_columns"] >= 5:
        warnings.append(
            f"widest table has {metrics['widest_table_columns']} columns -- "
            "will overflow a narrow viewport unless it scrolls or shrinks"
        )
    if metrics["display_math"] > 20:
        warnings.append(
            f"{metrics['display_math']} display equations -- each needs its own "
            "horizontal scroll container or it will force page-level overflow"
        )
    if metrics["images"] > 30:
        warnings.append(f"{metrics['images']} images -- payload will dominate load time")
    if metrics["images_without_alt"]:
        warnings.append(f"{metrics['images_without_alt']} images lack alt text")
    if metrics["words"] > 12000:
        warnings.append(
            f"{metrics['words']:,} words is ~{metrics['reading_minutes']:.0f} min -- "
            "long papers need progress affordances, not just scroll"
        )
    return warnings
