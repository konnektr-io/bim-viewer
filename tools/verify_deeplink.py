"""End-to-end check of the two things this change claims.

1. `/ifc` and `/usd` each open that format DIRECTLY on a cold load — and the
   load that must NOT happen is asserted by watching the network, not by
   inference. A /usd load that quietly fetched and converted the 17.7 MB IFC
   would still render a correct-looking USD view, so the absence of the request
   is the claim, and the request trace is the only evidence for it.
2. The panels collapse, and a collapsed panel survives a reload.

The test server is started BY this script. A background server can be killed
between the probe and the verification, and ERR_CONNECTION_REFUSED then reads as
"the viewer is broken" when nothing was tested.
"""
from __future__ import annotations

import contextlib
import pathlib
import socket
import subprocess
import sys
import time

from playwright.sync_api import Page, sync_playwright

PORT = 8097
BASE = f"http://127.0.0.1:{PORT}"
REPO = pathlib.Path(__file__).resolve().parents[1]
SERVER = REPO / "tools" / "serve_local.py"

# USD manifest meshCount on this model. The USD view is asserted to reach it, so
# a load that silently fell back to something else cannot pass.
USD_MESHES = 1448

failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global checks
    checks += 1
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{f'  — {detail}' if detail != '' else ''}")
    if not ok:
        failures.append(label)


def free_port(port: int) -> bool:
    # SO_REUSEADDR, or a port left in TIME_WAIT by the previous run reads as
    # busy for ~60 s after it — and this check is the ONLY thing standing
    # between a stale server and a test that silently verifies old code.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


@contextlib.contextmanager
def server():
    if not free_port(PORT):
        raise SystemExit(f"port {PORT} is busy — a stale server serves old code")
    proc = subprocess.Popen(
        [sys.executable, str(SERVER)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for the port to START answering, not for it to be free. Testing
        # `free_port` here is inverted: it reports True while the server is
        # still starting, so the loop would break instantly and hand the test a
        # port with nothing behind it.
        for _ in range(200):
            if proc.poll() is not None:
                raise SystemExit(f"test server exited with {proc.returncode}")
            with contextlib.suppress(OSError):
                with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                    break
            time.sleep(0.1)
        else:
            raise SystemExit("test server never came up")
        yield proc
    finally:
        # Kill by PID and do not swallow a failure: a surviving server holds the
        # port for the NEXT run, which then tests the old build and calls it a
        # pass.
        proc.kill()
        with contextlib.suppress(Exception):
            proc.wait(timeout=10)


def wait_ready(page: Page, needle: str, timeout: int = 420_000) -> str:
    """Wait for a load to finish, and FAIL on timeout.

    A wait loop that falls through on timeout reports PASS with zero meshes,
    which is how a load that produced nothing passes a test written to catch it.
    """
    try:
        page.wait_for_function(
            "(n) => document.body.innerText.includes(n)", arg=needle, timeout=timeout
        )
    except Exception:
        raise SystemExit(f"TIMEOUT waiting for {needle!r} — load never completed")
    return page.inner_text("body").split("STOREY")[0].strip()[:120]


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
    page.on(
        "requestfailed",
        lambda r: errors.append(f"REQFAIL: {r.url} {r.failure}"),
    )
    return page, errors, requests


def main() -> None:
    with server(), sync_playwright() as play:
        browser = play.chromium.launch(
            args=[
                "--ignore-certificate-errors",
                "--enable-unsafe-swiftshader",
                "--use-gl=angle",
                "--use-angle=swiftshader",
            ]
        )
        # One context for the whole run: localStorage is scoped to the CONTEXT,
        # so the "a fold survives a new load" check needs the same context as the
        # page that set it. A fresh browser per page would silently give each
        # one empty storage and the check would pass for the wrong reason.
        context = browser.new_context(ignore_https_errors=True)

        # ------------------------------------------------------------------
        print("\n=== 1. cold load of /usd opens USD, and never fetches the IFC ===")
        page, errors, requests = new_page(context)
        page.goto(f"{BASE}/usd", wait_until="domcontentloaded", timeout=60_000)
        status = wait_ready(page, "meshes")
        print("  status:", status)

        check("URL is /usd", page.url.rstrip("/").endswith("/usd"), page.url)
        check("pathname is exactly /usd", page.evaluate("() => location.pathname") == "/usd")
        check(
            "the IFC model was NEVER requested",
            not any("/api/model/" in u for u in requests),
            [u for u in requests if "/api/model/" in u] or "no /api/model/ request",
        )
        check(
            "the IFC engine was never constructed",
            page.evaluate("() => typeof window.__bimEngine === 'undefined'"),
        )
        check(
            "the USD engine IS constructed",
            bool(page.evaluate("() => !!window.__usdEngine")),
        )
        check(
            "the USDZ package was fetched",
            any("/api/usd/scene.usdz" in u for u in requests),
        )
        check(
            "the status line reports the manifest mesh count",
            f"{USD_MESHES:,} meshes" in status,
            status.splitlines()[2] if len(status.splitlines()) > 2 else status,
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

        # The panel: collapsible, and remembered.
        print("\n=== 2. panels collapse, and a collapsed panel survives a reload ===")
        model = page.locator('[data-testid="panel-model"]')
        section = page.locator('[data-testid="panel-section"]')
        # `[data-panel-toggle]` is the panel's own fold button. It cannot be
        # selected as `button[aria-expanded]` because the asset tree inside the
        # panel has its own collapsibles, and Playwright's strict mode rejects a
        # locator that matches several.
        model_toggle = page.locator('[data-panel-toggle="model"]')
        section_toggle = page.locator('[data-panel-toggle="section-usd"]')
        check("model panel starts open", model_toggle.get_attribute("aria-expanded") == "true")
        check("section panel starts open", section_toggle.get_attribute("aria-expanded") == "true")

        check("the storey list is rendered before folding", "Frame all" in model.inner_text())
        model_toggle.click(force=True)
        section_toggle.click(force=True)
        time.sleep(0.4)
        check(
            "a collapsed panel renders NO body",
            "Frame all" not in model.inner_text() and "Height" not in section.inner_text(),
            model.inner_text()[:80],
        )
        check(
            "a collapsed panel still shows its title",
            "Achterhekers 57" in model.inner_text(),
            model.inner_text()[:80],
        )
        check(
            "the section On/Off toggle survives the fold",
            section.get_by_role("button", name="Turn the section on").count() == 1,
        )
        # The section defaults to `enabled: false`, so the button reads "Turn
        # the section on" and the panel must flip to "On" once clicked — the
        # assertion is on the STATE, not on the button, because the label is
        # the thing under test and reading it proves nothing.
        section.get_by_role("button", name="Turn the section on").click(force=True)
        page.wait_for_function(
            "() => !!document.querySelector('[data-testid=\"panel-section\"]')"
            " .querySelector('[aria-label=\"Turn the section off\"]')",
            timeout=10_000,
        )
        check("the toggle still works while collapsed", True)
        # Put the section back, so the next run starts from the default.
        # `force=True` everywhere: the render loop keeps elements from ever
        # being "stable", so a default click waits for a condition that will
        # never hold.
        section.get_by_role("button", name="Turn the section off").click(force=True)
        time.sleep(0.5)

        # A fresh PAGE in the same context, not a reload of this one: the live
        # WebGL render loop keeps the old page busy enough that navigating it
        # again never settles, and a new page is the better test anyway —
        # localStorage is shared per context, so "does a new load remember the
        # fold" is precisely what this claims.
        #
        # The FIRST page is closed before the second opens. Two pages each
        # running their own swiftshader render loop starve each other in this
        # container, and the second load never completes.
        #
        # Note what is NOT waited for: the USD meshes. The fold is read from
        # localStorage when the panel MOUNTS, which is seconds into the load
        # rather than minutes, and waiting for the 64 MB compose would test the
        # model, not the persistence. The panel's presence is the gate, and it
        # is asserted with a short timeout so a genuine failure is fast.
        page.close()
        page2, errors2, _ = new_page(context)
        page2.goto(f"{BASE}/usd", wait_until="domcontentloaded", timeout=60_000)
        try:
            page2.locator('[data-panel-toggle="model"]').wait_for(timeout=60_000)
        except Exception:
            raise SystemExit("TIMEOUT: the model panel never mounted on a fresh load")
        time.sleep(0.5)
        check(
            "a collapsed panel is still collapsed in a NEW page",
            page2.locator('[data-panel-toggle="model"]').get_attribute("aria-expanded") == "false",
        )
        check(
            "and its sibling stayed folded too",
            page2.locator('[data-panel-toggle="section-usd"]').get_attribute("aria-expanded")
            == "false",
        )
        # Put them back so the next run starts from a known state.
        page2.locator('[data-panel-toggle="model"]').click(force=True)
        page2.locator('[data-panel-toggle="section-usd"]').click(force=True)
        time.sleep(0.3)
        page2.close()

        # ------------------------------------------------------------------
        print("\n=== 3. cold load of /ifc opens IFC, and never fetches the USDZ ===")
        page, errors, requests = new_page(context)
        page.goto(f"{BASE}/ifc", wait_until="domcontentloaded", timeout=60_000)
        status = wait_ready(page, "elements")
        print("  status:", status)
        check("URL is /ifc", page.evaluate("() => location.pathname") == "/ifc")
        check(
            "the USD scene was NEVER requested",
            not any("/api/usd/scene" in u for u in requests),
            [u for u in requests if "/api/usd/scene" in u] or "no /api/usd/scene request",
        )
        check("the IFC engine IS constructed", bool(page.evaluate("() => !!window.__bimEngine")))
        check("elements are reported", "elements" in status, status)

        # ------------------------------------------------------------------
        print("\n=== 4. the tabs move the URL, and Back restores the view ===")
        # Every tab switch below goes through `switch_to`, which clicks the
        # anchor from INSIDE the page. A Playwright click on this viewer needs
        # the main thread to process a real input event, and while an engine is
        # converting (17.7 MB IFC, 64 MB USDZ) that thread is saturated for
        # minutes — so the click times out on a tab that is plainly there.
        # `get_by_role` is worse: it needs the accessibility tree, which is
        # built on the same thread, so it cannot even resolve the element.
        # Calling `.click()` in the page runs the identical React handler.
        def switch_to(page: Page, format_: str) -> None:
            page.evaluate(
                "(f) => document.querySelector(`[role=tablist] a[href='/${f}']`).click()",
                format_,
            )

        switch_to(page, "usd")
        page.wait_for_function("() => location.pathname === '/usd'", timeout=10_000)
        check("clicking USD pushes /usd", page.evaluate("() => location.pathname") == "/usd")

        switch_to(page, "ifc")
        page.wait_for_function("() => location.pathname === '/ifc'", timeout=10_000)
        check("clicking IFC pushes /ifc", page.evaluate("() => location.pathname") == "/ifc")

        # The anchor must also be a REAL link, or the URLs are not shareable.
        hrefs = page.evaluate(
            "() => [...document.querySelectorAll('[role=tablist] a')].map(a => a.getAttribute('href'))"
        )
        check("both tabs are real links", hrefs == ["/ifc", "/usd"], hrefs)

        # `go_back()` waits for a load event, and this page's main thread is busy
        # converting the IFC, so it times out on a navigation that has already
        # happened. Drive the history through the page's own API — which is
        # literally what popstate listens to — and assert the URL, not the load.
        before_back = len(errors)
        page.evaluate("() => history.back()")
        page.wait_for_function("() => location.pathname === '/usd'", timeout=30_000)
        check("Back returns to the USD view", page.evaluate("() => location.pathname") == "/usd")
        check("Back moved through history, not a reload", page.evaluate("() => performance.navigation.type") == 0)

        # The early-switch bug this feature exists to avoid: switching views must
        # not leave a half-torn-down engine throwing.
        for target in ("ifc", "usd", "ifc"):
            switch_to(page, target)
            page.wait_for_function(
                "(n) => document.body.innerText.includes(n)",
                arg="elements" if target == "ifc" else "meshes",
                timeout=420_000,
            )
            time.sleep(2)
        switched = [e for e in errors[before_back:] if "ragment" in e or "not found" in e]
        check("no fragments errors from switching views", not switched, switched[:3])

        # ------------------------------------------------------------------
        print("\n=== 5. the inspector is still collapsible AND still renders ===")
        switch_to(page, "ifc")
        page.wait_for_function(
            "() => document.body.innerText.includes('elements')", timeout=420_000
        )
        # `reportSelection` is async and goes out to the Fragments worker, so
        # `evaluate` returns before the panel exists. Wait for the panel rather
        # than sleeping a guessed interval: a fixed sleep is a race that passes
        # on a fast machine and fails on a loaded one.
        page.evaluate(
            "() => window.__bimEngine.reportSelection"
            "({ 'Achterhekers57.ifc': new Set([7211]) })"
        )
        sel = page.locator('[data-testid="selection-panel"]')
        try:
            sel.wait_for(timeout=120_000)
        except Exception:
            raise SystemExit("TIMEOUT: the inspector never appeared after a selection")
        sel_toggle = page.locator('[data-panel-toggle="selection-ifc"]')
        sel_toggle.wait_for(timeout=30_000)
        check("the inspector appears on a pick", sel.count() == 1)
        check("the inspector starts open", sel_toggle.get_attribute("aria-expanded") == "true")
        text = sel.inner_text()
        check("it still renders the property sets", "Pset_WallCommon" in text, text[:120])
        sel_toggle.click(force=True)
        time.sleep(0.4)
        check(
            "the inspector folds independently",
            "Pset_WallCommon" not in sel.inner_text() and "localId" not in sel.inner_text(),
            sel.inner_text()[:80],
        )
        check(
            "a folded inspector keeps its copy buttons",
            sel.locator('[aria-label="Copy localId"]').count() == 1,
        )
        sel_toggle.click(force=True)

        real = [e for e in errors if not e.startswith("REQFAIL")]
        check("no page/console errors", not real, real[:5])

        browser.close()

    print(f"\n{'=' * 50}\n{checks - len(failures)}/{checks} checks passed")
    print("FAILURES:", failures or "none")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
