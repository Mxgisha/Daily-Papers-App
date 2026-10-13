"""CLI for the reader spike.

    python3 -m reader serve --port 8765        # browse it yourself
    python3 -m reader metrics 2610.13935       # structural metrics, no browser
    python3 -m reader shot 2610.13935          # headless phone-width screenshot + real metrics
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from dailypapers.http import PoliteClient

from .extract import NotRenderable, fetch_article, image_payload, reflow_risk

CACHE = Path("data/cache")


def cmd_metrics(args) -> int:
    client = PoliteClient(CACHE, min_interval=0.6)
    try:
        article = fetch_article(client, args.arxiv_id)
    except NotRenderable as exc:
        print(f"not renderable: {exc}")
        return 1

    payload = {
        "arxiv_id": article.arxiv_id,
        "page_bytes": article.page_bytes,
        "article_bytes": article.article_bytes,
        "article_share": round(article.article_bytes / article.page_bytes, 3),
        **article.metrics,
        "reflow_risks": reflow_risk(article.metrics),
    }
    if args.image_bytes:
        print("measuring figure payload (one HEAD per image) ...", file=sys.stderr)
        payload.update(image_payload(client, article.html))
    print(json.dumps(payload, indent=2))
    return 0


def _wait_for(url: str, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.15)
    return False


def cmd_shot(args) -> int:
    """Self-contained: starts the server on an ephemeral port, shoots, tears down.

    Uses WebDriver mobile emulation rather than `chromium --window-size`, because chromium
    clamps the layout viewport to a 500px minimum -- a 390px screenshot of a 500px layout
    is not a phone-width test.
    """
    from .driver import DEVICES, Driver, DriverError
    from .server import serve

    if args.device not in DEVICES:
        print(f"unknown device {args.device!r}; known: {', '.join(DEVICES)}")
        return 2

    httpd = serve(port=0)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    base = f"http://127.0.0.1:{port}"
    if not _wait_for(f"{base}/"):
        print("server did not come up")
        return 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    url = f"{base}/read/{args.arxiv_id}"

    try:
        with Driver(device=args.device) as driver:
            driver.get(url)
            time.sleep(args.settle)
            metrics = driver.js("return JSON.parse(document.getElementById('__metrics').textContent || 'null');")
            driver.screenshot(out)
    except DriverError as exc:
        print(f"driver failed: {exc}")
        return 1

    print(f"screenshot : {out}")
    if not metrics:
        print("could not read metrics from the page")
        return 1

    print(f"\nmeasured in an emulated {args.device} ({DEVICES[args.device][0]}x{DEVICES[args.device][1]} CSS px):")
    print(f"  actual viewport     : {metrics['viewport'][0]}x{metrics['viewport'][1]}")
    print(f"  scroll height       : {metrics['scroll_height']:,}px")
    print(f"  screens of reading  : {metrics['screens']}")
    print(f"  page overflows x    : {metrics['page_overflow_x']} "
          f"(scrollWidth {metrics['scroll_width']} vs client {metrics['client_width']})")
    print(f"  overflowing elements: {metrics['overflowing_elements'] or 'none'}")
    print(f"  images              : {metrics['images']} "
          f"(broken {metrics['broken_images']}, wide-tables {metrics['wide_tables']})")
    print(f"  math / display math : {metrics['math']} / {metrics['display_math']}")
    print(f"  DOM nodes           : {metrics['dom_nodes']:,}")
    print(f"  ready               : {metrics['ready_ms']} ms")

    metrics_path = out.with_suffix(".metrics.json")
    metrics_path.write_text(json.dumps(metrics, indent=2))
    print(f"  wrote               : {metrics_path}")
    return 0 if not metrics["page_overflow_x"] else 1


def cmd_serve(args) -> int:
    from .server import serve

    httpd = serve(port=args.port)
    port = httpd.server_address[1]
    print(f"reader spike running at http://127.0.0.1:{port}/")
    print("press Ctrl-C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="reader", description="Reader feasibility spike")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="serve the reader locally")
    s.add_argument("--port", type=int, default=8765)

    m = sub.add_parser("metrics", help="structural metrics without a browser")
    m.add_argument("arxiv_id")
    m.add_argument(
        "--image-bytes",
        action="store_true",
        help="HEAD every figure to sum the real payload (one request per image)",
    )

    sh = sub.add_parser("shot", help="emulated phone screenshot + real reflow metrics")
    sh.add_argument("arxiv_id")
    sh.add_argument("--out", default="reports/reader_shot.png")
    sh.add_argument("--device", default="iphone14", help="emulated device preset (see driver.DEVICES)")
    sh.add_argument("--settle", type=float, default=6.0, help="seconds to wait for images and layout")

    args = ap.parse_args(argv)
    if args.cmd == "metrics":
        return cmd_metrics(args)
    if args.cmd == "shot":
        return cmd_shot(args)
    if args.cmd == "serve":
        return cmd_serve(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
