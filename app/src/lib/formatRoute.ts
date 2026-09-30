/**
 * Deep links: `/ifc` and `/usd` open that format directly.
 *
 * WHY A PATH AND NOT A QUERY
 * -------------------------
 * `/ifc` and `/usd` are shareable, bookmarkable and hand-typable. A `?format=`
 * would work identically and cost nothing extra — the path was chosen because
 * the viewer has exactly two top-level views and no nesting, so a path reads as
 * the thing it is.
 *
 * The backend already answers any unknown path with the SPA shell
 * (`app/main.py`'s catch-all), so no server change is needed to serve these —
 * only the app has to read them. That fallback returns HTTP 200 with HTML, so a
 * route check must assert on the BODY (the `#root` shell), never on the status.
 */
import type { Format } from "@/viewer/types";

/** The canonical path for each format, and nothing else. */
const PATHS: Record<Format, string> = { ifc: "/ifc", usd: "/usd" };

/**
 * The format a path names, or null when it names none.
 *
 * Tolerant of a trailing slash and of case, because both arrive from real use:
 * a pasted URL and a hand-typed one.
 */
export function formatFromPath(pathname: string): Format | null {
  const clean = pathname.replace(/\/+$/, "").toLowerCase();
  if (clean === PATHS.ifc) return "ifc";
  if (clean === PATHS.usd) return "usd";
  return null;
}

export function pathForFormat(format: Format): string {
  return PATHS[format];
}

/**
 * The format a COLD load should open: whatever the path names, else IFC.
 *
 * IFC stays the default for `/` and for any unknown path, so every existing
 * link — including the bare hostname — behaves exactly as before.
 */
export function initialFormat(
  pathname: string = typeof window === "undefined" ? "/" : window.location.pathname,
): Format {
  return formatFromPath(pathname) ?? "ifc";
}

/**
 * Point the address bar at `format`, adding a history entry.
 *
 * A history entry (not a replacement) is what makes the tab switch behave like
 * the browser's own: Back returns to the view you were looking at, and the
 * `popstate` listener in `main.tsx` restores it. Re-selecting the format
 * already shown is not a navigation and must not add an entry — otherwise
 * mashing the active tab fills the history with duplicates.
 */
export function syncUrl(format: Format): void {
  if (typeof window === "undefined") return;
  const next = pathForFormat(format);
  if (window.location.pathname === next) return;
  window.history.pushState({ format }, "", next);
}
