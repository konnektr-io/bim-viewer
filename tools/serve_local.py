"""Throwaway local server: the built SPA + the real IFC and USD artifacts.

Mirrors the DEPLOYED endpoints so the frontend is exercised against reality, and
so the SPA fallback can be tested too — the deployed app answers `/ifc` and `/usd`
with the SPA shell from its catch-all route, and that is exactly the path these
tests need to prove works.

Serves BOTH models, which the old `serve_usd_local.py` did not: a cold load of
/usd must never fetch the IFC, and only a server that HAS the IFC can prove that.
"""
import gzip
import http.server
import json
import pathlib
import socketserver

DIST = pathlib.Path(__file__).resolve().parents[1] / "app" / "dist"
USD = pathlib.Path("/opt/data/work/usd-web")
IFC = pathlib.Path("/opt/data/work/ifc/Achterhekers57.ifc")
SLUG = "Achterhekers57.ifc"
PORT = 8097

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
        print("  %s" % (format % args), flush=True)

    def _bytes(self, body: bytes, ctype: str, encoding: str | None = None) -> None:
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        if encoding:
            self.send_header("content-encoding", encoding)
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
            body = json.dumps({"modelSlug": SLUG, "modelTitle": "Achterhekers 57"}).encode()
            return self._bytes(body, "application/json")

        if path == "/api/usd/manifest":
            manifest = USD / "manifest.json"
            if not manifest.is_file():
                return self.send_error(503, "usd scene not built")
            return self._file(manifest, "application/json")

        if path in ("/api/usd/scene", "/api/usd/scene.usdz"):
            manifest_path = USD / "manifest.json"
            if not manifest_path.is_file():
                return self.send_error(503, "usd scene not built")
            manifest = json.loads(manifest_path.read_text())
            key = "packageFile" if path.endswith(".usdz") else "file"
            name = manifest.get(key) or manifest.get("file")
            scene = USD / name
            if not scene.is_file():
                return self.send_error(503, f"missing {scene}")
            # Serve the .gz AS-IS with content-encoding: gzip, exactly as the
            # FastAPI app does. Decompressing here while keeping the header
            # makes the browser fail with ERR_CONTENT_DECODING_FAILED.
            if scene.suffix == ".gz":
                return self._bytes(scene.read_bytes(), "text/plain", encoding="gzip")
            # The USDZ must go out UNCOMPRESSED: the loader's first check is
            # `bytes[0]===0x50 && bytes[1]===0x4B`, and a gzipped body fails it.
            return self._bytes(scene.read_bytes(), "application/octet-stream")

        if path.startswith("/api/model/"):
            return self._file(IFC, "application/x-step")

        # Static file if it exists, else the SPA shell — the deployed catch-all
        # in main.py, verbatim. This is what makes /ifc and /usd work at all.
        rel = path.lstrip("/") or "index.html"
        candidate = (DIST / rel).resolve()
        if candidate.is_file() and DIST.resolve() in candidate.parents:
            return self._file(candidate)
        return self._file(DIST / "index.html", "text/html")


if __name__ == "__main__":
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.daemon_threads = True
        print(f"serving {DIST} on http://127.0.0.1:{PORT}", flush=True)
        httpd.serve_forever()
