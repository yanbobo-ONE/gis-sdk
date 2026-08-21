# Foundation Map Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the remaining M1 map foundations as typed, lifecycle-safe controls for camera movement, one XYZ basemap, and ellipsoid/Cesium terrain.

**Architecture:** Public contracts live in `src/core/controls.ts`, so callers depend on geographic degrees and stable SDK semantics rather than Cesium objects. Three Cesium adapters hide degree-to-radian conversion, provider ownership, asynchronous terrain loading, and teardown. `MapRuntime` is the external seam: it guards every controller operation with the map lifecycle before delegating to its adapter.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 6, CesiumJS 1.144, Vitest, TypeDoc, VitePress, Changesets.

---

## File Structure

```text
src/
├── core/
│   ├── controls.ts
│   └── contracts.ts
└── cesium/
    ├── basemap-controller.ts
    ├── camera-controller.ts
    ├── terrain-controller.ts
    └── cesium-map-adapter.ts
tests/
├── basemap-controller.test.ts
├── camera-controller.test.ts
└── terrain-controller.test.ts
```

### Task 1: Define lifecycle-safe public controls

**Files:**

- Create: `src/core/controls.ts`
- Modify: `src/core/contracts.ts`
- Modify: `src/core/map-runtime.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/entries/core.ts`
- Modify: `tests/map-runtime.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
expect(map.camera.setView).toBeTypeOf('function');
expect(() => map.camera.setView(view)).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED' }));
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/map-runtime.test.ts`

Expected: failure because `GisMap` and `MapEngineAdapter` do not expose map controls.

- [ ] **Step 3: Add the minimal contracts and runtime guards**

```ts
export interface CameraController {
  setView(view: CameraView): void;
  flyTo(view: CameraFlight): Promise<void>;
  cancelFlight(): void;
}
```

`MapRuntime` must create stable forwarding controllers that reject every method while the map is destroying or destroyed. The adapter owns resource teardown; the runtime owns the public lifecycle guard.

- [ ] **Step 4: Re-run the focused test**

Run: `pnpm vitest run tests/map-runtime.test.ts`

Expected: PASS.

### Task 2: Implement Cesium camera control

**Files:**

- Create: `src/cesium/camera-controller.ts`
- Create: `tests/camera-controller.test.ts`

- [ ] **Step 1: Write failing behavior tests**

```ts
await expect(
  camera.flyTo({ longitude: 116.39, latitude: 39.9, height: 1200 }),
).resolves.toBeUndefined();
expect(fakeCamera.flyTo).toHaveBeenCalledWith(
  expect.objectContaining({
    destination: { longitude: 116.39, latitude: 39.9, height: 1200 },
  }),
);
```

Also test degree validation, replacement of an in-flight flight, explicit cancellation, and teardown rejection.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/camera-controller.test.ts`

Expected: failure because `camera-controller.ts` does not exist.

- [ ] **Step 3: Implement the camera adapter**

Use only `Cartesian3.fromDegrees`, `Math.toRadians`, `Camera.setView`, `Camera.flyTo`, and `Camera.cancelFlight`. Resolve the SDK flight promise from Cesium `complete`; reject it from Cesium `cancel` with `CAMERA_FLIGHT_CANCELLED`.

- [ ] **Step 4: Re-run the focused test**

Run: `pnpm vitest run tests/camera-controller.test.ts`

Expected: PASS.

### Task 3: Implement basemap and terrain controls

**Files:**

- Create: `src/cesium/basemap-controller.ts`
- Create: `src/cesium/terrain-controller.ts`
- Create: `tests/basemap-controller.test.ts`
- Create: `tests/terrain-controller.test.ts`

- [ ] **Step 1: Write failing basemap tests**

```ts
controller.set({ type: 'xyz', url: '/tiles/{z}/{x}/{y}.png', opacity: 0.7 });
expect(viewer.imageryLayers.addImageryProvider).toHaveBeenCalledOnce();
expect(controller.opacity).toBe(0.7);
```

Test atomic replacement, visibility, opacity validation, clear, and disposal.

- [ ] **Step 2: Write failing terrain tests**

```ts
await controller.set({ type: 'cesium-terrain', url: '/terrain/' });
expect(viewer.terrainProvider).toBe(provider);
expect(controller.type).toBe('cesium-terrain');
```

Test ellipsoid reset, invalid URL, load failure preserving the old terrain, concurrent-set rejection, and disposal during a pending load.

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `pnpm vitest run tests/basemap-controller.test.ts tests/terrain-controller.test.ts`

Expected: failure because the controller modules do not exist.

- [ ] **Step 4: Implement minimal Cesium adapters**

`BasemapController` owns exactly one imagery layer and inserts it at index zero, keeping thematic layers above it. `TerrainController` only assigns a newly resolved provider after successful load; an old provider remains active after a failed request.

- [ ] **Step 5: Re-run focused tests**

Run: `pnpm vitest run tests/basemap-controller.test.ts tests/terrain-controller.test.ts`

Expected: PASS.

### Task 4: Wire initial options, public exports, and documentation

**Files:**

- Modify: `src/cesium/types.ts`
- Modify: `src/cesium/create-map.ts`
- Modify: `src/cesium/cesium-map-adapter.ts`
- Modify: `src/entries/cesium.ts`
- Modify: `README.md`
- Modify: `docs/guide/api-reference.md`
- Modify: `docs/guide/capability-status.md`
- Create: `docs/guide/map-controls.md`
- Modify: `docs/.vitepress/config.mts`

- [ ] **Step 1: Write failing adapter and public-entry tests**

```ts
const map = createMap({
  container: 'map',
  basemap: { type: 'xyz', url: '/tiles/{z}/{x}/{y}.png' },
});
expect(map.basemap.type).toBe('xyz');
expect(map.camera).toBeDefined();
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm vitest run tests/create-map.test.ts tests/cesium-map-adapter.test.ts tests/entrypoints.test.ts`

Expected: failure because map controls and initial basemap configuration are absent.

- [ ] **Step 3: Wire the controls and docs**

`CreateMapOptions.basemap` supports only `{ type: 'xyz' }` initially. Terrain is configured asynchronously through `await map.terrain.set(...)`; the docs must say TMS, WMTS, 3D Tiles and models remain unpublished.

- [ ] **Step 4: Re-run focused tests**

Run: `pnpm vitest run tests/create-map.test.ts tests/cesium-map-adapter.test.ts tests/entrypoints.test.ts`

Expected: PASS.

### Task 5: Release verification

**Files:**

- Create: `.changeset/foundation-map-controls.md`
- Modify: `CHANGELOG.md` through `pnpm version-packages`
- Modify: `package.json` through `pnpm version-packages`

- [ ] **Step 1: Add a minor Changeset**

```markdown
---
'@yanbobo/gis-sdk': minor
---

新增类型化相机、XYZ 底图和地形控制器。
```

- [ ] **Step 2: Generate the alpha prerelease version**

Run: `pnpm version-packages`

Expected: `0.1.0-alpha.2` advances to `0.2.0-alpha.0` because a minor Changeset is introduced in alpha prerelease mode.

- [ ] **Step 3: Run the delivery gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm docs:build && pnpm pack:check && pnpm example:build`

Expected: all commands exit zero; review `git diff --check`, public exports, forbidden private Cesium accesses, and the capabilities table before committing.
