# TMS and WMTS Imagery Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed TMS and WMTS imagery-layer adapters with the same lifecycle and resource-ownership guarantees as existing SDK imagery layers.

**Architecture:** Extend the public layer discriminated union with narrow TMS and WMTS specifications. Both adapters will share a small Cesium imagery-layer runtime that owns the `ImageryLayer`, applies initial visibility and opacity, and converts provider failures into SDK errors. TMS provider creation remains cancellation-aware because Cesium loads its service metadata asynchronously; WMTS validates the required service identifiers before constructing the provider.

**Tech Stack:** TypeScript, Cesium 1.144, Vitest, VitePress, pnpm.

---

### Task 1: Extend public layer contracts and factory dispatch

**Files:**

- Modify: `src/layers/contracts.ts`
- Modify: `src/entries/layers.ts`
- Modify: `src/cesium/layers/create-cesium-layer.ts`
- Modify: `tests/create-cesium-layer.test.ts`
- Modify: `tests/public-api.test.ts`
- Modify: `tests/entrypoints.test.ts`

- [x] **Step 1: Write failing contract and dispatch tests**

Add TMS and WMTS specs to the factory test and type-only public entry checks. The expected discriminators are `type: 'tms'` and `type: 'wmts'`; both return `ImageryLayerHandle` with `opacity` and `setOpacity`.

- [x] **Step 2: Run the focused tests to verify the new branches fail**

Run: `pnpm vitest run tests/create-cesium-layer.test.ts tests/public-api.test.ts tests/entrypoints.test.ts`

Expected: TypeScript/test failure because the new layer types and factory branches do not yet exist.

- [x] **Step 3: Add the discriminated types and common imagery handle**

In `src/layers/contracts.ts`, add `ImageryLayerHandle`, `TmsLayerSpec`, and `WmtsLayerSpec`; include both types in `LayerType`, `LayerSpec`, and `LayerHandleFor`. Keep the WMTS options limited to stable serializable fields (`format`, levels, tile matrix labels, feature picking, and subdomains) and keep Cesium-specific objects out of the public contract.

- [x] **Step 4: Wire the Cesium factory and public exports**

Import `createTmsLayer` and `createWmtsLayer`, dispatch both cases, and export `ImageryLayerHandle`, `TmsLayerSpec`, and `WmtsLayerSpec` from `src/entries/layers.ts`.

- [x] **Step 5: Run the focused tests again**

Run: `pnpm vitest run tests/create-cesium-layer.test.ts tests/public-api.test.ts tests/entrypoints.test.ts`

Expected: The type contract tests pass; adapter-specific runtime tests remain pending until Task 2.

### Task 2: Implement shared tiled imagery lifecycle

**Files:**

- Create: `src/cesium/layers/tiled-imagery-layer.ts`
- Modify: `src/cesium/layers/create-cesium-layer.ts`
- Create: `tests/tiled-imagery-layer.test.ts`

- [x] **Step 1: Write failing runtime tests**

Cover: TMS provider loading through `TileMapServiceImageryProvider.fromUrl`, WMTS construction with required options, initial hidden/opacity state, opacity validation, invalid URLs/required identifiers, provider failures mapped to `LAYER_LOAD_FAILED`, cancellation before provider creation, cancellation while TMS metadata is pending, and idempotent disposal through `imageryLayers.remove(layer, true)`.

- [x] **Step 2: Run the focused runtime test file**

Run: `pnpm vitest run tests/tiled-imagery-layer.test.ts`

Expected: FAIL because the adapter module and Cesium mocks do not exist.

- [x] **Step 3: Implement validated TMS and WMTS provider creation**

Add a focused adapter module with:

```ts
type ProviderLoader = () => Promise<ImageryProvider>;
function createTmsLayer(
  viewer: Viewer,
  spec: TmsLayerSpec,
  context: LayerFactoryContext,
): Promise<ImageryLayerHandle>;
function createWmtsLayer(
  viewer: Viewer,
  spec: WmtsLayerSpec,
  context: LayerFactoryContext,
): Promise<ImageryLayerHandle>;
```

Normalize and validate trimmed URLs, non-empty WMTS `layer`, `style`, and `tileMatrixSetID`, finite level values, and opacity in `[0, 1]`. Use `raceAbort` for TMS provider loading. Do not add a layer after cancellation. The shared handle must set `show` and `alpha`, delegate visibility/disposal to `LayerHandleRuntime`, and call `context.onDisposed` exactly once.

- [x] **Step 4: Run the runtime tests**

Run: `pnpm vitest run tests/tiled-imagery-layer.test.ts tests/create-cesium-layer.test.ts`

Expected: PASS with all cancellation, error, state, and ownership assertions.

### Task 3: Document the public API and capability status

**Files:**

- Modify: `docs/guide/layers.md`
- Modify: `docs/guide/api-reference.md`
- Modify: `docs/guide/capability-status.md`
- Modify: `docs/guide/imports.md`
- Modify: `docs/index.md`
- Modify: `README.md`

- [x] **Step 1: Add usage examples and parameter/effect tables**

Document `map.layers.add({ type: 'tms', ... })` and `map.layers.add({ type: 'wmts', ... })`, including required fields, optional fields, return handle methods, cancellation behavior, and ownership rules. State that WMTS capabilities parsing and dynamic dimensions are intentionally not included in this slice.

- [x] **Step 2: Update capability summaries and imports**

Mark TMS/WMTS as available in the capability matrix, expose subpath import examples, and keep unpublished items explicitly listed (single-image providers, vector tiles, dynamic WMTS dimensions, worker pools, LOD/primitive rendering, and benchmarks).

- [x] **Step 3: Run documentation build**

Run: `pnpm docs:build`

Expected: VitePress build succeeds without broken links or unresolved type names.

### Task 4: Release metadata, full verification, and delivery

**Files:**

- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Create: `.changeset/<generated-tms-wmts-name>.md`

- [x] **Step 1: Add a patch-level alpha changeset**

Use the existing alpha release convention and describe the public TMS/WMTS layer contracts and adapters. Run `pnpm version-packages` to update package metadata and docs version references.

- [x] **Step 2: Run the complete release gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:build && pnpm pack:check && pnpm example:build && git diff --check`.

Also scan tracked source/docs/package files for the previously identified sensitive project names case-insensitively; expected result is no matches.

- [x] **Step 3: Commit and push the scoped release**

Run `git status`, stage only TMS/WMTS implementation, tests, docs, plan, and release metadata, then commit with `[feat]: 增加 TMS 和 WMTS 影像图层` and push `main` to `origin`.

- [x] **Step 4: Prove remote containment**

Fetch `origin`, compare local `HEAD` with `origin/main`, and run `git merge-base --is-ancestor HEAD origin/main`. Report exact commit and verification results. npm publication remains a separate local-OTP action and must not be claimed unless `npm view @yanbobo/gis-sdk@<version>` confirms it.
