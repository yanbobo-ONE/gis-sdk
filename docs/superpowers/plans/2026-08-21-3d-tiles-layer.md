# 3D Tiles Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one lifecycle-owning `3d-tiles` layer type so business applications can load a standard 3D Tiles tileset through `map.layers` without manually managing Cesium scene primitives.

**Architecture:** The public layer contract accepts a small stable configuration: URL, visibility, maximum screen-space error, and optional level-of-detail skipping. `Cesium3DTileset.fromUrl()` remains inside the Cesium adapter. The adapter owns cancellation races, late-load destruction, scene insertion, visible state, and primitive removal; `LayerRuntime` continues to own IDs and map-level cleanup.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 6, CesiumJS 1.144, Vitest, TypeDoc, VitePress, Changesets.

---

## File Structure

```text
src/
├── layers/contracts.ts
└── cesium/layers/
    ├── create-cesium-layer.ts
    └── tileset-layer.ts
tests/
├── create-cesium-layer.test.ts
└── tileset-layer.test.ts
docs/
└── guide/layers.md
```

### Task 1: Add the smallest public 3D Tiles contract

**Files:**

- Modify: `src/layers/contracts.ts`
- Modify: `src/entries/layers.ts`
- Modify: `tests/public-api.test.ts`
- Modify: `tests/entrypoints.test.ts`

- [x] **Step 1: Write failing type-level and dispatch tests**

```ts
const spec = {
  id: 'city',
  type: '3d-tiles' as const,
  url: '/tiles/city/tileset.json',
  maximumScreenSpaceError: 8,
  skipLevelOfDetail: true,
};

await expect(createCesiumLayer(viewer, spec, context)).resolves.toEqual({ id: 'tileset-handle' });
```

Also compile-only import `Tiles3dLayerSpec` from both `@yanbobo/gis-sdk/layers` and package root.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run tests/create-cesium-layer.test.ts tests/public-api.test.ts tests/entrypoints.test.ts`

Expected: failure because `3d-tiles` is not part of `LayerSpec` and no Tileset adapter exists.

- [x] **Step 3: Add contract and dispatch seam**

```ts
export interface Tiles3dLayerSpec extends BaseLayerSpec {
  readonly type: '3d-tiles';
  readonly url: string;
  readonly maximumScreenSpaceError?: number;
  readonly skipLevelOfDetail?: boolean;
}

export type LayerType = 'geojson' | 'wms' | '3d-tiles';
export type LayerSpec = GeoJsonLayerSpec | WmsLayerSpec | Tiles3dLayerSpec;
```

`createCesiumLayer()` adds a `case '3d-tiles'` that forwards exact `viewer`, `spec`, and `LayerFactoryContext` arguments to `createTiles3dLayer()`.

- [x] **Step 4: Re-run focused tests and confirm GREEN**

Run: `pnpm vitest run tests/create-cesium-layer.test.ts tests/public-api.test.ts tests/entrypoints.test.ts`

Expected: PASS.

### Task 2: Implement cancellation-safe Tileset ownership

**Files:**

- Create: `src/cesium/layers/tileset-layer.ts`
- Create: `tests/tileset-layer.test.ts`

- [x] **Step 1: Write failing behavior tests**

```ts
const layer = await createTiles3dLayer(
  viewer,
  {
    id: 'city',
    type: '3d-tiles',
    url: ' /tiles/city/tileset.json ',
    visible: false,
    maximumScreenSpaceError: 8,
    skipLevelOfDetail: true,
  },
  context,
);

expect(Cesium3DTileset.fromUrl).toHaveBeenCalledWith('/tiles/city/tileset.json', {
  maximumScreenSpaceError: 8,
  skipLevelOfDetail: true,
});
expect(viewer.scene.primitives.add).toHaveBeenCalledWith(tileset);
expect(tileset.show).toBe(false);
```

Add one test each for visibility forwarding, invalid URL/SSE/boolean errors, `fromUrl()` rejection, an already-aborted add, abort while the Tileset promise is still pending, and idempotent disposal. The late completion test must prove `tileset.destroy()` is called and no primitive is added.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run tests/tileset-layer.test.ts`

Expected: failure because `tileset-layer.ts` does not exist.

- [x] **Step 3: Implement the minimal adapter**

```ts
const tileset = await raceAbort(Cesium3DTileset.fromUrl(url, options), signal);
tileset.show = visible;
viewer.scene.primitives.add(tileset);

return new CesiumTiles3dLayerHandle(viewer, spec.id, tileset, visible, context.onDisposed);
```

Validation throws `INVALID_LAYER_CONFIG`; remote errors become retryable `LAYER_LOAD_FAILED`; cancellation becomes `LAYER_OPERATION_ABORTED`. If cancellation wins the race, attach a cleanup continuation to the original `fromUrl()` promise and destroy the later-resolved tileset. Disposal removes the primitive with `scene.primitives.remove(tileset)`; if it was no longer in the collection, destroy the owned Tileset directly.

- [x] **Step 4: Re-run focused tests and confirm GREEN**

Run: `pnpm vitest run tests/tileset-layer.test.ts`

Expected: PASS.

### Task 3: Document only verified Tileset behavior

**Files:**

- Modify: `docs/guide/layers.md`
- Modify: `docs/guide/api-reference.md`
- Modify: `docs/guide/capability-status.md`
- Modify: `README.md`
- Modify: `docs/index.md`

- [x] **Step 1: Add a runnable minimal example**

```ts
const city = await map.layers.add({
  id: 'city',
  type: '3d-tiles',
  url: '/tiles/city/tileset.json',
  maximumScreenSpaceError: 8,
  skipLevelOfDetail: true,
});

city.setVisible(false);
await city.dispose();
```

Document `maximumScreenSpaceError` as a positive finite pixel error and `skipLevelOfDetail` as an optional Cesium traversal optimization. State that transformations, styles, clipping, classification, picking policy, tile-cache tuning, model/CZML/dynamic entity layers, and benchmark scale guarantees are not yet stable SDK contracts.

- [x] **Step 2: Update status rows**

Move only 3D Tiles from unpublished to available. Keep glTF, CZML, dynamic entities, Worker execution, large-data renderer selection, LOD policy automation, and benchmarks unpublished.

### Task 4: Release verification

**Files:**

- Create: `.changeset/3d-tiles-layer.md`
- Modify: `CHANGELOG.md` through `pnpm version-packages`
- Modify: `package.json` through `pnpm version-packages`

- [x] **Step 1: Add a minor Changeset**

```markdown
---
'@yanbobo/gis-sdk': minor
---

增加受生命周期管理的 3D Tiles 图层，支持加载、显隐、基础 LOD 配置和资源释放。
```

- [x] **Step 2: Run release verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:build && pnpm pack:check && pnpm example:build`

Expected: all commands exit zero. Then run `git diff --check`, scan for private Cesium fields and removed sensitive terms, validate the commit/version, commit, push, and verify remote ancestry.
