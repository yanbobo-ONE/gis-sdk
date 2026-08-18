# Layer Runtime Alpha 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first production-shaped layer slice to `@yanbobo/gis-sdk`: a typed lifecycle-owning Layer Runtime with Cesium GeoJSON and WMS adapters.

**Architecture:** Keep public layer contracts framework-neutral in `src/layers`, while Cesium object construction and cleanup remain in `src/cesium/layers`. The common handle stays deliberately small; GeoJSON data replacement and WMS opacity/style/filter operations live on capability-specific handles. `CesiumMapAdapter` owns the Layer Runtime and destroys layers before the Viewer.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 6, CesiumJS 1.144, Vitest, TypeDoc, VitePress, Changesets.

---

## File Structure

```text
src/
├── layers/
│   ├── contracts.ts
│   ├── layer-handle-runtime.ts
│   └── layer-runtime.ts
└── cesium/layers/
    ├── create-cesium-layer.ts
    ├── geojson-layer.ts
    ├── wms-filter.ts
    └── wms-layer.ts
tests/
├── layer-runtime.test.ts
├── geojson-layer.test.ts
├── wms-filter.test.ts
└── wms-layer.test.ts
docs/
├── guide/layers.md
└── research/12255230-catalog.md
```

### Task 1: Framework-neutral contracts and Layer Runtime

**Files:**

- Create: `src/layers/contracts.ts`
- Create: `src/layers/layer-handle-runtime.ts`
- Create: `src/layers/layer-runtime.ts`
- Create: `tests/layer-runtime.test.ts`
- Modify: `src/core/errors.ts`

- [ ] Write tests that specify unique IDs, concurrent-add reservation, typed handles, direct-handle disposal, remove/clear, cancellation, terminal manager disposal, and retry after cleanup failure.
- [ ] Run `pnpm vitest run tests/layer-runtime.test.ts` and confirm failure because the modules do not exist.
- [ ] Implement `LayerManager`, `LayerHandle`, `GeoJsonLayerHandle`, `WmsLayerHandle`, `LayerRuntime`, and structured layer errors.
- [ ] Run the focused test file until green, then run `pnpm test`.

The public capability split is:

```ts
interface LayerHandle {
  readonly id: string;
  readonly type: 'geojson' | 'wms';
  readonly state: LayerState;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  dispose(): Promise<void>;
}

interface GeoJsonLayerHandle extends LayerHandle {
  readonly type: 'geojson';
  setData(data: GeoJsonSource, options?: OperationOptions): Promise<void>;
}

interface WmsLayerHandle extends LayerHandle {
  readonly type: 'wms';
  readonly opacity: number;
  setOpacity(opacity: number): void;
  setFilter(filter?: WmsFilter): Promise<void>;
  setStyle(style?: string): Promise<void>;
  reload(): Promise<void>;
}
```

### Task 2: Cesium GeoJSON adapter

**Files:**

- Create: `src/cesium/layers/geojson-layer.ts`
- Create: `tests/geojson-layer.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Add `@types/geojson` as a declaration dependency.
- [ ] Write failing tests for object/URL input, SDK-to-Cesium style conversion, visibility, atomic `setData`, abort handling, and idempotent cleanup.
- [ ] Run `pnpm vitest run tests/geojson-layer.test.ts` and confirm the expected missing-module failure.
- [ ] Implement with public Cesium 1.144 interfaces only; URL input uses `fetch(..., { signal })`, and replacement data is added before the previous data source is removed.
- [ ] Run the focused tests and full tests.

### Task 3: Cesium WMS adapter and safe filter serializer

**Files:**

- Create: `src/cesium/layers/wms-filter.ts`
- Create: `src/cesium/layers/wms-layer.ts`
- Create: `tests/wms-filter.test.ts`
- Create: `tests/wms-layer.test.ts`

- [ ] Write failing serializer tests for comparison, boolean composition, string escaping, invalid property names, empty groups, and non-finite numbers.
- [ ] Implement a typed `WmsFilter`; do not expose raw string interpolation in the stable interface.
- [ ] Write failing WMS tests for provider options, visibility/opacity, style/filter replacement, reload, abort-before-add, and cleanup.
- [ ] Implement provider replacement while preserving visual state and collection order; use no Cesium private fields.
- [ ] Run focused and full tests.

### Task 4: Map ownership and public exports

**Files:**

- Create: `src/cesium/layers/create-cesium-layer.ts`
- Modify: `src/core/contracts.ts`
- Modify: `src/core/map-runtime.ts`
- Modify: `src/cesium/cesium-map-adapter.ts`
- Modify: `src/index.ts`
- Modify: `tests/map-runtime.test.ts`
- Modify: `tests/create-map.test.ts`
- Modify: `tests/cesium-map-adapter.test.ts`

- [ ] Add failing tests showing `map.layers` is stable, map destruction disposes layers before Viewer destruction, layer-cleanup failure is retryable, and post-destroy add is rejected.
- [ ] Wire `LayerRuntime` into `CesiumMapAdapter`; preserve the existing raw Viewer escape hatch.
- [ ] Export only public contracts and filter constructors/types from `src/index.ts`.
- [ ] Run all unit tests.

### Task 5: Documentation, compatibility record, and release metadata

**Files:**

- Create: `docs/guide/layers.md`
- Create: `docs/research/12255230-catalog.md`
- Create: `.changeset/*.md`
- Modify: `README.md`
- Modify: `docs/.vitepress/config.mts`
- Modify: `docs/cesium-sdk-prd.md`

- [ ] Document runnable GeoJSON and WMS examples, lifecycle, cancellation, capabilities, error modes, performance notes, and Cesium escape-hatch limits.
- [ ] Record selected `12255230` articles as research sources only, including version/private-interface/license risks; do not copy the offline pages into the package.
- [ ] Correct the PRD so common and capability-specific handles match the implementation.
- [ ] Add a minor Changeset because this is a backward-compatible public feature; do not change `package.json` version directly.

### Task 6: Verification and commit

- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm docs:build`.
- [ ] Run `pnpm pack:check`.
- [ ] Scan `src` for forbidden Cesium private-member access.
- [ ] Inspect the exact diff and commit task files with `[feat]: 增加类型化图层运行时与Cesium图层适配器`.
