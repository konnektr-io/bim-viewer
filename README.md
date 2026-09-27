# bim-viewer

Browser IFC viewer for **Achterhekers 57** — <https://bim-viewer.local.raes.konnektr.io>
(internal, home cluster).

Renders the real 17.7 MB IFC so the model can be checked in a browser. The point
is the data a 3D view alone cannot show: **room names** and **which electrical
circuit each light is on**.

Stack: [ThatOpen `engine_components`](https://github.com/ThatOpen/engine_components)
(`@thatopen/components` + `@thatopen/components-front`) on three.js + web-ifc.

> **Deployment is not in this repo.** The k8s manifests live in
> [`nikoraes/home-k8s`](https://github.com/nikoraes/home-k8s) under
> `bim-viewer/`, and they only reference this image by tag. Same split as
> kiseki: this repo builds the image, `home-k8s` deploys it.

## What it does

- **Storey switcher** over the 7 `IfcBuildingStorey` (S_Funderingsplaat,
  A_Kelder, Maaiveld, S_Gelijkvloers, A_Gelijkvloers Vloer, A_Verdieping +1,
  A_Verdieping +2), plus "Alles". A storey with 0 elements is shown, not hidden.
- **Picking** via `Highlighter`: click an element for its category, name,
  `GlobalId`, the `IfcSpace` room it sits in, and its
  `Pset_ElectricalCircuit` values.
- No settings panel, no accounts, no knobs.

## Layout

```
app/
├── main.py            FastAPI: serves the SPA + proxies the IFC from Garage
├── index.html         Vite entry
├── src/
│   ├── main.tsx       React root
│   ├── App.tsx        layout, status line
│   ├── components/    FormatTabs · StoreyList · SelectionDetail · UsdPlaceholder
│   ├── components/ui/ shadcn primitives (from graph-explorer)
│   ├── viewer/
│   │   ├── engine.ts  the imperative ThatOpen world (not a React component)
│   │   ├── types.ts   payload shapes + unwrap()
│   │   └── labels.ts  Pset_ElectricalCircuit display labels
│   ├── store/         zustand bridge
│   └── index.css      design tokens (copied from graph-explorer)
└── public/wasm/       web-ifc 0.0.77, vendored
```

The engine is deliberately **not** a React component: `Components.init()` owns a
render loop and the scene is a long-lived mutable object, so React owns the UI
and the engine owns the scene, bridged by zustand.

## The model

`bim` bucket, key `model/Achterhekers57.ifc` — **17,670,343 bytes**, the single
authored working file. The backend reads credentials from the `bim-hermes-s3`
Secret at runtime and signs S3 requests itself, so the key never reaches the
browser and no CORS or signed-URL flow is needed.

## Version pins that matter

| package | pin | why |
|---|---|---|
| `web-ifc` | **0.0.77** | 0.0.78's JS calls `StreamMeshes` with 4 args while its wasm accepts 3; every load dies with `function StreamMeshes called with 4 arguments, expected 3`. Not fixable by changing the Fragments worker. |
| `@thatopen/fragments` | `3.4.7` | `FragmentsManager.getWorker()` resolves the matching worker build. |

## Local development

```bash
cd app
npm ci
npm run build        # tsc -b && vite build

# in another shell, for the API + S3 proxy
cd app && STATIC_DIR=../app/dist \
  S3_ENDPOINT=https://s3.local.raes.konnektr.io S3_BUCKET=bim \
  S3_REGION=us-east-1 S3_ACCESS_KEY=… S3_SECRET_KEY=… \
  uvicorn main:app --port 8080
```

`npm run dev` starts Vite with `/api` proxied to `127.0.0.1:8080`.

## CI

`.github/workflows/build-image.yml` runs `tsc -b && vite build` plus a backend
import check, then builds and pushes to `ghcr.io/konnektr-io/bim-viewer` with
`GITHUB_TOKEN`. Tags follow the kiseki convention (`v1.2.3`, `v1.2`, `v1`,
`latest` on the default branch).

The ghcr package is **public**, so the cluster pulls it without a pull secret.

## Known gaps

- **USD is a placeholder tab.** The house USD is a reference-only `subLayers`
  composition, and three.js `USDLoader` follows neither `subLayers` nor
  `references` (0 hits in the loader source), so it cannot render it. It needs
  a flattening step: compose the stack into one self-contained `.usd`, rewrite
  the absolute `/opt/data/cad/…` paths to proxy-relative URLs, and scale
  mm → m. `garden.usda` and `hifi_assets.usda` are also deliberate empty
  placeholders, so the current scene is shell + bathroom.
- **Runtime CDN dependencies** remain: the Fragments worker (unpkg) and
  `opentype.js` (jsdelivr). Both are reachable from the cluster, but vendoring
  them would remove the dependency.
- The IFC → Fragments conversion runs **client-side**, so a cold first load
  downloads 17.7 MB and then converts. Pre-converting to `.frag` would fix that
  at the cost of regenerating on every IFC edit.
