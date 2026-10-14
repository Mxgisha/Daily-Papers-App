#!/usr/bin/env python3
"""
Verify that reading-position save and restore actually work, against real arXiv HTML.

The point of this file: position restore was reported as "not working at all", and reasoning
about the injected script had already produced two wrong fixes. So this runs the *real* script
— `src/readerScript.ts`, the same module the app uses — in a real browser against a real
paper, and measures where the page ends up.

It checks two things:

  1. SAVE     scrolling produces a position report, and the reported fraction and anchor are
              consistent with where the page actually is.
  2. RESTORE  loading the script with a saved position, and pressing the header button
              (`window.__dpRestore()`), lands the reader back near where they stopped.

Usage:
    python3 harness/check_restore.py
    python3 harness/check_restore.py --paper 1706.03762 --at 0.5
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT.parent))

from reader.driver import Driver, DriverError  # noqa: E402
from reader.server import serve as serve_reader  # noqa: E402

PROXY_PORT = 8766  # deliberately not 8765, so this can run alongside the main harness


def build_script(spot: dict | None) -> str:
    """Ask tsx for the real injected script, so this cannot drift from the app."""
    payload = json.dumps({"spot": spot, "css": "", "theme": "dark"})
    result = subprocess.run(
        ["npx", "tsx", "harness/make_script.ts", payload],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(f"make_script failed:\n{result.stderr[-1500:]}")
    return result.stdout


# A stand-in for the native bridge, so the page's postMessage calls are captured.
STUB = """
window.__msgs = [];
window.ReactNativeWebView = { postMessage: function (s) { window.__msgs.push(s); } };
true;
"""

# NOTE: a real `return`, at the top level. WebDriver wraps the script in a function body, so
# a `return` inside an IIFE returns from the IIFE, and a trailing bare expression returns
# nothing at all — both of which silently yield None.
#
# `anchorTop` is where the anchored block element actually sits. The restore is anchor-first,
# and the document height differs between a save and a later load (figures arrive, fonts
# settle), so the fraction target and the anchor target legitimately disagree. Asserting on
# the fraction alone reports a failure for a restore that did exactly the right thing.
MEASURE = """
var sp = document.documentElement.scrollHeight - window.innerHeight;
var nodes = document.querySelectorAll(%s);
var msgs = (window.__msgs || []).map(function (s) { try { return JSON.parse(s); } catch (e) { return null; } })
                                    .filter(Boolean);
var positions = msgs.filter(function (m) { return m.type === 'position'; });
var ai = window.__testAnchor;
var anchorTop = null;
if (typeof ai === 'number' && ai >= 0 && nodes[ai]) {
  anchorTop = Math.round(nodes[ai].getBoundingClientRect().top + window.scrollY);
}
return JSON.stringify({
  y: Math.round(window.scrollY),
  span: Math.round(sp),
  fraction: sp > 0 ? window.scrollY / sp : 0,
  lastPosition: positions.length ? positions[positions.length - 1] : null,
  restored: msgs.filter(function (m) { return m.type === 'restored'; }).length,
  blocks: nodes.length,
  anchorTop: anchorTop
});
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--paper", default="2610.13948")
    ap.add_argument("--at", type=float, default=0.5, help="fraction to scroll to when saving")
    args = ap.parse_args()

    proxy = serve_reader(port=PROXY_PORT)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PROXY_PORT}/read/{args.paper}"
    print(f"reader proxy on http://127.0.0.1:{PROXY_PORT}")
    print(f"paper: {args.paper}")

    block_selector = json.loads(
        subprocess.run(
            ["npx", "tsx", "harness/make_script.ts", "--selector"],
            cwd=ROOT, capture_output=True, text=True, timeout=180,
        ).stdout
    )
    measure = MEASURE % json.dumps(block_selector)

    failures: list[str] = []
    report: dict = {"paper": args.paper, "url": url}

    try:
        with Driver(device="iphone14") as d:
            # ---------- 1. SAVE ----------
            d.get(url)
            time.sleep(6)  # the proxy fetches and rewrites arXiv's page
            d.js(STUB)
            d.js(build_script(None))
            time.sleep(1.0)

            before = json.loads(d.js(measure))
            report["save"] = {"before": before}
            if before["span"] <= 0:
                failures.append("document did not lay out (no scrollable height)")
                raise SystemExit(1)

            # Scroll the way a reader would, then let the 600ms report throttle pass.
            d.js(f"window.scrollTo(0, {args.at} * (document.documentElement.scrollHeight - window.innerHeight)); true;")
            time.sleep(2.0)
            after = json.loads(d.js(measure))
            report["save"]["after"] = after

            saved = after.get("lastPosition")
            if not saved:
                failures.append("NO POSITION WAS REPORTED after scrolling — saving is broken")
            else:
                report["saved"] = saved
                # The report is throttled and taken slightly before the scroll settles, so
                # compare against the page's own reading rather than demanding equality.
                delta = abs(saved["fraction"] - after["fraction"])
                report["save"]["fraction_delta"] = round(delta, 4)
                if delta > 0.06:
                    failures.append(
                        f"reported fraction {saved['fraction']:.3f} disagrees with the page's "
                        f"{after['fraction']:.3f}"
                    )
                if saved.get("anchor", -1) < 0:
                    failures.append("no anchor was reported — the block selector matched nothing")

            # ---------- 2. RESTORE ----------
            # Fresh load, as if the reader reopened the paper.
            d.get(url)
            time.sleep(6)
            d.js(STUB)
            d.js(build_script(saved))
            # Tell the measurement where the anchored block is, so it can report where that
            # element actually ended up.
            d.js(f"window.__testAnchor = {(saved or {}).get('anchor', -1)}; true;")
            time.sleep(0.5)

            auto = json.loads(d.js(measure))
            report["restore_auto"] = auto
            target_y = (saved or {}).get("fraction", 0) * auto["span"]
            report["restore_auto"]["fraction_target_y"] = round(target_y)
            report["restore_auto"]["fraction_error_px"] = round(abs(auto["y"] - target_y))

            # Then the explicit button, which is the path the reader actually presses.
            d.js("window.__dpRestore && window.__dpRestore(); true;")
            time.sleep(1.5)
            button = json.loads(d.js(measure))
            report["restore_button"] = button
            if button.get("anchorTop") is not None:
                # The anchor is the authority: if the anchored block is at the top of the
                # screen, the reader is back where they were.
                err = abs(button["y"] - button["anchorTop"])
                report["restore_button"]["anchor_error_px"] = round(err)
            else:
                err = abs(button["y"] - target_y)
                report["restore_button"]["anchor_error_px"] = None
            report["restore_button"]["fraction_target_y"] = round(target_y)

            # A phone screen is ~700pt tall; being within a third of a screen is "you are
            # back where you were" rather than "somewhere in the document".
            if err > 240:
                failures.append(
                    f"restore button landed {err:.0f}px from the target "
                    f"(y={button['y']}, anchorTop={button.get('anchorTop')}, "
                    f"fraction_target={target_y:.0f})"
                )
    except DriverError as exc:
        failures.append(f"webdriver failure: {exc}")
    finally:
        proxy.shutdown()

    print()
    print(json.dumps(report, indent=2))
    print()
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("OK: position saves, and the restore button returns to it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
