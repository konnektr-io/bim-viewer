# bim-viewer

A browser BIM viewer. The model it serves — which building, from which bucket
key, under what title — is **entirely configuration**; nothing about any
particular project is compiled into the image or the frontend.

Deployed at <https://bim-viewer.local.raes.konnektr.io> (internal, home cluster).
Manifests live in [`nikoraes/home-k8s`](https://github.com/nikoraes/home-k8s) under
`bim-viewer/` and only reference this image by tag — the same split as kiseki:
this repo builds the image, `home-k8s` deploys it.

## Configuration

Everything the app needs comes from the environment:

| variable | required | meaning |
|---|---|---|
| `S3_ENDPOINT` | yes | e.g. `https://s3.local.raes.konnektr.io` |
| `S3_BUCKET` | yes | bucket name |
| `S3_REGION` | no | defaults to `us-east-1` |
| `S3_ACCESS_KEY` | yes | from the `bim-hermes-s3` Secret |
| `S3_SECRET_KEY` | yes | from the `bim-hermes-s3` Secret |
| `S3_MODEL_KEY` | yes | key in the bucket, e.g. `model/whatever.ifc` |
| `MODEL_SLUG` | no | filename the browser requests (default `model.ifc`) |
| `MODEL_TITLE` | no | display title (default `BIM model`) |
| `STATIC_DIR` | no | where the built SPA lives |

The browser asks `GET /api/config` for the slug and title, then streams the model
from `GET /api/model/{slug}`. Neither side hardcodes a filename.

## What it does

- **Storey switcher** over the `IfcBuildingStorey` entities, plus "All". A
  storey with 0 elements is shown rather than hidden.
- **Frame all** and iso/front/back/left/right/top/bottom view presets.
- **Picking** via `Highlighter`: click an element for its category, name,
  `GlobalId`, the `IfcSpace` room it sits in, and its
  `Pset_ElectricalCircuit` values.
- No settings panel, no accounts.

## Layout

```
app/
├── main.py            FastAPI: serves the SPA + streams the model from S3
├── index.html         Vite entry
├── src/
│   ├── main.tsx       React root
│   ├── App.tsx        layout + status line
│   ├── components/    FormatTabs · ViewControls · StoreyList · SelectionDetail
│   │                  · UsdPlaceholder · ViewerCanvas
│   ├── components/ui/ shadcn primitives (from graph-explorer)
│   ├── viewer/
│   │   ├── engine.ts  the imperative ThatOpen world (not a React component)
│   │   ├── viewPresets.ts
│   │   ├── labels.ts  Pset_ElectricalCircuit display labels
│   │   └── types.ts
│   ├── store/         zustand bridge
│   └── index.css      design tokens (from graph-explorer)
└── public/wasm/       web-ifc, vendored
```

The engine is deliberately **not** a React component: `Components.init()` owns a
render loop and the scene is a long-lived mutable object, so React owns the UI
and the engine owns the scene, bridged by zustand.

## Local development

```bash
cd app
npm ci
npm run build          # tsc -b && vite build

cd app && STATIC_DIR=./dist \
  S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… \
  S3_MODEL_KEY=… MODEL_SLUG=… MODEL_TITLE=… \
  uvicorn main:app --port 8080
```

## CI

`.github/workflows/build-image.yml` runs `tsc -b && vite build` plus a backend
import check, then builds and pushes to `ghcr.io/konnektr-io/bim-viewer` using
`GITHUB_TOKEN`.

**Tests run on every PR; the image is built on release only.** A PR must never
publish an artefact, and the image tag is the version — `home-k8s` pins an
explicit tag (`ghcr.io/konnektr-io/bim-viewer:v0.1.0`), so building on every
main push only moved a `latest` that CI was shipping underneath a running
deployment. Release a version to build it:

```bash
gh release create v0.1.1 --repo konnektr-io/bim-viewer --target main \
  --title "v0.1.1" --notes-file /tmp/notes.md
```

`gh release create` creates the tag, and that tag push is what triggers the
build. Tags follow the kiseki convention with the `v` prefix kept:
`v1.2.3`, `v1.2`, `v1`. There is deliberately no `latest` — with release-only
builds it would sit frozen and read as current.

`package.json` is `"private": true` and its version is not the release, so there
is nothing to bump: the git tag is the version.

## Notes for whoever extends this

**web-ifc must stay on 0.0.77.** 0.0.78's JS calls `StreamMeshes` with four
arguments while its wasm accepts three, so every load dies with
`function StreamMeshes called with 4 arguments, expected 3`. The stack trace
points at the Fragments worker and is misleading; changing the worker does not
help.

**Storeys and rooms must come from `getItemsOfCategories`.**
`getSpatialStructure()` stops at the storey level behind a chain of
null-category aggregation nodes, so matching on category finds nothing at all —
silently, with no error.

**The box APIs on `FragmentsModel` cannot be trusted for framing.** On a model
with one broken element (`ARC_573_Round transition_angle`, a duct fitting
spanning 47 m), `getBoxes()`, `getMergedBox(storeyIds)` and
`getMergedBox(storeyChildren)` all returned 280 × 546 × 281 while IfcOpenShell
measured the building at ~26 × 49 × 9 m. `computeBounds` therefore derives the
extent from element **centres**, which cluster correctly. Re-measure once the
model is re-exported without the bad element.

**Never pass an `oklch()` string to `THREE.Color`.** three.js cannot parse that
colour model, logs "Unknown color model" and silently leaves the value unset.
Convert the theme token to a hex literal.

## Known gaps

- **USD is a placeholder tab.** The scene USD is a reference-only `subLayers`
  composition, and three.js `USDLoader` follows neither `subLayers` nor
  `references` (0 hits in the loader source), so it cannot render it. It needs
  a flattening step: compose the stack into one self-contained `.usd`, rewrite
  the absolute paths to proxy-relative URLs, and scale mm → m.
- **Runtime CDN dependencies** remain: the Fragments worker (unpkg) and
  `opentype.js` (jsdelivr). Both are reachable from the cluster, but vendoring
  them would remove the dependency.
- The IFC → Fragments conversion runs **client-side**, so a cold first load
  downloads the whole model and then converts. Pre-converting to `.frag` would
  fix that at the cost of regenerating on every IFC edit.
