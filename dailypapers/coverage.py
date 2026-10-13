"""Detect genuinely rendered arXiv HTML full text.

A ``200`` response is not sufficient evidence. arXiv serves a styled HTML error page for
papers it has no HTML for, and the abs page is itself HTML. Requiring the LaTeXML marker
``ltx_page_content`` -- which appears only in real rendered full text -- is what makes the
coverage number trustworthy. Verified against known-good and known-missing papers.
"""

from __future__ import annotations

from .http import PoliteClient

HTML_URL = "https://arxiv.org/html/{arxiv_id}"

# Markers emitted by LaTeXML when it renders a paper. The first is the reliable one.
MARKERS = ("ltx_page_content", "ltx_document", "ltx_page_main")


def has_full_text_html(client: PoliteClient, arxiv_id: str) -> tuple[bool, int]:
    """Return (has_rendered_full_text, http_status)."""
    resp = client.get(HTML_URL.format(arxiv_id=arxiv_id))
    if resp.status != 200:
        return False, resp.status
    return any(m in resp.body for m in MARKERS), resp.status
