"""Minimal WebDriver client, used for real mobile-viewport measurement.

Why this exists: Chromium's `--window-size` clamps the *layout* viewport to a 500px minimum,
so a 390px headless screenshot is not a 390px layout -- it is a 500px layout rendered into a
390px image. That silently invalidates any measurement of reflow or overflow.

WebDriver's `mobileEmulation.deviceMetrics` applies a real `Emulation.setDeviceMetricsOverride`,
giving a genuine phone viewport. It is the only reliable way to test at phone width here.

Only the handful of WebDriver endpoints needed are implemented, over plain HTTP JSON.
"""

from __future__ import annotations

import base64
import json
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

DEVICES = {
    # name: (css width, css height, device pixel ratio)
    "iphone_se": (375, 667, 2),
    "iphone14": (390, 844, 3),
    "pixel7": (412, 915, 2.625),
    "tablet": (768, 1024, 2),
}

IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class DriverError(RuntimeError):
    pass


class Driver:
    """Chromedriver session with an emulated device viewport."""

    def __init__(
        self,
        device: str = "iphone14",
        user_agent: str = IPHONE_UA,
        executable: str | None = None,
        startup_timeout: float = 20.0,
    ) -> None:
        if device not in DEVICES:
            raise DriverError(f"unknown device {device!r}; known: {', '.join(DEVICES)}")
        self.width, self.height, self.pixel_ratio = DEVICES[device]
        self.device = device
        self.user_agent = user_agent

        self.executable = executable or shutil.which("chromedriver")
        if not self.executable:
            raise DriverError("chromedriver not found on PATH")

        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.session_id: str | None = None
        self._proc: subprocess.Popen | None = None
        self._startup_timeout = startup_timeout

    # -- HTTP plumbing -----------------------------------------------------

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            raise DriverError(f"{method} {path} -> {exc.code}: {exc.read()[:300]!r}") from exc
        value = body.get("value")
        if isinstance(value, dict) and value.get("error"):
            raise DriverError(f"{method} {path} -> {value.get('error')}: {value.get('message')}")
        return body

    # -- Lifecycle ---------------------------------------------------------

    def start(self) -> "Driver":
        self._proc = subprocess.Popen(
            [self.executable, f"--port={self.port}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + self._startup_timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{self.base}/status", timeout=2):
                    break
            except (urllib.error.URLError, OSError):
                time.sleep(0.2)
        else:
            raise DriverError("chromedriver did not start")

        payload = {
            "capabilities": {
                "alwaysMatch": {
                    "browserName": "chrome",
                    "goog:chromeOptions": {
                        "args": ["--headless=new", "--no-sandbox", "--disable-gpu"],
                        "mobileEmulation": {
                            "deviceMetrics": {
                                "width": self.width,
                                "height": self.height,
                                "pixelRatio": self.pixel_ratio,
                                "mobile": True,
                            },
                            "userAgent": self.user_agent,
                        },
                    },
                }
            }
        }
        body = self._request("POST", "/session", payload)
        self.session_id = body["value"]["sessionId"]
        return self

    def quit(self) -> None:
        if self.session_id:
            try:
                self._request("DELETE", f"/session/{self.session_id}")
            except (DriverError, OSError):
                pass
            self.session_id = None
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None

    def __enter__(self) -> "Driver":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.quit()

    # -- Actions -----------------------------------------------------------

    def _sid(self) -> str:
        if not self.session_id:
            raise DriverError("session not started")
        return self.session_id

    def get(self, url: str) -> None:
        self._request("POST", f"/session/{self._sid()}/url", {"url": url})

    def js(self, script: str, args: list | None = None):
        body = self._request(
            "POST",
            f"/session/{self._sid()}/execute/sync",
            {"script": script, "args": args or []},
        )
        return body.get("value")

    def screenshot(self, path: Path) -> None:
        body = self._request("GET", f"/session/{self._sid()}/screenshot")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(body["value"]))
