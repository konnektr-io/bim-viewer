"""Throwaway stub server: the built SPA + empty /api responses, NO model bytes.

This is the fast harness. `serve_both_local.py` serves the real 17.7 MB IFC and
the real 64 MB USDZ, which is the only way to prove a LOAD works and the wrong
way to prove ROUTING and PANEL BEHAVIOUR works.

Both claims under test here — which engine gets constructed, and whether a folded
panel stays folded — are decided before any model has arrived:

- the format is seeded from the URL at store construction, so the engine
  decision has already been made when the effect mounts;
- the panel fold is read from localStorage at mount.

So neither needs the compose. Serve small stubs, assert the app's own state, and
spend the multi-minute model load once, on the check that actually needs it.
"""
import http.server
import json
import pathlib
import socketserver
import sys

DIST = pathlib.Path(__file__).resolve().parents[1] / "app" / "dist"
# Port is an ARGUMENT, not a constant. A fixed port in a throwaway harness means
# every run after a crash aborts with "address already in use" against a
# listener nobody owns; letting the caller pick a free one removes the class of
# failure entirely.
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8096

# A manifest with the right SHAPE. The counts are deliberately small: nothing
# here composes a model, so a big number would only be a false promise.
MANIFEST = {
    "file": "stub.usda.gz",
    "packageFile": "stub.usdz",
    "meshCount": 0,
    "layers": [],
    "storeys": [],
    "categories": [],
}

# A 4-byte PK zip header is enough: the USD loader checks the first two bytes and
# then fails on parse, which is fine — the USD *routing* claims are about which
# engine mounts and which requests go out, not about geometry.
STUB_USDZ = b"PK\x03\x04" + b"\x00" * 64

CONTENT_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".json": "application/json",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002
        pass

    def _bytes(self, body: bytes, ctype: str) -> None:
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: pathlib.Path, content_type: str | None = None) -> None:
        if not path.is_file():
            return self.send_error(404, f"missing {path}")
        self._bytes(
            path.read_bytes(),
            content_type or CONTENT_TYPES.get(path.suffix, "application/octet-stream"),
        )

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]

        if path == "/api/config":
            return self._bytes(
                json.dumps({"modelSlug": "stub.ifc", "modelTitle": "Stub model"}).encode(),
                "application/json",
            )

        if path == "/api/usd/manifest":
            return self._bytes(json.dumps(MANIFEST).encode(), "application/json")

        if path == "/api/usd/scene.usdz":
            return self._bytes(STUB_USDZ, "application/octet-stream")

        # The IFC route 404s on purpose, and the absence of any `/api/model/`
        # request is itself an assertion below. A 200 here would let a broken
        # deep link pass unnoticed.
        if path.startswith("/api/model/"):
            return self.send_error(404, "no model on the stub server")

        rel = path.lstrip("/") or "index.html"
        candidate = (DIST / rel).resolve()
        if candidate.is_file() and DIST.resolve() in candidate.parents:
            return self._file(candidate)
        return self._file(DIST / "index.html", "text/html")


if __name__ == "__main__":
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.daemon_threads = True
        print(f"serving STUB {DIST} on http://127.0.0.1:{PORT}", flush=True)
        httpd.serve_forever()
