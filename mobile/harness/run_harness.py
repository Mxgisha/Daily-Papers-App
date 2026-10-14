"""Build and execute the browser harness against the real bundle.

Phase 1 shipped a client that compiled but had never run. This actually runs it: the real
`src/core/` modules, in a real browser engine, over real HTTP, against the real artifacts.

Steps: bundle the harness with esbuild, stage it next to the bundle artifacts, serve them,
drive a headless Chromium through WebDriver mobile emulation, and read the results back out
of `window.__HARNESS__`.

Usage:
    python3 harness/run_harness.py --bundle ../dist --out ../reports/harness
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
ROOT = MOBILE.parent
sys.path.insert(0, str(ROOT))

from reader.driver import DEVICES, Driver, DriverError  # noqa: E402

STAGE = MOBILE / ".harness"

INDEX = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Papers — client harness</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 14px; background: #16181c; color: #e6e6e6;
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h1.ok { color: #7ee787; } h1.bad { color: #ff7b72; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
       color: #9aa0a8; margin: 18px 0 6px; }
  ul { margin: 0; padding-left: 18px; }
  li { margin: 3px 0; }
  .ok { color: #7ee787; } .bad { color: #ff7b72; }
  .dim { color: #8b9199; font-size: 12px; }
  pre { background: #1e2126; padding: 10px; border-radius: 6px; overflow-x: auto;
        font-size: 12px; color: #c9d1d9; }
  ul.feed li { margin: 9px 0; }
</style></head>
<body><div id="out">running…</div>
<script type="module" src="./harness.js"></script>
</body></html>
"""


def build_harness() -> None:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    result = subprocess.run(
        [
            "npx", "esbuild", "harness/run.ts",
            "--bundle", "--format=esm", "--target=es2022",
            f"--outfile={STAGE / 'harness.js'}",
        ],
        cwd=MOBILE,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"esbuild failed:\n{result.stdout}\n{result.stderr}")


def stage_bundle(bundle: Path) -> None:
    """Copy the artifacts next to the harness so one origin serves everything."""
    for item in bundle.iterdir():
        target = STAGE / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    (STAGE / "index.html").write_text(INDEX)


def serve() -> ThreadingHTTPServer:
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(STAGE), **kw)

        def log_message(self, *a):  # quiet
            pass

        def end_headers(self):
            # The delta and vectors are fetched as ArrayBuffers; no caching during a run.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=str(ROOT / "dist"))
    ap.add_argument("--out", default=str(ROOT / "reports" / "harness"))
    ap.add_argument("--device", default="iphone14", choices=sorted(DEVICES))
    ap.add_argument("--timeout", type=float, default=90.0)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("building harness ...")
    build_harness()
    stage_bundle(Path(args.bundle))

    httpd = serve()
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/index.html"
    print(f"serving {url}")

    try:
        with Driver(device=args.device) as driver:
            driver.get(url)
            # Poll until the harness publishes its result.
            import time

            deadline = time.time() + args.timeout
            result = None
            while time.time() < deadline:
                result = driver.js(
                    "return window.__HARNESS__ ? JSON.stringify(window.__HARNESS__) : null;"
                )
                if result:
                    break
                time.sleep(0.5)

            shot = out_dir / "harness.png"
            driver.screenshot(shot)
    except DriverError as exc:
        print(f"driver failed: {exc}")
        return 1
    finally:
        httpd.shutdown()

    if not result:
        print("harness produced no result within the timeout")
        return 1

    data = json.loads(result)
    (out_dir / "harness_result.json").write_text(json.dumps(data, indent=2))

    if not data.get("ok"):
        print(f"\nHARNESS FAILED\n  {data.get('error')}")
        print(f"  screenshot: {shot}")
        return 1

    print("\n=== checks ===")
    for c in data["checks"]:
        print(f"  [{'PASS' if c['pass'] else 'FAIL'}] {c['name']}  ({c['detail']})")
    print("\n=== stages ===")
    for s in data["stages"]:
        print(f"  {s['ms']:>6} ms  {s['name']}  — {s['detail']}")
    print("\n=== feed quality ===")
    for k, v in (data.get("quality") or {}).items():
        print(f"  {k:26s} {v}")
    print(f"\nscreenshot: {shot}")
    print(f"result:     {out_dir / 'harness_result.json'}")

    failed = [c["name"] for c in data["checks"] if not c["pass"]]
    if failed:
        print(f"\n{len(failed)} check(s) failed: {failed}")
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
