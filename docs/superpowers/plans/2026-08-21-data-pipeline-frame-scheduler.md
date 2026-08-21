# Data Pipeline Frame Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a framework-neutral frame-budget scheduler that consumes existing `DataPipeline` values in bounded animation-frame batches without causing one render request per incoming message.

**Architecture:** `DataPipelineFrameScheduler<T>` owns one pending animation-frame callback, per-frame batch size, callback invocation, cancellation, state, and frozen accounting. The application owns the `DataPipeline`, input adapters, Cesium objects, and error recovery for consumed batches. A small `DataPipelineFrameClock` seam uses browser `requestAnimationFrame` by default and permits a host-provided clock for tests, SSR, or alternate runtimes.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 6, Vitest, TypeDoc, VitePress, Changesets.

---

## File Structure

```text
src/
├── core/
│   ├── data-pipeline-frame-scheduler.ts
│   ├── data-pipeline-message-adapter.ts
│   └── errors.ts
└── entries/
    └── core.ts
tests/
├── data-pipeline-frame-scheduler.test.ts
├── entrypoints.test.ts
└── public-api.test.ts
docs/
└── guide/
    ├── data-pipeline.md
    ├── api-reference.md
    └── capability-status.md
```

### Task 1: Establish bounded frame behavior with failing tests

**Files:**

- Create: `tests/data-pipeline-frame-scheduler.test.ts`

- [x] **Step 1: Write a deterministic clock fake and coalescing test**

```ts
const scheduler = new DataPipelineFrameScheduler({
  pipeline,
  maxItemsPerFrame: 2,
  onBatch: render,
  clock,
});

scheduler.request();
scheduler.request();
expect(clock.request).toHaveBeenCalledOnce();

clock.fireNext();
expect(render).toHaveBeenCalledWith([{ id: 'a' }, { id: 'b' }]);
```

The fake clock stores callbacks by numeric ID and exposes `fireNext()` so the test never depends on browser timing.

- [x] **Step 2: Add behavioral edge-case tests**

Test: automatic follow-up frame while the pipeline retains values; `cancel()` preserving queued values; `dispose()` detaching a pending frame without closing caller-owned pipeline; a consumer exception emitting `frame:failed` and not auto-rescheduling; invalid configuration; and a no-clock host rejecting `request()` with a stable unavailable error.

- [x] **Step 3: Run the focused test and verify RED**

Run: `pnpm vitest run tests/data-pipeline-frame-scheduler.test.ts`

Expected: FAIL because the scheduler module does not exist.

### Task 2: Implement the minimal scheduler module

**Files:**

- Create: `src/core/data-pipeline-frame-scheduler.ts`
- Modify: `src/core/errors.ts`

- [x] **Step 1: Add public contract types**

```ts
export interface DataPipelineFrameClock {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface DataPipelineFrameSchedulerOptions<T> {
  readonly pipeline: DataPipeline<T>;
  readonly onBatch: (values: readonly T[]) => void;
  readonly maxItemsPerFrame?: number;
  readonly clock?: DataPipelineFrameClock;
}
```

Also define `DataPipelineFrameSchedulerState`, frozen stats, and `state:changed` / `frame:completed` / `frame:failed` events.

- [x] **Step 2: Add stable errors and lifecycle methods**

Add `INVALID_DATA_PIPELINE_FRAME_SCHEDULER_CONFIG`, `DATA_PIPELINE_FRAME_SCHEDULER_DISPOSED`, and `DATA_PIPELINE_FRAME_SCHEDULER_UNAVAILABLE` to `GisErrorCode`. Implement `request()`, `cancel()`, and `dispose()` with idempotent behavior. `request()` must coalesce multiple calls while a frame is already scheduled and must not run in the constructor.

- [x] **Step 2a: Emit successful message ingress from the message adapter**

Modify `src/core/data-pipeline-message-adapter.ts` and
`tests/data-pipeline-message-adapter.test.ts` to add:

```ts
'message:accepted': {
  /** The raw payload that decoded and entered the pipeline. */
  readonly data: unknown;
};
```

Emit it only after `pipeline.push(value)` returns `true`. This gives callers a protocol-neutral place to invoke `scheduler.request()` after an update actually enters the bounded queue; it does not expose or retain the decoded value.

- [x] **Step 3: Consume at most one bounded batch per frame**

```ts
const values = pipeline.take(maxItemsPerFrame);
if (values.length === 0) return;
onBatch(values);
if (pipeline.stats.queued > 0) request();
```

If `onBatch` or `pipeline.take()` throws, increment failure statistics, emit `frame:failed`, and leave follow-up scheduling to the caller. The batch has already been consumed before `onBatch` runs; document this transaction boundary.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run tests/data-pipeline-frame-scheduler.test.ts`

Expected: PASS.

### Task 3: Publish only the verified frame-budget contract

**Files:**

- Modify: `src/entries/core.ts`
- Modify: `src/core/data-pipeline-message-adapter.ts`
- Modify: `tests/data-pipeline-message-adapter.test.ts`
- Modify: `tests/entrypoints.test.ts`
- Modify: `tests/public-api.test.ts`
- Modify: `docs/guide/data-pipeline.md`
- Modify: `docs/guide/api-reference.md`
- Modify: `docs/guide/capability-status.md`
- Modify: `docs/api.md`
- Modify: `docs/index.md`
- Modify: `README.md`

- [x] **Step 1: Export and compile-check the core entrypoint**

Export `DataPipelineFrameScheduler` and all contract types from `/core` and the package root. Compile-only tests must import the scheduler from both public entrypoints.

- [x] **Step 2: Add a runnable use example and parameter table**

```ts
const scheduler = new DataPipelineFrameScheduler({
  pipeline: updates,
  maxItemsPerFrame: 200,
  onBatch(values) {
    for (const value of values) applyUpdate(value);
    map.raw.viewer.scene.requestRender();
  },
});

input.events.on('message:accepted', () => scheduler.request());
```

Document the actual supported methods, defaults, frame coalescing, automatic follow-up frames, `cancel()` / `dispose()` ownership, and the consumed-before-callback failure boundary.

- [x] **Step 3: Keep unverified capabilities unpublished**

Mark only a generic frame-budget scheduler usable. Continue to list Worker pools, protocol adapters, renderer selection, Primitive/Collection batching, automatic LOD, browser benchmarks, and performance scale guarantees as unpublished.

### Task 4: Release verification and delivery

**Files:**

- Create: `.changeset/data-pipeline-frame-scheduler.md`
- Modify: `CHANGELOG.md` through `pnpm version-packages`
- Modify: `package.json` through `pnpm version-packages`

- [x] **Step 1: Add a minor prerelease changeset**

```markdown
---
'@yanbobo/gis-sdk': minor
---

增加有界数据管线的帧预算调度器，支持请求合并、批量消费、取消和调度统计。
```

- [x] **Step 2: Generate the next alpha version**

Run: `pnpm version-packages`

Expected: `package.json` and `CHANGELOG.md` advance to the next `0.1.0-alpha.N` prerelease.

- [x] **Step 3: Run the release gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:build && pnpm pack:check && pnpm example:build`

Then run `git diff --check`, scan the repository for removed sensitive terms, validate the commit message/version, push normally, fetch, and prove the remote contains the commit.
