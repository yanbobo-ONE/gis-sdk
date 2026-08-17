# GIS SDK Initial Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the first independently buildable, testable, packable `gis-sdk` project with a small TypeScript interface, a Cesium 1.144 adapter, documentation, and guarded npm publishing configuration.

**Architecture:** Start with one publishable package named `@yanbobo/gis-sdk` inside the standalone `gis-sdk` repository. Keep framework-neutral contracts and runtime in `src/core`, place all Cesium imports in `src/cesium`, and expose one `createMap()` factory plus instance methods. Do not split empty npm packages yet; the internal seam allows `core` and `cesium` to become separate packages after a second real adapter or independent release need exists.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 6, CesiumJS 1.144, tsup, Vitest, ESLint 10, typescript-eslint, Prettier, TypeDoc, VitePress, Changesets, publint.

---

## File Structure

```text
gis-sdk/
├── .changeset/config.json
├── .github/workflows/ci.yml
├── docs/
│   ├── .vitepress/config.mts
│   ├── api.md
│   ├── cesium-sdk-prd.md
│   ├── guide/getting-started.md
│   ├── index.md
│   ├── publishing.md
│   └── research/cesium-sdk-reference-research.md
├── scripts/copy-static.mjs
├── src/
│   ├── cesium/cesium-map-adapter.ts
│   ├── cesium/create-map.ts
│   ├── cesium/types.ts
│   ├── core/contracts.ts
│   ├── core/errors.ts
│   ├── core/event-hub.ts
│   ├── core/map-runtime.ts
│   ├── index.ts
│   └── styles.css
├── tests/
│   ├── event-hub.test.ts
│   ├── map-runtime.test.ts
│   └── create-map.test.ts
├── .editorconfig
├── .gitignore
├── .npmrc
├── .prettierignore
├── .prettierrc.json
├── CHANGELOG.md
├── README.md
├── eslint.config.mjs
├── package.json
├── pnpm-lock.yaml
├── tsconfig.build.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

## Task 1: Establish the package and quality toolchain

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `eslint.config.mjs`
- Create: `.editorconfig`
- Create: `.npmrc`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.changeset/config.json`
- Create: `scripts/copy-static.mjs`
- Create: `src/styles.css`

- [ ] **Step 1: Create the package manifest**

Use `@yanbobo/gis-sdk` because the unscoped npm name `gis-sdk` is owned by another account and the authenticated npm account owns the `yanbobo` scope. Set version `0.1.0-alpha.0`, `type: module`, `engines.node: >=22.0.0`, `packageManager: pnpm@11.19.0`, `cesium: 1.144.0`, ESM/CJS/type exports, `./styles.css`, and `publishConfig.registry: https://registry.npmjs.org/`. Keep `license: UNLICENSED` until the repository owner makes an explicit license decision.

Required scripts:

```json
{
  "clean": "rm -rf dist coverage",
  "build": "pnpm clean && tsup && node scripts/copy-static.mjs",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint .",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "docs:dev": "vitepress docs",
  "docs:build": "typedoc --options typedoc.json && vitepress build docs",
  "pack:check": "pnpm build && publint && npm pack --dry-run",
  "changeset": "changeset",
  "version-packages": "changeset version",
  "release": "changeset publish"
}
```

- [ ] **Step 2: Configure strict TypeScript and builds**

Set `target: ES2022`, `module/moduleResolution: NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and DOM/WebWorker libraries. Configure tsup for `src/index.ts`, ESM + CJS, declarations, sourcemaps, clean output, and external sourcemaps. Build CSS by copying `src/styles.css` to `dist/styles.css` with `node:fs/promises` in `scripts/copy-static.mjs`.

- [ ] **Step 3: Configure lint, format, and tests**

Use ESLint flat config with `typescript-eslint` recommended type-checked rules. Ignore `dist`, `coverage`, generated TypeDoc output, and VitePress output. Configure Vitest with Node environment, `tests/**/*.test.ts`, and coverage thresholds deferred until functional modules exist.

- [ ] **Step 4: Install dependencies and lock them**

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` is created, Cesium resolves to `1.144.0`, and no unsupported Node warning appears.

- [ ] **Step 5: Verify the configuration baseline**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all three commands exit 0 before behavior code is added.

- [ ] **Step 6: Commit the toolchain**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.build.json tsup.config.ts vitest.config.ts eslint.config.mjs .editorconfig .npmrc .prettierrc.json .prettierignore .changeset scripts src/styles.css
git commit -m "[chore]: 初始化SDK构建与质量工具链"
```

## Task 2: Build the framework-neutral map runtime with TDD

**Files:**

- Create: `tests/event-hub.test.ts`
- Create: `tests/map-runtime.test.ts`
- Create: `src/core/contracts.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/event-hub.ts`
- Create: `src/core/map-runtime.ts`

- [ ] **Step 1: Write failing EventHub tests**

Tests must demonstrate this intended interface:

```ts
type Events = {
  ready: { id: string }
  destroyed: { id: string }
}

const events = new EventHub<Events>()
const received: string[] = []
const off = events.on('ready', event => received.push(event.id))

events.emit('ready', { id: 'map-1' })
off()
events.emit('ready', { id: 'map-2' })

expect(received).toEqual(['map-1'])
```

Also test `once()` and `clear()`. Import from `../src/core/event-hub.js`; the first run must fail because the module does not exist.

- [ ] **Step 2: Verify EventHub tests fail for the expected reason**

Run:

```bash
pnpm vitest run tests/event-hub.test.ts
```

Expected: FAIL with module-not-found for `src/core/event-hub`.

- [ ] **Step 3: Implement the minimal typed EventHub**

Implement:

```ts
export type EventMap = object
export type Unsubscribe = () => void

export class EventHub<TEvents extends EventMap> {
  on<TKey extends keyof TEvents>(type: TKey, listener: (event: TEvents[TKey]) => void): Unsubscribe
  once<TKey extends keyof TEvents>(type: TKey, listener: (event: TEvents[TKey]) => void): Unsubscribe
  emit<TKey extends keyof TEvents>(type: TKey, event: TEvents[TKey]): void
  clear(): void
}
```

Use a `Map<keyof TEvents, Set<...>>`, snapshot listeners before emit, make unsubscribe idempotent, and remove empty sets.

- [ ] **Step 4: Run EventHub tests to green**

Run:

```bash
pnpm vitest run tests/event-hub.test.ts
```

Expected: all EventHub tests pass.

- [ ] **Step 5: Write failing MapRuntime tests**

Define a fake `MapEngineAdapter` in the test. Test these behaviors:

1. initial state is `ready`;
2. `resize()` delegates while ready;
3. `destroy()` calls the adapter exactly once even when invoked twice;
4. state becomes `destroyed` and emits `map:destroy` once;
5. `resize()` after destroy throws `GisError` with code `MAP_DISPOSED`.

The desired public contracts are:

```ts
export type MapState = 'ready' | 'destroying' | 'destroyed'

export interface MapEventMap {
  'map:destroy': { id: string }
  'map:error': { id: string; error: GisError }
}

export interface GisMap<TRaw = unknown> {
  readonly id: string
  readonly state: MapState
  readonly events: EventHub<MapEventMap>
  readonly raw: Readonly<TRaw>
  resize(): void
  destroy(): Promise<void>
}
```

- [ ] **Step 6: Verify MapRuntime tests fail**

Run:

```bash
pnpm vitest run tests/map-runtime.test.ts
```

Expected: FAIL because contracts/runtime modules are missing.

- [ ] **Step 7: Implement errors, contracts, and runtime**

`GisError` must carry `code`, `module`, `operation`, `retryable`, and optional `cause`. `MapRuntime` owns the adapter, catches adapter destroy errors, emits `map:error`, returns the same in-flight destroy Promise to concurrent callers, and is idempotent after successful destroy.

Internal adapter contract:

```ts
export interface MapEngineAdapter<TRaw> {
  readonly raw: Readonly<TRaw>
  resize(): void
  destroy(): void | Promise<void>
}
```

- [ ] **Step 8: Run the focused and full tests**

Run:

```bash
pnpm vitest run tests/event-hub.test.ts tests/map-runtime.test.ts
pnpm test
pnpm typecheck
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 9: Commit the core runtime**

```bash
git add src/core tests/event-hub.test.ts tests/map-runtime.test.ts
git commit -m "[feat]: 添加类型化地图运行时与生命周期"
```

## Task 3: Add the Cesium adapter and public createMap factory with TDD

**Files:**

- Create: `tests/create-map.test.ts`
- Create: `src/cesium/types.ts`
- Create: `src/cesium/cesium-map-adapter.ts`
- Create: `src/cesium/create-map.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Write failing createMap contract tests**

Test the internal `createMapWithFactory()` seam with a fake adapter factory. Cover:

1. empty string container rejects with `INVALID_CONTAINER`;
2. scene mode defaults to `3d`;
3. `cesiumBaseUrl` is normalized with one trailing slash;
4. factory receives a frozen normalized options object;
5. returned map exposes the adapter raw object and delegates lifecycle.

Desired input:

```ts
export interface CreateMapOptions {
  container: string | HTMLElement
  id?: string
  cesiumBaseUrl?: string
  scene?: { mode?: '2d' | '3d' }
  widgets?: {
    animation?: boolean
    baseLayerPicker?: boolean
    fullscreenButton?: boolean
    geocoder?: boolean
    homeButton?: boolean
    infoBox?: boolean
    navigationHelpButton?: boolean
    sceneModePicker?: boolean
    selectionIndicator?: boolean
    timeline?: boolean
  }
}
```

- [ ] **Step 2: Verify createMap tests fail**

Run:

```bash
pnpm vitest run tests/create-map.test.ts
```

Expected: FAIL because `src/cesium/create-map` is missing.

- [ ] **Step 3: Implement normalization and factory seam**

`createMapWithFactory(options, factory)` validates without reading the DOM, normalizes defaults, freezes nested option objects, creates the adapter, and returns `MapRuntime`. Generate IDs with `globalThis.crypto.randomUUID()` when absent. `createMap(options)` calls the real Cesium factory and is the only normal public entry.

- [ ] **Step 4: Implement CesiumViewerAdapter**

Use public Cesium 1.144 imports only:

```ts
import { buildModuleUrl, SceneMode, Viewer } from 'cesium'
```

Set `buildModuleUrl.setBaseUrl()` only when `cesiumBaseUrl` is supplied. Map `2d/3d` to `SceneMode.SCENE2D/SCENE3D`. Default optional Viewer widgets to `false` and `baseLayer` to `false` so the SDK does not require a Cesium ion token. The adapter must call `viewer.resize()` and `viewer.destroy()` and expose `{ viewer }` as readonly raw context. Do not access underscore-prefixed Cesium members.

- [ ] **Step 5: Export only the stable public surface**

`src/index.ts` exports:

- `createMap`;
- `CreateMapOptions`, `CesiumMap`, and `CesiumRawContext` types;
- `GisMap`, `MapState`, `MapEventMap` types;
- `GisError`, `GisErrorCode`;
- `EventHub`, `Unsubscribe`.

Do not export `MapEngineAdapter`, `MapRuntime`, `createMapWithFactory`, or normalization helpers.

- [ ] **Step 6: Run tests and package build**

Run:

```bash
pnpm vitest run tests/create-map.test.ts
pnpm test
pnpm typecheck
pnpm build
```

Expected: tests, typecheck, and build exit 0; `dist/index.js`, `dist/index.cjs`, declarations, maps, and `dist/styles.css` exist.

- [ ] **Step 7: Commit the Cesium entry point**

```bash
git add src/cesium src/index.ts tests/create-map.test.ts
git commit -m "[feat]: 添加Cesium地图适配器与创建入口"
```

## Task 4: Add developer documentation, publishing guardrails, and CI

**Files:**

- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `typedoc.json`
- Create: `docs/.vitepress/config.mts`
- Create: `docs/index.md`
- Create: `docs/api.md`
- Create: `docs/guide/getting-started.md`
- Create: `docs/publishing.md`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

- [ ] **Step 1: Write the repository README**

README must lead with the `gis-sdk` name, status `0.1.0-alpha.0`, Node 22/pnpm requirements, installation using `@yanbobo/gis-sdk`, import of `@yanbobo/gis-sdk/styles.css`, `createMap()` example, explicit destroy example, and links to the PRD and publishing guide. State clearly that the package is pre-alpha and not yet published.

- [ ] **Step 2: Document Cesium assets and npm publishing**

`docs/guide/getting-started.md` must explain `cesiumBaseUrl`, copying Cesium `Workers`, `ThirdParty`, `Assets`, and `Widgets`, and no-ion-token operation. `docs/publishing.md` must record:

```text
npm registry: https://registry.npmjs.org/
unscoped gis-sdk owner: njueyupeng (not this project)
package: @yanbobo/gis-sdk
required before publish: npm login, npm whoami, npm access ls-packages
```

Do not write npm tokens or `.npmrc` auth lines. Publishing remains a manual action until account/scope ownership is verified.

- [ ] **Step 3: Configure TypeDoc and VitePress**

Generate TypeDoc Markdown/HTML only from `src/index.ts`; exclude internal/private/protected symbols and fail on validation errors. VitePress navigation must include Guide, Interface Reference, PRD, Research, Publishing, and Changelog.

- [ ] **Step 4: Configure CI**

GitHub Actions runs on pull requests and pushes to `main` with Node 22 and pnpm 11.19.0:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm docs:build
pnpm pack:check
```

Do not configure npm publish in this workflow; npm authentication is not yet verified.

- [ ] **Step 5: Run the complete quality gate**

Run:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm docs:build
pnpm pack:check
```

Expected: every command exits 0. Inspect the dry-run package file list and verify it contains only `dist`, README, CHANGELOG, and package metadata.

- [ ] **Step 6: Commit docs and CI**

```bash
git add README.md CHANGELOG.md typedoc.json docs .github package.json
git commit -m "[docs]: 添加SDK接入发布文档与持续集成"
```

## Final Verification

- [ ] Run `git status --short` and confirm only intended changes remain.
- [ ] Run `git log --oneline --decorate -5` and confirm logical commits are separated.
- [ ] Run the complete quality gate again from a clean worktree.
- [ ] Run `npm pack --dry-run` and confirm the package name is `@yanbobo/gis-sdk@0.1.0-alpha.0`.
- [ ] Confirm `npm whoami` is still treated as a publish prerequisite; do not publish while unauthenticated.
- [ ] Merge the implementation branch to `main`, rerun verification, and push only after the remote commit can be proven with GitHub API or Git fetch.
