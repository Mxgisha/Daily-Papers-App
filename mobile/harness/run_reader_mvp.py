"""Run the reader MVP in a real browser and screenshot both screens.

Verifies the thing that actually matters for this MVP: a list of papers appears, and opening
one renders the paper readably. Compiling is not evidence; this opens the app.

The reader proxy is `reader/server.py`, the spike server that fetches arXiv HTML, extracts
the article and applies the validated reader stylesheet. It runs here only because the web
build cannot inject CSS into a cross-origin iframe -- on native the WebView does that itself.

Usage:
    EXPO_PUBLIC_READER_PROXY=http://127.0.0.1:8765 npx expo export --platform web --output-dir ../dist-web
    python3 harness/run_reader_mvp.py --web ../dist-web --out ../reports/reader-mvp
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
ROOT = MOBILE.parent
sys.path.insert(0, str(ROOT))

from reader.driver import Driver, DriverError  # noqa: E402
from reader.server import serve as serve_reader  # noqa: E402

PROXY_PORT = 8765


class SpaHandler(SimpleHTTPRequestHandler):
    """Serves the exported SPA, falling back to index.html for client-side routes."""

    def __init__(self, *args, directory: str, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        target = Path(self.directory) / path.lstrip("/")
        # SPA fallback: unknown non-asset paths render the app shell. Note that "has a file
        # extension" is NOT a usable test here -- arXiv ids look like 2610.13948.
        if not target.exists() and not path.startswith(("/_expo/", "/assets/")):
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, *args):
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", default=str(ROOT / "dist-web"))
    ap.add_argument("--out", default=str(ROOT / "reports" / "reader-mvp"))
    ap.add_argument("--device", default="iphone14")
    ap.add_argument("--paper", default=None, help="arXiv id to open; defaults to the first listed")
    ap.add_argument("--timeout", type=float, default=60.0)
    args = ap.parse_args()

    web = Path(args.web)
    if not (web / "index.html").exists():
        raise SystemExit(f"no web build at {web}; run `npx expo export --platform web` first")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    proxy = serve_reader(port=PROXY_PORT)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    print(f"reader proxy on http://127.0.0.1:{PROXY_PORT}")

    app_server = ThreadingHTTPServer(
        ("127.0.0.1", 0), lambda *a, **kw: SpaHandler(*a, directory=str(web), **kw)
    )
    app_port = app_server.server_address[1]
    threading.Thread(target=app_server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{app_port}"
    print(f"app on {base}")

    report: dict = {"base": base, "proxy": f"http://127.0.0.1:{PROXY_PORT}"}

    try:
        with Driver(device=args.device) as driver:
            # ---- list screen -------------------------------------------------
            driver.get(base + "/")
            time.sleep(4)
            list_path = out / "01-list.png"
            driver.screenshot(list_path)

            report["list"] = driver.js(
                """
                return JSON.stringify({
                  bodyText: (document.body.innerText || '').slice(0, 400),
                  cards: document.querySelectorAll('[role="button"]').length,
                  inputs: document.querySelectorAll('input').length,
                });
                """
            )

            # Find the first paper id by reading it out of the rendered list.
            first_id = driver.js(
                r"""
                var m = (document.body.innerText || '').match(/\b\d{4}\.\d{4,5}\b/);
                return m ? m[0] : null;
                """
            )
            paper = args.paper or first_id
            if not paper:
                print("could not determine a paper id from the list")
                return 1
            report["paper"] = paper

            # ---- reader screen ----------------------------------------------
            driver.get(f"{base}/read/{paper}")
            deadline = time.time() + args.timeout
            src = None
            while time.time() < deadline:
                src = driver.js(
                    "var f = document.querySelector('iframe'); return f ? f.src : null;"
                )
                if src:
                    break
                time.sleep(0.5)
            # Let the iframe fetch and render the paper before the screenshot.
            time.sleep(8)

            reader_path = out / "02-reader.png"
            driver.screenshot(reader_path)
            report["reader"] = {
                "url": f"{base}/read/{paper}",
                "iframe_src": src,
                "used_proxy": bool(src and str(PROXY_PORT) in src),
            }
    except DriverError as exc:
        print(f"driver failed: {exc}")
        return 1
    finally:
        app_server.shutdown()
        proxy.shutdown()

    (out / "report.json").write_text(json.dumps(report, indent=2))

    print("\n=== list screen ===")
    print(json.loads(report["list"]) if isinstance(report.get("list"), str) else report["list"])
    print("\n=== reader screen ===")
    print(json.dumps(report["reader"], indent=2))
    print(f"\nscreenshots: {out}/01-list.png, {out}/02-reader.png")

    ok = bool(report["reader"]["iframe_src"])
    print("\nOK: reader rendered an iframe" if ok else "\nFAILED: no reader iframe")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
