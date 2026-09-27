"""BIM viewer backend — serves the built SPA and proxies the model out of Garage.

Deliberately small and boring, like kiseki / ontomanager: one FastAPI process
that serves the React app from ``app/static`` and streams the model from S3.

Two deliberate choices:

* **The S3 key never reaches the browser.** The SPA fetches the model from this
  origin and this process signs the S3 request. That also means no CORS
  configuration and no signed-URL flow.
* **SigV4 is hand-rolled** over ``hashlib``/``hmac``. A single-object GET needs
  no payload signing, and the AWS SDK is a large dependency for one file.

Credentials come from the environment (populated from the ``bim-hermes-s3``
Secret at runtime) and are never baked into the image.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import os
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("bim-viewer")

HERE = Path(__file__).resolve().parent
STATIC_DIR = Path(os.environ.get("STATIC_DIR", HERE / "static"))

# The model is named entirely by configuration. Nothing about which building
# this is — not the S3 key, not the URL, not the title — is baked into the
# code, so the image is reusable for any project.
#
#   S3_MODEL_KEY   key in the bucket          (required)
#   MODEL_SLUG     filename the client uses   (required)
#   MODEL_TITLE    display name in the UI     (optional)
#
# The route is deliberately fixed at /api/model/{slug}: the slug comes from the
# request path, so the browser never hardcodes a filename either.
UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

DEFAULT_TITLE = "BIM model"

app = FastAPI(title="bim-viewer", docs_url=None, redoc_url=None)


# --------------------------------------------------------------------------
# S3 (SigV4, path-style — Garage is behind a single hostname, so a
# virtual-host URL 404s)
# --------------------------------------------------------------------------
class S3Config:
    def __init__(self) -> None:
        self.endpoint = _required("S3_ENDPOINT")
        self.region = os.environ.get("S3_REGION", "us-east-1")
        self.bucket = _required("S3_BUCKET")
        self.access_key = _required("S3_ACCESS_KEY")
        self.secret_key = _required("S3_SECRET_KEY")

        parsed = httpx.URL(self.endpoint)
        self.host = parsed.host
        self.scheme = parsed.scheme or "https"
        if not self.host:
            raise RuntimeError(f"S3_ENDPOINT has no host: {self.endpoint!r}")

    @property
    def secure(self) -> bool:
        return self.scheme == "https"


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required env var {name}")
    return value


def _sign_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    key = f"AWS4{secret}".encode()
    for part in (date_stamp, region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    return key


def sign_get(config: S3Config, *, method: str, key: str, now: dt.datetime, byte_range: str | None) -> dict:
    """Return {url, headers} for a signed S3 request.

    The signed verb is returned in the headers and reused verbatim by the
    caller: SigV4 covers the method, so signing HEAD and sending GET is a
    SignatureDoesNotMatch.
    """
    # Path-style: /<bucket>/<key> with each segment percent-encoded.
    canonical_uri = "/" + "/".join(quote(part, safe="") for part in f"{config.bucket}/{key}".split("/"))

    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    headers = {
        "host": config.host,
        "x-amz-content-sha256": UNSIGNED_PAYLOAD,
        "x-amz-date": amz_date,
    }
    if byte_range:
        headers["range"] = byte_range

    signed_names = sorted(headers)
    canonical_headers = "".join(f"{n}:{headers[n]}\n" for n in signed_names)
    signed_headers = ";".join(signed_names)

    canonical_request = "\n".join(
        [method, canonical_uri, "", canonical_headers, signed_headers, UNSIGNED_PAYLOAD]
    )
    scope = f"{date_stamp}/{config.region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signing_key = _sign_key(config.secret_key, date_stamp, config.region, "s3")
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()

    request_headers = {
        **headers,
        "authorization": (
            f"AWS4-HMAC-SHA256 Credential={config.access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }
    port = "" if (config.secure and config.host.count(":") == 0) else ""
    return {
        "url": f"{config.scheme}://{config.host}{port}{canonical_uri}",
        "headers": request_headers,
    }


_s3: S3Config | None = None


def get_s3() -> S3Config:
    """Built lazily so the process starts (and /healthz answers) without S3."""
    global _s3
    if _s3 is None:
        _s3 = S3Config()
    return _s3


@app.get("/healthz")
def healthz() -> Response:
    return Response("ok", media_type="text/plain")


@app.get("/api/config")
def client_config() -> dict[str, str]:
    """What the SPA needs to know: the model slug to fetch and how to label it.

    Served from configuration so the frontend contains no project name at all.
    """
    return {
        "modelSlug": os.environ.get("MODEL_SLUG", "model.ifc"),
        "modelTitle": os.environ.get("MODEL_TITLE", DEFAULT_TITLE),
    }


@app.api_route("/api/model/{slug}", methods=["GET", "HEAD"])
async def stream_model(request: Request, slug: str) -> Response:
    """Stream the model from Garage straight through to the browser.

    Range and the ETag/Last-Modified validators are forwarded so the client can
    revalidate a large download instead of pulling it again.
    """
    try:
        config = get_s3()
    except RuntimeError as exc:
        log.error("S3 not configured: %s", exc)
        raise HTTPException(status_code=503, detail="storage not configured") from exc

    model_key = os.environ.get("S3_MODEL_KEY")
    if not model_key:
        log.error("S3_MODEL_KEY is not set")
        raise HTTPException(status_code=503, detail="model not configured")

    method = "HEAD" if request.method == "HEAD" else "GET"
    byte_range = request.headers.get("range")
    signed = sign_get(
        config, method=method, key=model_key, now=dt.datetime.now(dt.timezone.utc), byte_range=byte_range
    )

    # The client deliberately outlives this handler: StreamingResponse consumes
    # the body after the endpoint returns, so a `with` block here would close
    # the connection first. It is closed in the generator's finally.
    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0), follow_redirects=True)
    try:
        upstream_request = client.build_request(method, signed["url"], headers=signed["headers"])
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        log.error("S3 request failed: %s", exc)
        raise HTTPException(status_code=502, detail="storage unreachable") from exc

    # Never swallow a non-2xx: a signing or addressing regression otherwise
    # looks exactly like an outage.
    if upstream.status_code not in (200, 206):
        detail = await upstream.aread()
        await upstream.aclose()
        await client.aclose()
        log.error("S3 %s %s -> %s: %s", method, MODEL_KEY, upstream.status_code, detail[:200])
        raise HTTPException(
            status_code=404 if upstream.status_code == 404 else 502,
            detail="model not found" if upstream.status_code == 404 else "storage error",
        )

    out_headers = {
        "content-type": "application/x-step",
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=3600, must-revalidate",
    }
    for header in ("content-length", "content-range", "etag", "last-modified"):
        if header in upstream.headers:
            out_headers[header] = upstream.headers[header]

    if method == "HEAD":
        await upstream.aclose()
        await client.aclose()
        return Response(status_code=200, headers=out_headers)

    async def stream_body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    # Pass the async generator OBJECT, not the function. Starlette sniffs with
    # `isinstance(content, AsyncIterable)`, and a function object is not an
    # AsyncIterable — given the function it falls back to iterate_in_threadpool
    # and dies with "'function' object is not iterable".
    return StreamingResponse(
        stream_body(), status_code=upstream.status_code, headers=out_headers
    )


# --------------------------------------------------------------------------
# SPA — the built React app. Mounted at the end so it never shadows /api.
# --------------------------------------------------------------------------
if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
    app.mount("/wasm", StaticFiles(directory=STATIC_DIR / "wasm"), name="wasm")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> Response:
        """Serve a real file if it exists, otherwise the SPA shell."""
        # Resolve first, then confirm the result is inside the static root.
        # Checking the *unresolved* path is not enough: ".../static/../../etc"
        # only reveals itself after resolution.
        root = STATIC_DIR.resolve()
        candidate = (root / full_path).resolve()
        if candidate.is_file() and (candidate == root or root in candidate.parents):
            return FileResponse(candidate)

        index = STATIC_DIR / "index.html"
        if not index.is_file():
            return HTMLResponse(
                "<h1>Frontend not built</h1>"
                "<p>Run the frontend build; app/static/index.html is missing.</p>",
                status_code=503,
            )
        return FileResponse(index)
