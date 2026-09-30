"""Fast checks: format deep links and panel folding, with NO model bytes.

WHY A STUB AND NOT THE REAL THINGS
----------------------------------
The claims here are decided long before a model arrives:

- which engine gets CONSTRUCTED — the format is seeded from the URL at store
  construction, so the decision is made before either effect mounts;
- which REQUESTS go out — observable from the network trace at fetch time;
- whether a folded panel STAYS folded — read from localStorage at mount.

None of that needs a 17.7 MB conversion or a 64 MB compose, and waiting for
those made every iteration cost minutes. `verify_deeplink.py` still proves the
loads themselves, once. This file exists so the fast loop is fast.

Run from the repo root:
    env -u PYTHONPATH /opt/data/work/ifc/.venv/bin/python tools/verify_fast.py
"""
from __future__ import annotations

import contextlib
import socket
import subprocess
import sys
import time
from collections.abc import Generator
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

PORT = 8096
BASE_HOST = "127.0.0.1"
REPO = Path(__file__).resolve().parents[1]
SERVER = REPO / "tools" / "serve_stub.py"

failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global checks
    checks += 1
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{f'  — {detail}' if detail != '' else ''}")
    if not ok:
        failures.append(label)


def free_port(start: int) -> int:
    """The first bindable port at or after `start`.

    NOT a hardcoded port. A fixed one made every run after a crash or a timeout
    abort with "port is busy — a stale server serves old code" when no process
    of ours was listening, and the guard exists precisely to stop a stale server
    passing a test, so it must not cry wolf. SO_REUSEADDR alone does not help:
    a live listener (or one in a namespace this process cannot see) blocks the
    bind regardless.
    """
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((BASE_HOST, port))
            except OSError:
                continue
            return port
    raise SystemExit(f"no free port in {start}..{start + 40}")


@contextlib.contextmanager
def server() -> "Generator[int, None, None]":
    port = free_port(PORT)
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for the port to START ANSWERING. Polling a bind here is
        # inverted: the port is bindable while the server is still starting.
        for _ in range(200):
            if proc.poll() is not None:
                raise SystemExit(f"test server exited with {proc.returncode}")
            with contextlib.suppress(OSError):
                with socket.create_connection((BASE_HOST, port), timeout=0.5):
                    break
            time.sleep(0.1)
        else:
            raise SystemExit("test server never came up")
        yield port
    finally:
        # Kill by PID and let a failure surface: a surviving server would serve
        # the OLD build to the next run and call it a pass.
        proc.kill()
        with contextlib.suppress(Exception):
            proc.wait(timeout=10)


def new_page(context) -> tuple[Page, list[str], list[str]]:
    page = context.new_page()
    errors: list[str] = []
    requests: list[str] = []
    page.on(
        "console",
        lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
    )
    page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
    page.on("request", lambda r: requests.append(r.url))
    return page, errors, requests


def wait_mounted(page: Page, selector: str, what: str) -> None:
    try:
        page.locator(selector).first.wait_for(timeout=45_000)
    except Exception:
        raise SystemExit(f"TIMEOUT: {what} never mounted")


def main() -> None:
    with server() as port, sync_playwright() as play:
        base = f"http://{BASE_HOST}:{port}"
        browser = play.chromium.launch(
            args=[
                "--enable-unsafe-swiftshader",
                "--use-gl=angle",
                "--use-angle=swiftshader",
            ]
        )
        # One context throughout: localStorage is per CONTEXT, so the
        # "a fold survives a new load" check needs the same one.
        context = browser.new_context()

        # ------------------------------------------------------------------
        print("\n=== 1. /usd mounts the USD engine and never asks for the IFC ===")
        page, errors, requests = new_page(context)
        page.goto(f"{base}/usd", wait_until="domcontentloaded", timeout=60_000)
        wait_mounted(page, '[data-panel-toggle="model"]', "the model panel")

        check("pathname is /usd", page.evaluate("() => location.pathname") == "/usd")
        check(
            "the IFC engine was never constructed",
            bool(page.evaluate("() => typeof window.__bimEngine === 'undefined'")),
        )
        check("the USD engine IS mounted", bool(page.evaluate("() => !!window.__usdEngine")))
        check(
            "no /api/model/ request went out",
            not any("/api/model/" in u for u in requests),
            [u for u in requests if "/api/model/" in u] or "none",
        )
        check(
            "the USD manifest WAS fetched",
            any("/api/usd/manifest" in u for u in requests),
        )
        check(
            "the USD tab is the active one",
            bool(
                page.evaluate(
                    "() => document.querySelector(`[role=tablist] a[href='/usd']`).className"
                    " .includes('bg-primary')"
                )
            ),
        )

        # ------------------------------------------------------------------
        print("\n=== 2. panels fold, and a fold survives a new load ===")
        # `[data-panel-toggle]` names the panel's own fold. `button[aria-expanded]`
        # also matches every asset-tree node inside the panel, and Playwright's
        # strict mode rejects a locator that resolves to several.
        model_toggle = page.locator('[data-panel-toggle="model"]')
        model = page.locator('[data-testid="panel-model"]')
        check("model panel starts open", model_toggle.get_attribute("aria-expanded") == "true")
        check("the model title is in the header", "Stub model" in model.inner_text())

        model_toggle.click(force=True)
        time.sleep(0.3)
        check("it folds", model_toggle.get_attribute("aria-expanded") == "false")
        check("a folded panel still shows its title", "Stub model" in model.inner_text())

        model_toggle.click(force=True)
        time.sleep(0.3)
        check("it unfolds", model_toggle.get_attribute("aria-expanded") == "true")
        model_toggle.click(force=True)  # leave it FOLDED for the next page
        time.sleep(0.3)

        # A fresh PAGE in the same context. `reload()` waits for a load event the
        # live render loop never fires, and localStorage is per context, so this
        # is both the working reload and the truer test.
        page.close()
        page2, _, _ = new_page(context)
        page2.goto(f"{base}/usd", wait_until="domcontentloaded", timeout=60_000)
        wait_mounted(page2, '[data-panel-toggle="model"]', "the model panel (2nd page)")
        check(
            "the fold survived into a new page",
            page2.locator('[data-panel-toggle="model"]').get_attribute("aria-expanded") == "false",
        )
        page2.locator('[data-panel-toggle="model"]').click(force=True)  # reset
        time.sleep(0.3)
        page2.close()

        # ------------------------------------------------------------------
        print("\n=== 3. /ifc mounts the IFC engine and never asks for the USD ===")
        page, errors, requests = new_page(context)
        page.goto(f"{base}/ifc", wait_until="domcontentloaded", timeout=60_000)
        wait_mounted(page, '[data-panel-toggle="model"]', "the model panel")

        check("pathname is /ifc", page.evaluate("() => location.pathname") == "/ifc")
        check("the IFC engine IS mounted", bool(page.evaluate("() => !!window.__bimEngine")))
        check(
            "the USD engine was never constructed",
            bool(page.evaluate("() => typeof window.__usdEngine === 'undefined'")),
        )
        check(
            "no /api/usd/ request went out",
            not any("/api/usd/" in u for u in requests),
            [u for u in requests if "/api/usd/" in u] or "none",
        )

        # The IFC model request is NOT synchronous with mount. The engine does
        # `initWorld` -> `initFragments` (which AWAITS a wasm + worker fetch) and
        # only then calls `/api/config` and `/api/model/…`. So asserting on the
        # trace the instant the panel appears tests the harness, not the app.
        # Wait for the request to actually appear, with a bounded timeout.
        try:
            page.wait_for_event("request", lambda r: "/api/model/" in r.url, timeout=45_000)
            got = True
        except Exception:
            got = False
        check("the IFC model WAS requested", got)

        # ------------------------------------------------------------------
        print("\n=== 4. the tabs are links, and they move history ===")
        hrefs = page.evaluate(
            "() => [...document.querySelectorAll('[role=tablist] a')].map(a => a.getAttribute('href'))"
        )
        check("both tabs carry their canonical href", hrefs == ["/ifc", "/usd"], hrefs)

        # Click from INSIDE the page: a Playwright click needs the main thread to
        # process a real input event, and while an engine is loading it may not
        # for a long time. This runs the identical React handler.
        def switch_to(f: str) -> None:
            page.evaluate("(f) => document.querySelector(`[role=tablist] a[href='/${f}']`).click()", f)

        switch_to("usd")
        page.wait_for_function("() => location.pathname === '/usd'", timeout=30_000)
        check("clicking USD pushes /usd", page.evaluate("() => location.pathname") == "/usd")

        switch_to("ifc")
        page.wait_for_function("() => location.pathname === '/ifc'", timeout=30_000)
        check("clicking IFC pushes /ifc", page.evaluate("() => location.pathname") == "/ifc")

        # Re-selecting the format already shown is not a navigation, so it must
        # not add a history entry — otherwise mashing a tab fills the history.
        depth = page.evaluate("() => history.length")
        switch_to("ifc")
        time.sleep(0.3)
        check("re-clicking the active tab adds no history entry", page.evaluate("() => history.length") == depth)

        page.evaluate("() => history.back()")
        page.wait_for_function("() => location.pathname === '/usd'", timeout=30_000)
        check("Back restores the previous view", page.evaluate("() => location.pathname") == "/usd")
        check("Back did not reload the document", page.evaluate("() => performance.navigation.type") == 0)

        # An unknown path is not an error state; it falls back to the default.
        page4, _, _ = new_page(context)
        page4.goto(f"{base}/nonsense", wait_until="domcontentloaded", timeout=60_000)
        wait_mounted(page4, '[data-panel-toggle="model"]', "the model panel (unknown path)")
        check(
            "an unknown path falls back to IFC",
            bool(page4.evaluate("() => !!window.__bimEngine")),
        )
        page4.close()

        # The 404 on the stub's IFC route is expected: no model is served here.
        real = [e for e in errors if "PAGEERROR" in e or "TypeError" in e]
        check("no page errors", not real, real[:5])

        browser.close()

    print(f"\n{'=' * 50}\n{checks - len(failures)}/{checks} checks passed")
    print("FAILURES:", failures or "none")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
