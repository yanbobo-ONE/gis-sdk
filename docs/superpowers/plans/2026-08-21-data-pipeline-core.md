# Data Pipeline Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a framework-neutral, bounded data-pipeline core that accepts dynamic updates, coalesces them by key, applies a declared overflow policy, and exposes deterministic batches and statistics to a future render scheduler.

**Architecture:** `DataPipeline<T>` is the public deep module. Callers only push values, take a bounded batch, inspect an immutable statistics snapshot, and close the pipeline. The implementation owns queue accounting, key validation, latest-value coalescing, and drop decisions. Cesium, Worker creation, data-source adapters, and rendering remain outside this slice; future main-thread and Worker executors can feed the same module without changing consumers.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 6, Vitest, TypeDoc, VitePress, Changesets.

---

## File Structure

```text
src/
├── core/
│   ├── data-pipeline.ts
│   └── errors.ts
└── entries/
    └── core.ts
tests/
└── data-pipeline.test.ts
docs/
└── guide/data-pipeline.md
```

### Task 1: Specify the public pipeline interface

**Files:**

- Create: `tests/data-pipeline.test.ts`
- Create: `src/core/data-pipeline.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/entries/core.ts`

- [ ] **Step 1: Write the failing usage tests**

```ts
const pipeline = new DataPipeline({
  keyBy: (update) => update.id,
  maxQueueItems: 2,
  coalesce: 'latest',
  overflow: 'drop-oldest',
});

pipeline.push({ id: 'aircraft-1', position: 1 });
pipeline.push({ id: 'aircraft-1', position: 2 });

expect(pipeline.take()).toEqual([{ id: 'aircraft-1', position: 2 }]);
expect(pipeline.stats).toMatchObject({ accepted: 2, coalesced: 1, queued: 0 });
```

Also write compile-only public-entry tests importing `DataPipeline`, `DataPipelineOptions`, `DataPipelineStats`, `DataPipelineCoalesce`, and `DataPipelineOverflow` from `@yanbobo/gis-sdk/core`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm vitest run tests/data-pipeline.test.ts`

Expected: the test fails because `data-pipeline.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal framework-neutral module**

```ts
export interface DataPipelineOptions<T> {
  readonly keyBy: (value: T) => string;
  readonly maxQueueItems?: number;
  readonly coalesce?: 'none' | 'latest';
  readonly overflow?: 'drop-oldest' | 'drop-newest' | 'keep-latest';
}

export class DataPipeline<T> {
  push(value: T): boolean;
  take(maxItems?: number): readonly T[];
  clear(): void;
  close(): void;
  get stats(): Readonly<DataPipelineStats>;
}
```

Defaults are `maxQueueItems: 1_000`, `coalesce: 'latest'`, and `overflow: 'keep-latest'`. Invalid keys, queue limits, and take limits throw structured `GisError`s. `push()` returns `false` only when the declared policy drops the incoming update; it returns `true` when an accepted update replaces an older queued update.

- [ ] **Step 4: Re-run the focused test and confirm GREEN**

Run: `pnpm vitest run tests/data-pipeline.test.ts`

Expected: PASS.

### Task 2: Make overflow and lifecycle behavior deterministic

**Files:**

- Modify: `tests/data-pipeline.test.ts`
- Modify: `src/core/data-pipeline.ts`

- [ ] **Step 1: Add one failing test per policy**

```ts
expect(dropOldest.take()).toEqual([{ id: 'b' }, { id: 'c' }]);
expect(dropNewest.push({ id: 'c' })).toBe(false);
expect(keepLatest.take()).toEqual([{ id: 'b' }, { id: 'c' }]);
```

Also verify `take(1)` preserves FIFO ordering of the remaining queue, `clear()` increments no drop counter, and `push()` / `take()` after `close()` throw `DATA_PIPELINE_CLOSED`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm vitest run tests/data-pipeline.test.ts`

Expected: a failure identifies the missing policy or terminal-state behavior.

- [ ] **Step 3: Implement only the observed behavior**

Maintain an insertion-ordered queue plus a key-to-index lookup only for `latest` coalescing. When full, apply exactly one policy:

- `drop-oldest`: remove the oldest queued item, increment `dropped`, enqueue the new one, return `true`;
- `drop-newest`: retain the queue, increment `dropped`, return `false`;
- `keep-latest`: replace an existing same-key item when possible; otherwise behave as `drop-oldest` so memory remains bounded.

Rebuild key lookup after `take()`, clear, and an oldest-item removal to avoid stale indexes.

- [ ] **Step 4: Re-run the focused test and confirm GREEN**

Run: `pnpm vitest run tests/data-pipeline.test.ts`

Expected: PASS.

### Task 3: Publish the contract and its usage guidance

**Files:**

- Create: `docs/guide/data-pipeline.md`
- Modify: `docs/.vitepress/config.mts`
- Modify: `docs/api.md`
- Modify: `docs/guide/api-reference.md`
- Modify: `docs/guide/capability-status.md`
- Modify: `README.md`

- [ ] **Step 1: Document a concrete dynamic-update flow**

```ts
const updates = new DataPipeline({
  keyBy: (value) => value.id,
  maxQueueItems: 2_000,
  coalesce: 'latest',
  overflow: 'keep-latest',
});

socket.onmessage = ({ data }) => updates.push(JSON.parse(data));

function renderFrame() {
  for (const update of updates.take(200)) {
    // A later renderer applies the normalized update to its owned Cesium objects.
  }
  requestAnimationFrame(renderFrame);
}
```

State clearly that this version supplies bounded ingestion and batching only. It does not parse arbitrary protocols, create Workers, mutate Cesium objects, select a render strategy, or establish benchmark-based scale guarantees.

- [ ] **Step 2: Change only verified capability rows**

Mark “Data pipeline core” as usable with its release version and entrypoints. Keep Worker execution, dynamic renderer, LOD, Primitive batches, browser benchmarks, diagnostics dashboard, and data-format adapters as unpublished.

### Task 4: Release verification and handoff

**Files:**

- Create: `.changeset/data-pipeline-core.md`
- Modify: `CHANGELOG.md` through `pnpm version-packages`
- Modify: `package.json` through `pnpm version-packages`

- [ ] **Step 1: Add a minor Changeset**

```markdown
---
'@yanbobo/gis-sdk': minor
---

增加框架无关的有界数据管线，支持最新值合并、溢出策略、批量读取和统计快照。
```

- [ ] **Step 2: Generate the next alpha version**

Run: `pnpm version-packages`

Expected: the next available `0.1.0-alpha.N` version is written to `package.json` and `CHANGELOG.md`.

- [ ] **Step 3: Run the release gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:build && pnpm pack:check && pnpm example:build`

Expected: all commands exit zero. Also run `git diff --check`, scan `src` for Cesium private fields, scan the repository for removed sensitive terms, and validate the commit message/version with `validate_delivery.py` before commit.
