# Data Pipeline Message Adapter Implementation Plan

**Goal:** Add a framework-neutral message input adapter that connects a Worker or MessagePort-like source to `DataPipeline` without making Worker lifecycle, transport protocols, or Cesium rendering part of the core SDK contract.

**Architecture:** `DataPipelineMessageAdapter<T>` owns only message listener registration, explicit start/stop/dispose lifecycle, application-supplied decoding, forwarding to the existing bounded pipeline, and immutable ingress statistics. The caller owns the Worker, MessagePort, WebSocket, protocol schema, and any resource termination. This keeps the public interface narrow while allowing the existing `DataPipeline` to remain the shared backpressure and coalescing module.

## Tasks

### 1. Public contract and behavior tests

- [x] Add a `DataPipelineMessageSource` structural interface for `message` listeners and optional `start()`.
- [x] Add an adapter with `start()`, `stop()`, `dispose()`, `state`, `stats`, and typed rejection/state events.
- [x] Write tests for forwarding, idempotent start/stop/dispose, listener cleanup, decode/pipeline failures, dropped inputs, and invalid configuration.

### 2. Public entrypoints and documentation

- [x] Export the adapter and types from the package root and `/core`.
- [x] Add a Worker/MessagePort example, parameter table, ownership boundary, errors, and observable effects.
- [x] Mark only the generic message input adapter available; keep Worker pools, WebSocket/SSE/CZML/binary protocol adapters, render scheduling, and performance guarantees unpublished.

### 3. Release verification

- [x] Add a prerelease changeset and generate the next alpha version.
- [x] Run tests, typecheck, lint, formatting, docs, packed-entry checks, isolated consumer build, sensitive-term scan, and Git delivery checks.
