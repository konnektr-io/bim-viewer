# ---- Stage 1: build the React SPA ----
FROM node:22-slim AS frontend
WORKDIR /build
# Manifests first, so the dependency layer caches independently of source edits.
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
# `npm run build` is `tsc -b && vite build`: the typecheck is the test.
RUN npm run build

# ---- Stage 2: Python runtime ----
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    STATIC_DIR=/srv/static

WORKDIR /srv

COPY app/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && rm -rf /root/.cache/pip

COPY app/main.py ./main.py

# Built SPA -> served by FastAPI from /srv/static
COPY --from=frontend /build/dist /srv/static

# The flattened USD layer is NOT baked in. It is a derived artifact (~4.9 MB
# gzipped, 31.9 MB raw) that changes whenever the IFC does, so baking it would
# put a stale, binary blob in version control and make every scene change a new
# image build. It is proxied from S3 instead, exactly like the IFC, and rebuilt
# by `cad/build_web_usd.py --publish`.

# Non-root user. The numeric UID must match the k8s securityContext
# (runAsUser: 1000) — PodSecurity is restricted:latest, so bake it in.
RUN adduser --disabled-password --uid 1000 --gecos "" appuser \
    && chown -R appuser /srv
USER appuser

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
