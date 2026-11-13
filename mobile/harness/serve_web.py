#!/usr/bin/env python3
"""Serve the exported web build, so the app can be looked at in a browser.

`npx expo export --platform web` produces static files plus a single-page app. A plain
`http.server` is not enough for that: navigating directly to `/saved` or `/read/<id>` would
404, because those routes only exist client-side. This falls back to `index.html` for any path
that is not a real file, which is what the router expects.

The reader screen loads the article from the reader proxy (see reader/server.py), so that
needs to be running too if papers should open.

Usage:
    python3 harness/serve_web.py --dir ../dist-web --port 8080
"""

from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class SpaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self) -> None:
        # Static assets keep their own 404s -- a missing bundle should be visible, not an
        # index.html dressed up as JavaScript.
        if not self.path.startswith(("/_expo/", "/assets/")):
            candidate = Path(self.directory or ".") / self.path.lstrip("/").split("?")[0]
            if not candidate.exists() and not self.path.startswith("/api/"):
                self.path = "/index.html"
        super().do_GET()

    def log_message(self, *args) -> None:
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="../dist-web")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    directory = str(Path(args.dir).resolve())
    if not Path(directory, "index.html").exists():
        print(f"no index.html in {directory} -- run `npx expo export --platform web` first")
        return 1

    handler = functools.partial(SpaHandler, directory=directory)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"serving {directory} on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
