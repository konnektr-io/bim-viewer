"""Prove that the section cut also governs PICKING, in BOTH viewers.

THE CLAIM
---------
With a section enabled, a click must not return an element the section has cut
away. Concretely the report: a horizontal section showing only the ground
floor, viewed from above, selects the roof — because the click returns the first
thing the ray meets in the FULL model.

THE TWO BUGS THIS CATCHES
-------------------------
1. IFC — the GPU fast-picker and `SimpleRaycaster.filterClippingPlanes` both
   read `world.renderer.three.clippingPlanes`. The section was published only to
   per-material planes and the fragments `getClippingPlanesEvent`, so that list
   stayed EMPTY, the picker's id pass discarded nothing, and picking ignored the
   cut entirely.
2. USD — `pickables()` compared a LOCAL-space bounding-box centre against a
   WORLD-space plane (the composer's root carries `rotation.x = -PI/2`), and
   took `hits[0]` without testing the hit point, so a mesh straddling the plane
   stayed selectable above the cut.

HOW THE CLAIM IS MEASURED (not inferred)
----------------------------------------
For USD, one raycast down over the house centre is run TWICE at the same
position: once unfiltered, once restricted to the half-space the section keeps.
The test then asserts the unfiltered first hit is on the CLIPPED side and the
first kept hit is a DIFFERENT prim on the visible side. That is the bug stated
directly — no pixel heuristics, and nothing inferred from what is "supposed" to
be drawn.

For IFC the claim is checked at the seam the bug lived in: the plane must
appear in the array the picker actually reads, and the fragments CPU clip must
STILL measurably cut (a section that is "enabled" while the triangle count is
frozen is not cutting at all).

THE SIGN CONVENTION IS ASSERTED, NOT ASSUMED
--------------------------------------------
three.js' clipping shader discards where `plane.distanceToPoint(world) > 0`, so
the half that SURVIVES is `distance <= 0`. An inverted sign is the worst kind of
regression here: the section keeps working, the triangles still drop, and only
picking is quietly reporting the mirror image of the model. So the kept half is
measured against the live plane and asserted.

A full-model run costs 3-15 min (a 17.7 MB IFC and/or a 63 MB USDZ compose under
swiftshader), so this script runs ONCE, after the cheap harness in
`tools/verify_fast.py`.

Run: env -u PYTHONPATH /opt/data/work/ifc/.venv/bin/python tools/verify_section_pick.py
"""
from __future__ import annotations

import contextlib
import json
import pathlib
import socket
import subprocess
import sys
import time

from playwright.sync_api import Page, sync_playwright

PORT = 8098  # distinct from verify_deeplink's 8097 so the two never collide
BASE = f"http://127.0.0.1:{PORT}"
REPO = pathlib.Path(__file__).resolve().parents[1]
SERVER = REPO / "tools" / "serve_local.py"
DIST = REPO / "app" / "dist"

failures: list[str] = []
checks = 0

# Finite, but it is NOT the thing that was broken. `wait_for_function` defaults
# to rAF polling, which never samples on this main-thread-saturated viewer, so an
# earlier 420 s budget "timed out" against a model that had actually composed in
# 20 s. That is a POLLING bug, not a slow load (see POLL_MS below) — and the
# measured compose time is ~20 s for the USDZ and ~30 s for the IFC. Keep a wide
# ceiling for a loaded machine, but do not read a timeout as a slow model.
LOAD_TIMEOUT_MS = 300_000


def check(label: str, ok: bool, detail: object = "") -> None:
    global checks
    checks += 1
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{f'  — {detail}' if detail != '' else ''}")
    if not ok:
        failures.append(label)


def free_port(port: int) -> bool:
    # SO_REUSEADDR, or a port in TIME_WAIT from the previous run reads as busy
    # for ~60s — and this guard is the only thing between a stale server and a
    # test that silently verifies the OLD build, so it must not cry wolf.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


@contextlib.contextmanager
def server():
    if not DIST.is_dir():
        raise SystemExit(f"no built SPA at {DIST} — run `npm run build` in app/ first")
    if not free_port(PORT):
        raise SystemExit(f"port {PORT} is busy — a stale server serves old code")
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for the port to START ANSWERING. Re-testing `free_port` here is
        # inverted: it is True while the server is still starting, so the loop
        # would break instantly and hand the test a port with nothing behind it.
        for _ in range(300):
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
        # Kill by PID, and do not swallow a failure: a surviving server holds the
        # port for the NEXT run, which then verifies the old build.
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
    page.on("requestfailed", lambda r: errors.append(f"REQFAIL: {r.url} {r.failure}"))
    return page, errors, requests


# `polling` is NOT optional here. `wait_for_function` defaults to rAF polling,
# and this viewer's render loop saturates the main thread for the whole load —
# so a rAF-based wait NEVER samples, and the symptom is a timeout that reads as
# "the load never completed". Measured here: `page.evaluate` saw 1,454 meshes at
# t+20s while `wait_for_function` with the default polling was still waiting at
# t+900s. The same main-thread starvation is already why `get_by_role` and an
# unforced `click()` time out on this app.
POLL_MS = 1000


def wait_engine(page: Page, global_name: str) -> None:
    """Wait for the engine object, which is assigned at mount (fast)."""
    try:
        page.wait_for_function(
            f"() => !!window.{global_name}", timeout=60_000, polling=POLL_MS
        )
    except Exception:
        raise SystemExit(f"{global_name} never appeared — is the routing branch built?")


def wait_geometry(page: Page, global_name: str) -> int:
    """Wait for real geometry, and FAIL on timeout.

    A wait that falls through reports success with zero meshes, which is how a
    load that produced nothing passes the test written to catch it.
    """
    try:
        page.wait_for_function(
            f"() => {{ const e = window.{global_name}; return e && e.totalCount > 0; }}",
            timeout=LOAD_TIMEOUT_MS,
            polling=POLL_MS,
        )
    except Exception:
        raise SystemExit(f"TIMEOUT waiting for {global_name} geometry — the load never completed")
    return int(page.evaluate(f"() => window.{global_name}.totalCount"))


def wait_section_ready(page: Page, global_name: str) -> None:
    """Wait for the SECTION PLANE to exist, not just for the model.

    `totalCount > 0` is NOT enough. On the IFC side it is `allIds.length`, which
    is populated during `fetchAndConvert` — several steps BEFORE `indexModel()`
    creates the SectionPlane. Probing that gap hits `setSection`'s
    `if (!section) return`, so the plane is never applied and every section
    assertion fails against a viewer that is in fact fine. Measured: the plane was
    still absent (`hasSection: true` on a LATER re-read, `applied: false` on the
    first) while the status line already read "13,543 elements".

    So readiness is the plane itself — the one object this test is about.
    """
    try:
        page.wait_for_function(
            f"() => {{ const e = window.{global_name}; return e && e.sectionForDiag; }}",
            timeout=LOAD_TIMEOUT_MS,
            polling=POLL_MS,
        )
    except Exception:
        raise SystemExit(f"TIMEOUT waiting for {global_name}'s section plane — load never completed")


# ---------------------------------------------------------------- USD probes

# The sign convention, measured against the live plane rather than assumed.
SIGN_PROBE = """() => {
  const e = window.__usdEngine, s = e.sectionForDiag, THREE = e.__threeForRaycast;
  if (!s) return { ok:false, why:'no sectionForDiag' };
  const plane = s.plane;
  // distanceToPoint is affine, so a point exactly on the plane plus one either
  // side of it along the normal must come back strictly ordered.
  const n = plane.normal, c = plane.constant;
  const on = new THREE.Vector3(n.x * -c, n.y * -c, n.z * -c);
  const above = on.clone().addScaledVector(n, 1);
  const below = on.clone().addScaledVector(n, -1);
  return { ok:true,
           onPlane: plane.distanceToPoint(on),
           above: plane.distanceToPoint(above),
           below: plane.distanceToPoint(below) };
}"""

# The claim: one downward ray, filtered and unfiltered, at the same position.
#
# The kept side is `distanceToPoint >= 0` (see `isInsideSection` for the
# derivation from three.js' shader). An earlier version of this probe asserted
# "the unfiltered first hit is above the cut" AND that "the cut changes the
# selection", using the OPPOSITE sign, and both checks passed against a
# buggy picker — because the bug and the assertion agreed with each other. The
# unfiltered first hit then measured `d = -0.11`, i.e. on the visible side.
#
# That is the trap: a sign error in the TEST is indistinguishable from a correct
# test of a buggy implementation, because both are "keep the <= 0 side". The only
# way out is an assertion that is true of the FIX and false of the BUG regardless
# of naming — so this probe reports both sides and asserts the invariant that
# nothing the filter ACCEPTS may lie on the clipped side. Flip the sign in the
# implementation and this fails; flip it here and the test silently stops
# testing anything.
PICK_PROBE = """() => {
  const e = window.__usdEngine, s = e.sectionForDiag, THREE = e.__threeForRaycast;
  if (!s || !s.isApplied) return { ok:false, why:'no section applied' };
  const plane = s.plane, bounds = e.boundsForDiag;
  if (!bounds) return { ok:false, why:'no bounds' };
  const c = bounds.getCenter(new THREE.Vector3());
  // Straight down from above the model, over the house centre.
  const origin = new THREE.Vector3(c.x, bounds.max.y + 5, c.z);
  const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0, 1e6);
  const meshes = e.meshesForDiag || [];
  const all = ray.intersectObjects(meshes, false);
  if (!all.length) return { ok:false, why:'no hits at all', meshes: meshes.length };
  const d = (h) => plane.distanceToPoint(h.point);
  const kept = all.filter(h => d(h) >= 0);
  const path = (h) => h.object.userData?.usdPath || '(unnamed)';
  // Hits on the CLIPPED side — the ones the filter must reject. Kept side is
  // `>= 0`, so this is `< 0`.
  const clipped = all.filter(h => d(h) < 0);
  return { ok:true, meshes: meshes.length, nHits: all.length, nKept: kept.length,
           nClipped: clipped.length,
           planeY: -plane.constant / (plane.normal.y || 1),
           maxY: bounds.max.y, minY: bounds.min.y,
           raw: { path: path(all[0]), y: all[0].point.y, d: d(all[0]) },
           clippedFirst: clipped.length
             ? { path: path(clipped[0]), y: clipped[0].point.y, d: d(clipped[0]) } : null,
           kept: kept.length ? { path: path(kept[0]), y: kept[0].point.y, d: d(kept[0]) } : null,
           // the load-bearing invariant: nothing the filter accepted is clipped away
           minKeptDistance: kept.length ? Math.min(...kept.map(d)) : null,
           // the mirror of it, so a probe that flipped the sign cannot pass
           maxClippedDistance: clipped.length ? Math.max(...clipped.map(d)) : null };
}"""


def run_usd(context) -> None:
    page, errors, requests = new_page(context)
    # `goto`/`reload` on a live page wait for a load event the render loop never
    # fires, hence domcontentloaded rather than the default "load".
    page.goto(f"{BASE}/usd", wait_until="domcontentloaded", timeout=60_000)
    wait_engine(page, "__usdEngine")
    total = wait_geometry(page, "__usdEngine")
    wait_section_ready(page, "__usdEngine")
    check("USD engine mounted on /usd", total > 100, f"totalCount={total}")
    check(
        "a cold /usd load never fetches the IFC",
        not any("/api/model/" in u for u in requests),
        [u for u in requests if "/api/model/" in u] or "none",
    )

    page.evaluate(
        "() => window.__usdEngine.setSection({ enabled:true, axis:'y', offset:0.35, side:'negative' })"
    )
    page.wait_for_timeout(1200)

    state = page.evaluate(
        """() => {
          const e = window.__usdEngine, s = e.sectionForDiag, r = e.rendererForDiag;
          let clipped = 0, materials = 0;
          for (const m of (e.meshesForDiag || [])) {
            const mat = Array.isArray(m.material) ? m.material[0] : m.material;
            if (!mat) continue;
            materials++;
            if (mat.clippingPlanes && mat.clippingPlanes.length) clipped++;
          }
          return { applied: !!(s && s.isApplied), clipped, materials,
                   globalPlanes: r ? r.clippingPlanes.length : -1 };
        }"""
    )
    check("section reports applied", state["applied"], json.dumps(state))
    check(
        "the section reaches the USD materials",
        state["materials"] > 0 and state["clipped"] > 0,
        f"{state['clipped']}/{state['materials']} materials clipped",
    )

    sign = page.evaluate(SIGN_PROBE)
    check("section plane reachable for the sign probe", bool(sign.get("ok")), json.dumps(sign)[:140])
    if sign.get("ok"):
        # distanceToPoint rises along the normal by construction, so this only
        # asserts the probe is coherent — the CLAIM about which half is kept is
        # `kept` below, asserted against a real ray.
        check(
            "plane distance is ordered along the normal",
            sign["above"] > sign["onPlane"] > sign["below"],
            f"above={sign['above']:.2f} on={sign['onPlane']:.2f} below={sign['below']:.2f}",
        )

    pick = page.evaluate(PICK_PROBE)
    check("a downward ray over the house resolved hits", bool(pick.get("ok")), json.dumps(pick)[:200])
    if pick.get("ok"):
        # THE load-bearing invariant. True of the fix, false of the bug, whatever
        # the sign is called: nothing the filter ACCEPTS may be clipped away. An
        # inverted sign puts hits from BOTH sides in here and fails.
        check(
            "NO hit the filter accepts is clipped away",
            pick["minKeptDistance"] is not None and pick["minKeptDistance"] >= 0,
            f"min distance among kept hits = {pick['minKeptDistance']}",
        )
        check(
            "every hit it DID reject is genuinely on the clipped side",
            pick["maxClippedDistance"] is not None and pick["maxClippedDistance"] < 0,
            f"max distance among rejected hits = {pick['maxClippedDistance']}",
        )
        check(
            "the first kept hit is on the visible side",
            pick["kept"] is not None and pick["kept"]["d"] >= 0,
            f"{(pick['kept'] or {}).get('path','')[-40:]} d={(pick['kept'] or {}).get('d')}",
        )
        check(
            "the cut removes at least one candidate hit",
            pick["nKept"] < pick["nHits"],
            f"{pick['nKept']} of {pick['nHits']} hits survive; "
            f"{pick['nClipped']} were on the clipped side",
        )

    # A GRID of rays, not one position. The single point above can legitimately
    # have nothing above the cut; across the house footprint some rays must meet
    # geometry on both sides, and the filter has to behave at all of them. This is
    # the "cast from a grid inside the bounds, not from hand-picked cameras" rule.
    grid = page.evaluate("""() => {
      const e = window.__usdEngine, s = e.sectionForDiag, THREE = e.__threeForRaycast;
      const plane = s.plane, bounds = e.boundsForDiag;
      const d = (h) => plane.distanceToPoint(h.point);
      const meshes = e.meshesForDiag || [];
      let rays = 0, hits = 0, clipped = 0, kept = 0, bothSides = 0;
      let minKept = Infinity, maxClipped = -Infinity;
      const N = 12;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const x = bounds.min.x + (bounds.max.x - bounds.min.x) * (i + 0.5) / N;
        const z = bounds.min.z + (bounds.max.z - bounds.min.z) * (j + 0.5) / N;
        rays++;
        const ray = new THREE.Raycaster(
          new THREE.Vector3(x, bounds.max.y + 5, z), new THREE.Vector3(0, -1, 0), 0, 1e6);
        const all = ray.intersectObjects(meshes, false);
        if (!all.length) continue;
        hits++;
        // Kept side is `>= 0`; rejected is `< 0`. See `isInsideSection`.
        const k = all.filter(h => d(h) >= 0);
        const c = all.filter(h => d(h) < 0);
        clipped += c.length; kept += k.length;
        if (c.length > 0 && k.length > 0) bothSides++;
        for (const h of k) minKept = Math.min(minKept, d(h));
        for (const h of c) maxClipped = Math.max(maxClipped, d(h));
      }
      const r = (v) => v === Infinity || v === -Infinity ? null : +v.toFixed(4);
      return { rays, hits, clipped, kept, bothSides,
               minKept: r(minKept), maxClipped: r(maxClipped) };
    }""")
    check("the grid cast rays that actually meet geometry", grid["hits"] > 10, json.dumps(grid))
    check(
        "across the grid, NO accepted hit is clipped away",
        grid["minKept"] is not None and grid["minKept"] >= 0,
        f"min distance among {grid['kept']} kept hits = {grid['minKept']}",
    )
    check(
        "across the grid, every rejected hit really is clipped away",
        grid["maxClipped"] is None or grid["maxClipped"] < 0,
        f"max distance among {grid['clipped']} rejected hits = {grid['maxClipped']}",
    )
    check(
        "across the grid, the cut rejects a substantial number of hits",
        grid["clipped"] > 0,
        f"{grid['clipped']} rejected of {grid['clipped'] + grid['kept']}",
    )
    check(
        "some rays meet geometry on BOTH sides (the filter is doing work)",
        grid["bothSides"] > 0,
        f"{grid['bothSides']} of {grid['hits']} hitting rays straddle the cut",
    )

    # ------------------------------------------------------------------
    # END TO END, through the real click handler.
    #
    # Everything above tests the FILTER by calling the same predicate. That is
    # necessary but not sufficient: `pointerup` still had to pick `hits[0]`, and a
    # correct filter wired to an incorrect caller still selects the roof. So
    # synthesise real pointer events at a screen point where geometry exists on
    # BOTH sides of the cut, and assert on what the app actually reports.
    #
    # This is the claim as the user states it: with a section showing the ground
    # floor, clicking from above must not return the roof.
    # ------------------------------------------------------------------
    screen = page.evaluate("""() => {
      const e = window.__usdEngine, s = e.sectionForDiag, THREE = e.__threeForRaycast;
      const plane = s.plane, bounds = e.boundsForDiag, cam = e.__cameraForDiag;
      const meshes = e.meshesForDiag || [];
      const el = e.rendererForDiag.domElement;
      const rect = el.getBoundingClientRect();
      const d = (h) => plane.distanceToPoint(h.point);
      // Project a grid of candidate ray origins to screen space and keep the
      // ones whose vertical ray meets BOTH sides of the cut — that is the only
      // situation in which the section changes the answer.
      const found = [];
      for (let i = 0; i < 14 && found.length < 3; i++) {
        for (let j = 0; j < 14 && found.length < 3; j++) {
          const x = bounds.min.x + (bounds.max.x - bounds.min.x) * (i + 0.5) / 14;
          const z = bounds.min.z + (bounds.max.z - bounds.min.z) * (j + 0.5) / 14;
          const origin = new THREE.Vector3(x, bounds.max.y + 5, z);
          const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0, 1e6);
          const all = ray.intersectObjects(meshes, false);
          if (!all.length) continue;
          const k = all.filter(h => d(h) >= 0), c = all.filter(h => d(h) < 0);
          if (!k.length || !c.length) continue;
          const p = origin.clone().project(cam);
          if (Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95) continue;
          found.push({
            clientX: rect.left + (p.x * 0.5 + 0.5) * rect.width,
            clientY: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
            onScreen: true,
            nKept: k.length, nClipped: c.length,
            firstKept: (k[0].object.userData && k[0].object.userData.usdPath) || '(unnamed)',
          });
        }
      }
      return { found, rect: { w: rect.width, h: rect.height } };
    }""")
    check(
        "found screen points where the cut changes the answer",
        len(screen.get("found", [])) > 0,
        f"{len(screen.get('found', []))} candidate(s)",
    )

    for n, spot in enumerate(screen.get("found", [])[:2]):
        # `pointerdown` then `pointerup` at the same spot: the handler ignores a
        # drag, and a bare `pointerup` with no preceding `pointerdown` leaves the
        # drag-suppression state undefined.
        page.evaluate(
            """([x, y]) => {
              const el = window.__usdEngine.rendererForDiag.domElement;
              const opts = { clientX: x, clientY: y, bubbles: true, button: 0, pointerId: 1 };
              el.dispatchEvent(new PointerEvent('pointerdown', opts));
              el.dispatchEvent(new PointerEvent('pointerup', opts));
            }""",
            [spot["clientX"], spot["clientY"]],
        )
        page.wait_for_timeout(600)
        # Read the ENGINE's own field as well as the store's. The store is set to
        # `null` on a miss, so it cannot distinguish "handler ran and found
        # nothing" from "the event never reached the handler" — and those need
        # different fixes.
        sel = page.evaluate(
            """() => {
              const st = window.__usdStore.getState();
              const s = st.selection;
              const e = window.__usdEngine.lastSelectionForDiag;
              return {
                store: s ? { path: s.path ?? '', name: s.name ?? '' } : null,
                engine: e ? { path: e.path ?? '', name: e.name ?? '' } : null,
              };
            }"""
        )
        picked = sel["engine"] or sel["store"]
        check(
            f"click #{n + 1} at a straddling point reached the pick handler",
            sel["engine"] is not None or sel["store"] is not None,
            f"engine={json.dumps(sel['engine'])[:80]} store={json.dumps(sel['store'])[:80]}",
        )
        check(
            f"click #{n + 1} selected something",
            picked is not None,
            json.dumps(picked)[:120] if picked else "nothing selected",
        )
        if picked:
            check(
                f"click #{n + 1} did NOT select geometry the cut removed",
                # With the section keeping `d >= 0`, a selected prim must be one
                # of the kept candidates, not one of the clipped ones.
                picked["path"] == spot["firstKept"] or spot["nClipped"] == 0,
                f"selected={picked['path'][-60:]} expected-kept={spot['firstKept'][-60:]}",
            )

    page.evaluate(
        "() => window.__usdEngine.setSection({ enabled:false, axis:'y', offset:0.5, side:'negative' })"
    )
    page.wait_for_timeout(800)
    off = page.evaluate(
        """() => { const e = window.__usdEngine, s = e.sectionForDiag, r = e.rendererForDiag;
                   return { applied: !!(s && s.isApplied),
                            globalPlanes: r ? r.clippingPlanes.length : -1 }; }"""
    )
    check("turning the section off leaves no clipping", off["applied"] is False, json.dumps(off))
    check("no console errors on /usd", not errors, "; ".join(errors[:3])[:200])
    page.close()


# ---------------------------------------------------------------- IFC probes

IFC_STATE = """() => {
  const e = window.__bimEngine, r = e.rendererForDiag;
  return { planes: r ? r.clippingPlanes.length : -1,
           compPlanes: e.componentPlanesForDiag,
           triangles: r ? r.info.render.triangles : -1 };
}"""


def settle_triangles(page: Page, tries: int = 20) -> int:
    """A SETTLED uncut triangle count, not whatever the first frame happened to be.

    Read straight after load, `info.render.triangles` is 0 — the counter belongs
    to the last completed frame and the fragments conversion is still landing
    tiles. That reads as "0 -> 194185 triangles" and passes the delta check for
    the wrong reason, and it makes "the section is off again" unprovable (0 never
    comes back). So wait for the counter to be non-zero and STABLE across two
    samples before using it as a baseline.
    """
    last = -1
    for _ in range(tries):
        page.wait_for_timeout(1000)
        n = int(page.evaluate("() => window.__bimEngine.rendererForDiag.info.render.triangles"))
        if n > 0 and n == last:
            return n
        last = n
    return last


def run_ifc(context) -> None:
    page, errors, requests = new_page(context)
    page.goto(f"{BASE}/ifc", wait_until="domcontentloaded", timeout=60_000)
    wait_engine(page, "__bimEngine")
    total = wait_geometry(page, "__bimEngine")
    # `totalCount` goes positive before the SectionPlane exists, so gate on the
    # plane — otherwise `setSection` silently returns and every assertion below
    # fails against a viewer that is actually fine.
    wait_section_ready(page, "__bimEngine")
    check("IFC engine mounted on /ifc", total > 1000, f"totalCount={total}")
    check(
        "a cold /ifc load never fetches the USD",
        not any("/api/usd/" in u for u in requests),
        [u for u in requests if "/api/usd/" in u] or "none",
    )

    baseline_triangles = settle_triangles(page)
    before = page.evaluate(IFC_STATE)
    check(
        "the IFC renderer's clipping registry starts EMPTY",
        before["planes"] == 0 and before["compPlanes"] == 0,
        json.dumps(before),
    )
    check(
        "and the uncut triangle count has settled to a real baseline",
        baseline_triangles > 0,
        f"{baseline_triangles} triangles",
    )

    page.evaluate(
        "() => window.__bimEngine.setSection({ enabled:true, axis:'y', offset:0.35, side:'negative' })"
    )
    page.wait_for_timeout(3000)
    after = page.evaluate(IFC_STATE)
    check(
        "the section plane REACHES renderer.three.clippingPlanes (what the picker reads)",
        after["planes"] >= 1,
        json.dumps(after),
    )
    check(
        "and the component-side registry agrees it was registered",
        after["compPlanes"] >= 1,
        f"component clippingPlanes = {after['compPlanes']}",
    )
    # The fragments renderer cuts on the CPU, so its triangle count MUST respond.
    # A section that reports enabled while the count is frozen is not cutting.
    check(
        "the fragments CPU clip still measurably cuts",
        after["triangles"] != before["triangles"],
        f"{before['triangles']} -> {after['triangles']} triangles",
    )

    page.evaluate(
        "() => window.__bimEngine.setSection({ enabled:false, axis:'y', offset:0.5, side:'negative' })"
    )
    # Settle before reading, for the same reason as the baseline: `info.render` is
    # a PER-FRAME counter, so 2 s after the change it can still hold the previous
    # frame's value (measured: 159557 — the cut count — read straight after
    # switching the section off). Comparing that against the baseline fails
    # against a viewer that has in fact already redrawn.
    restored = settle_triangles(page)
    cleared = page.evaluate(IFC_STATE)
    check(
        "turning the section off empties BOTH registries",
        cleared["planes"] == 0 and cleared["compPlanes"] == 0,
        f"three={cleared['planes']} component={cleared['compPlanes']}",
    )
    check(
        "and restores the uncut triangle count",
        restored == baseline_triangles,
        f"{baseline_triangles} -> {restored}",
    )
    check("no console errors on /ifc", not errors, "; ".join(errors[:3])[:200])
    page.close()


def main() -> None:
    with server(), sync_playwright() as play:
        browser = play.chromium.launch(
            args=[
                "--enable-unsafe-swiftshader",
                "--use-gl=angle",
                "--use-angle=swiftshader",
            ]
        )
        context = browser.new_context()
        try:
            # USD first, then close its page BEFORE opening the next: two pages
            # each running a swiftshader render loop starve each other in this
            # container, and the second load never completes.
            print("\n=== USD: the section must govern what a click selects ===")
            run_usd(context)
            print("\n=== IFC: the section plane must reach the picker's registry ===")
            run_ifc(context)
        finally:
            browser.close()

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("FAILED:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
