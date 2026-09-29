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
import json
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


# --------------------------------------------------------------------------
# USD — the flattened layer stack, proxied from S3
# --------------------------------------------------------------------------
# WHY IT IS PROXIED AND NOT BAKED INTO THE IMAGE
# ----------------------------------------------
# three.js `USDLoader` cannot open a layer stack at all: for a standalone file it
# calls `composer.compose(data, {}, {}, path)` with an EMPTY assets dict, so
# `_resolveReference` can only ever return null, and no parser in the package
# reads `subLayers`. The house stack is 5 subLayers deep plus a reference, so the
# loader renders nothing. The build step (`cad/build_web_usd.py`) flattens the
# whole stack into one self-contained ASCII layer, and THAT is what is fetched
# here — the same arrangement as the IFC, so no S3 key ever reaches the browser
# and no derived geometry is baked into an image.
#
# WHY A USDZ PACKAGE AND NOT THE PLAIN FLATTEN
# --------------------------------------------
# `USDLoader` populates its `assets` map ONLY from a `.usdz` package. On a
# standalone ASCII layer it composes with an empty assets dict, so
# `USDComposer._loadTexture` finds nothing and every `UsdUVTexture` silently
# falls back to a flat scalar colour. The package
# (`cad/package_web_usdz.py`, manifest key `packageFile`) carries the flattened
# layer FIRST plus its PNGs, so the shower-head PBR maps actually reach the
# browser. The plain gzipped flatten stays available at `/api/usd/scene` as the
# revertible fallback.
#
# ASCII and not .usdc on purpose: `USDCParser._readInlinedValue` has no case for
# the `double` vector variants, so a `double3` decodes as a raw uint32 (142 of
# 1378 xformOp:translate attributes on this model) and `applyTransform` throws.
# The ASCII parser decodes them correctly. This still applies to the packaged
# root layer, which is the same ASCII flatten. The package itself is served
# UNCOMPRESSED (`application/octet-stream`, never gzip): the loader's first
# check is `bytes[0]===0x50 && bytes[1]===0x4B`, and a gzipped body fails it
# and silently falls through to the ASCII path.
#
#   S3_USD_PREFIX  key prefix holding the flattened scene   (optional)
#
# Without it, or with the object absent, the USD endpoints return 503 and the
# frontend says so plainly; the IFC tab is unaffected.
USD_PREFIX = os.environ.get("S3_USD_PREFIX", "").strip("/")


async def _s3_get_bytes(key: str, timeout: float = 30.0) -> bytes:
    """Fetch a small object out of the bucket and return its bytes.

    Used for the manifest, which the scene endpoint needs in order to learn the
    flattened file's name. Same hand-rolled SigV4 and path-style addressing as
    the IFC proxy: Garage is behind one hostname, so a virtual-host URL 404s.
    """
    try:
        config = get_s3()
    except RuntimeError as exc:
        log.error("S3 not configured: %s", exc)
        raise HTTPException(status_code=503, detail="storage not configured") from exc

    signed = sign_get(
        config, method="GET", key=key, now=dt.datetime.now(dt.timezone.utc), byte_range=None
    )
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout), follow_redirects=True) as client:
        try:
            response = await client.get(signed["url"], headers=signed["headers"])
        except httpx.HTTPError as exc:
            log.error("S3 GET %s failed: %s", key, exc)
            raise HTTPException(status_code=502, detail="storage unreachable") from exc

    # Never swallow a non-200: a signing or addressing regression otherwise looks
    # exactly like "the scene was never built".
    if response.status_code != 200:
        log.error("S3 GET %s -> %s: %s", key, response.status_code, response.content[:200])
        raise HTTPException(
            status_code=404 if response.status_code == 404 else 502,
            detail="usd scene not built" if response.status_code == 404 else "storage error",
        )
    return response.content


async def _s3_stream(key: str) -> Response:
    """Proxy one object straight through to the browser.

    The body is served EXACTLY as stored. A `.gz` object keeps its bytes and
    gains `content-encoding: gzip`, which the browser inflates once; inflating it
    here while keeping that header is what makes every fetch fail with
    ERR_CONTENT_DECODING_FAILED, which surfaces only as "Failed to fetch".
    """
    try:
        config = get_s3()
    except RuntimeError as exc:
        log.error("S3 not configured: %s", exc)
        raise HTTPException(status_code=503, detail="storage not configured") from exc

    signed = sign_get(
        config, method="GET", key=key, now=dt.datetime.now(dt.timezone.utc), byte_range=None
    )
    # The client deliberately outlives this handler: StreamingResponse consumes
    # the body after the endpoint returns, so a `with` block would close the
    # connection first. It is closed in the generator's finally.
    client = httpx.AsyncClient(timeout=httpx.Timeout(120.0), follow_redirects=True)
    try:
        upstream_request = client.build_request("GET", signed["url"], headers=signed["headers"])
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        log.error("S3 request failed for %s: %s", key, exc)
        raise HTTPException(status_code=502, detail="storage unreachable") from exc

    if upstream.status_code != 200:
        detail = await upstream.aread()
        await upstream.aclose()
        await client.aclose()
        log.error("S3 GET %s -> %s: %s", key, upstream.status_code, detail[:200])
        raise HTTPException(
            status_code=404 if upstream.status_code == 404 else 502,
            detail="usd scene not found" if upstream.status_code == 404 else "storage error",
        )

    out_headers: dict[str, str] = {
        "cache-control": "public, max-age=3600, must-revalidate",
    }
    if key.endswith(".usdz"):
        # The package must arrive byte-identical: the loader's first check is
        # bytes[0]===0x50 && bytes[1]===0x4B, and any content-encoding fails it
        # and silently falls through to the ASCII path.
        out_headers["content-type"] = "application/octet-stream"
    else:
        out_headers["content-type"] = "text/plain"
        if key.endswith(".gz"):
            out_headers["content-encoding"] = "gzip"
    for header in ("content-length", "etag", "last-modified"):
        if header in upstream.headers:
            out_headers[header] = upstream.headers[header]

    async def stream_body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    # Pass the async generator OBJECT, never the function. Starlette sniffs with
    # isinstance(content, AsyncIterable), and a function object is not an
    # AsyncIterable — given the function it falls back to iterate_in_threadpool
    # and dies with "'function' object is not iterable".
    return StreamingResponse(stream_body(), status_code=200, headers=out_headers)


def _usd_key(*parts: str) -> str:
    if not USD_PREFIX:
        raise HTTPException(status_code=503, detail="usd scene not configured")
    return "/".join([USD_PREFIX, *parts])


async def _usd_manifest_json() -> dict:
    """The manifest, parsed and checked.

    Parsing here rather than in the browser is deliberate: a manifest that does
    not parse would otherwise surface as a silently blank USD tab, and a missing
    `file` key would only fail on the NEXT request.
    """
    try:
        return json.loads(await _s3_get_bytes(_usd_key("manifest.json")))
    except json.JSONDecodeError as exc:
        log.error("USD manifest is not valid JSON: %s", exc)
        raise HTTPException(status_code=503, detail="usd manifest broken") from exc


@app.get("/api/usd/manifest")
async def usd_manifest() -> Response:
    """The layer / storey / category index for the USD view.

    Produced at build time by pxr, which is the only place the sublayer structure
    is still known — after flattening, a root prim is just a name, so the browser
    cannot derive these groups for itself.
    """
    body = await _s3_get_bytes(_usd_key("manifest.json"))
    try:
        json.loads(body)
    except json.JSONDecodeError as exc:
        log.error("USD manifest is not valid JSON: %s", exc)
        raise HTTPException(status_code=503, detail="usd manifest broken") from exc
    return Response(
        content=body,
        media_type="application/json",
        headers={"cache-control": "public, max-age=300, must-revalidate"},
    )


@app.get("/api/usd/scene")
async def usd_scene() -> Response:
    """Stream the flattened, gzipped USD layer.

    The file name comes from the manifest rather than from configuration, so a
    rebuild that renames the flattened layer needs no redeploy.
    """
    manifest = await _usd_manifest_json()
    name = manifest.get("file")
    if not isinstance(name, str) or not name:
        log.error("USD manifest has no usable `file` key")
        raise HTTPException(status_code=503, detail="usd manifest broken")
    return await _s3_stream(_usd_key(name))


@app.get("/api/usd/scene.usdz")
async def usd_scene_package() -> Response:
    """Stream the USDZ package (flattened layer + textures).

    Additive alongside `/api/usd/scene`, which stays as the revertible
    fallback. The file name comes from the manifest's `packageFile`, falling
    back to `file` if a rebuild has not packaged yet. Served uncompressed as
    `application/octet-stream` — never gzip — so the loader's PK-magic check
    sees the real zip bytes.
    """
    manifest = await _usd_manifest_json()
    name = manifest.get("packageFile") or manifest.get("file")
    if not isinstance(name, str) or not name:
        log.error("USD manifest has no usable `packageFile`/`file` key")
        raise HTTPException(status_code=503, detail="usd manifest broken")
    return await _s3_stream(_usd_key(name))


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
        log.error("S3 %s %s -> %s: %s", method, model_key, upstream.status_code, detail[:200])
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
