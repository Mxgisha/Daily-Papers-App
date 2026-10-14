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
from urllib.parse import quote

MOBILE = Path(__file__).resolve().parent.parent
ROOT = MOBILE.parent
sys.path.insert(0, str(ROOT))

from reader.driver import Driver, DriverError  # noqa: E402
from reader.server import serve as serve_reader  # noqa: E402

PROXY_PORT = 8765

# react-native-web's Pressable responds to POINTER events, not `click`. Dispatching the full
# sequence is what makes a synthetic interaction behave like a real tap; a bare
# `element.click()` is silently ignored and makes a broken theme toggle look fine.
# NOTE: no IIFE. WebDriver wraps the script in a function body and returns from *that*, so a
# `return` inside an IIFE returns from the IIFE and the call yields undefined.
CLICK_THEME = r"""
var els = document.querySelectorAll('div,span,button,a');
for (var i = 0; i < els.length; i++) {
  var t = (els[i].textContent || '').trim();
  if (t !== 'Light' && t !== 'Dark') continue;
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
    var Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
    els[i].dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
  });
  return t;
}
return null;
"""

# The toggle label states the theme you can switch TO, so it flips on every press.
THEME_LABEL = r"""
var els = document.querySelectorAll('div,span,button,a');
for (var i = 0; i < els.length; i++) {
  var t = (els[i].textContent || '').trim();
  if (t === 'Light' || t === 'Dark') return t;
}
return null;
"""


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
            time.sleep(9)
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

            # ---- theme toggle, on the list screen ----------------------------
            # The nav bar used to be hardcoded dark, so light mode left a black bar. Capture
            # both themes and compare the header background to prove it follows.
            #
            # react-native-web's Pressable listens on POINTER events, not click, so a
            # synthetic .click() does nothing -- which is what the first version of this
            # check reported: two byte-identical screenshots and a "changed: False".
            label_before = driver.js(THEME_LABEL)
            # A real input event, not dispatchEvent: react-native-web's Pressable ignores
            # both synthetic click() and hand-dispatched pointer events, so neither reached
            # the handler and the toggle silently did nothing.
            try:
                el = driver.find_element(
                    "xpath",
                    "//*[@data-testid='theme-toggle']",
                )
                driver.click_element(el)
                clicked = label_before
            except DriverError:
                clicked = driver.js(CLICK_THEME)
            time.sleep(2.0)
            label_after = driver.js(THEME_LABEL)
            light_path = out / "03-list-light.png"
            driver.screenshot(light_path)
            report["theme"] = {
                "label_before": label_before,
                "label_clicked": clicked,
                "label_after": label_after,
                "changed": bool(label_before and label_after and label_before != label_after),
                "screenshot": str(light_path),
            }
            # Back to the original theme so later screenshots stay comparable.
            try:
                driver.click_element(
                    driver.find_element(
                        "xpath",
                        "//*[@data-testid='theme-toggle']",
                    )
                )
            except DriverError:
                driver.js(CLICK_THEME)
            time.sleep(1.5)

            if not paper:
                print("could not determine a paper id from the list")
                return 1
            report["paper"] = paper

            # ---- reader screen ----------------------------------------------
            # Old-style ids contain a slash; encode so the route is a single segment.
            driver.get(f"{base}/read/{quote(paper, safe='')}")
            deadline = time.time() + args.timeout
            src = None
            while time.time() < deadline:
                src = driver.js(
                    "var f = document.querySelector('iframe'); return f ? f.src : null;"
                )
                text = driver.js("return (document.body.innerText || '').slice(0, 300);") or ""
                # Either branch counts: an iframe for HTML full text, or the PDF fallback
                # for the ~4% of arXiv papers with no rendered HTML.
                if src or "No HTML full text" in text:
                    break
                time.sleep(0.5)
            # Let the iframe fetch and render the paper before the screenshot.
            time.sleep(8 if src else 2)

            reader_path = out / f"02-reader-{paper.replace('/', '_')}.png"
            driver.screenshot(reader_path)
            report["reader"] = {
                "url": f"{base}/read/{paper}",
                "iframe_src": src,
                "used_proxy": bool(src and str(PROXY_PORT) in src),
                "pdf_fallback_shown": "No HTML full text" in text,
                "body_text": text,
                "screenshot": str(reader_path),
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
    print(f"\nscreenshots: {out}/01-list.png, {report['reader']['screenshot']}")

    fallback = report["reader"]["pdf_fallback_shown"]
    ok = bool(report["reader"]["iframe_src"]) or fallback
    if fallback:
        print("\nOK: PDF fallback shown (paper has no HTML rendering on arXiv)")
    elif ok:
        print("\nOK: reader rendered the paper")
    else:
        print("\nFAILED: neither a reader iframe nor the PDF fallback appeared")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
