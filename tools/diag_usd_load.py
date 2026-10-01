"""Why does /usd never report geometry here? Print, do not assert.

A test that only reports "TIMEOUT" makes the next run guess again. This prints
the state every 15s so the cause is a measurement: which request stalled, what
the status store says, and whether the engine object exists at all.

Run: env -u PYTHONPATH /opt/data/work/ifc/.venv/bin/python tools/diag_usd_load.py
"""
from __future__ import annotations

import contextlib
import pathlib
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

PORT = 8099
BASE = f"http://127.0.0.1:{PORT}"
REPO = pathlib.Path(__file__).resolve().parents[1]
SERVER = REPO / "tools" / "serve_local.py"


def main() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]  # [1] is the PORT; [0] is the IP string

    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(300):
            if proc.poll() is not None:
                raise SystemExit(f"server exited {proc.returncode}")
            with contextlib.suppress(OSError):
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    break
            time.sleep(0.1)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"])
            ctx = browser.new_context()
            page = ctx.new_page()
            logs: list[str] = []
            page.on("console", lambda m: logs.append(f"{m.type}: {m.text[:220]}"))
            page.on("pageerror", lambda e: logs.append(f"PAGEERROR: {str(e)[:400]}"))
            page.on("requestfailed", lambda r: logs.append(f"REQFAIL: {r.url[-70:]} {r.failure}"))
            # Track the big fetch: is it even STARTED, and does it finish?
            big: dict[str, object] = {}

            def on_response(r):
                if "api/usd" in r.url or "Achterhekers" in r.url:
                    big.setdefault("url", r.url.split("/")[-1])
                    big["status"] = r.status

            page.on("response", on_response)

            page.goto(f"{base}/usd", wait_until="domcontentloaded", timeout=60_000)
            for i in range(1, 41):  # up to 10 minutes
                time.sleep(15)
                try:
                    # `evaluate` is SYNCHRONOUS in the sync API — there is no
                    # promise to `.catch()` (that call raises
                    # "'dict' object has no attribute 'catch'").
                    snap = page.evaluate("""() => ({
                      t: Math.round(performance.now()/1000),
                      eng: typeof window.__usdEngine,
                      total: window.__usdEngine ? window.__usdEngine.totalCount : -1,
                      store: (window.__usdStore && window.__usdStore.getState
                              && window.__usdStore.getState().status) || null,
                      canvas: document.querySelectorAll('canvas').length,
                      text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120),
                    })""")
                except Exception as exc:  # the page may be mid-navigation
                    print(f"t+{i * 15:>4}s  EVAL FAILED: {str(exc)[:140]}")
                    continue
                st = snap["store"] or {}
                print(f"t+{snap['t']:>4}s  eng={snap['eng']:<9} total={snap['total']:<6} "
                      f"state={st.get('state','?'):<8} {str(st.get('detail',''))[:40]:<42} {snap['text'][:60]}")
                if snap["eng"] != "undefined" and snap["total"] > 0:
                    print("GEOMETRY APPEARED at t+%ss" % snap["t"])
                    break
            print(f"\nbig fetch: {big}")
            print("\n--- console/page errors ---")
            for line in logs[:25]:
                print("  ", line)
            page.close()
            browser.close()
    finally:
        proc.kill()
        with contextlib.suppress(Exception):
            proc.wait(timeout=10)


if __name__ == "__main__":
    main()
