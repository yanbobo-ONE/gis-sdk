import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';

import {
  AttitudeDynamics,
  clusterPoints,
  ReplayTimeline,
  SimulationClock,
  convexHull,
  createTrackTimeline,
  czmlFromPositions,
  evaluateLineOfSight,
  evaluateHorizon,
  filterPointsInPolygon,
  headingPitchRollDegreesFromQuaternion,
  measureArea,
  measureDistance,
  normalizePositions,
  positionsFromCzml,
  quaternionFromHeadingPitchRollDegrees,
  simplifyPath,
  slerp,
  tracksFromCzml,
} from '@yanbobo/gis-sdk/core';

/**
 * 纯计算层的基准脚本。
 *
 * 只测**不依赖渲染引擎**的部分（空间计算、回放、姿态、CZML 解析、批处理），因此可以在
 * Node 里稳定复现；WebGL 端到端性能受设备与场景影响，不在本脚本范围。
 *
 * 运行：`pnpm bench`（需要先 `pnpm build`，脚本从 dist 导入，测的是发布产物）。
 */

const DURATION_MS = Number(process.env.BENCH_MS ?? 400);
const WARMUP_MS = 120;

/**
 * 一次测量：跑够时间，返回每秒操作数与单次耗时。
 *
 * `run(state)` 只做副作用，返回值被忽略——被测量的调用可能返回新对象（例如
 * `filterPointsInPolygon` 的结果），如果拿它当下一轮输入，测的就不是同一件事了。
 */
function measure(name, setup, run, unitsPerIteration = 1, unit = '次调用') {
  const state = setup();
  const warmupEnd = performance.now() + WARMUP_MS;
  while (performance.now() < warmupEnd) {
    run(state);
  }
  let iterations = 0;
  const start = performance.now();
  let elapsed = performance.now() - start;
  while (elapsed < DURATION_MS) {
    for (let index = 0; index < 25; index += 1) {
      run(state);
    }
    iterations += 25;
    elapsed = performance.now() - start;
  }
  const operations = iterations * unitsPerIteration;
  const perSecond = operations / (elapsed / 1000);
  // 每次调用耗时按"调用"算，吞吐量按"单位"算（名称里写清了单位是什么）。
  const perCallMs = elapsed / iterations;
  return { name, perSecond, perCallMs, unit };
}

function format(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} k`;
  return value.toFixed(0);
}

// 结果只用于最后汇总打印，保留引用便于后续扩展成 JSON 输出。
const results = [];
void results;
const record = (entry) => {
  results.push(entry);
  const call =
    entry.perCallMs >= 1
      ? `${entry.perCallMs.toFixed(2).padStart(9)} ms/调用`
      : `${(entry.perCallMs * 1000).toFixed(2).padStart(9)} µs/调用`;
  process.stdout.write(
    `${entry.name.padEnd(42)} ${call}   ${format(entry.perSecond).padStart(9)} ${entry.unit}/s\n`,
  );
};

process.stdout.write(`\n# gis-sdk 纯计算基准\n`);
process.stdout.write(`# 时长 ${String(DURATION_MS)} ms/项，预热 ${String(WARMUP_MS)} ms\n\n`);

// ── 量算与判断 ────────────────────────────────────────────────────────────────
const beijing = { longitude: 116.39, latitude: 39.9 };
const shanghai = { longitude: 121.47, latitude: 31.23 };

record(
  measure('measureDistance（跨城两点）', () => null, () => measureDistance(beijing, shanghai)),
);

const square = [
  { longitude: 116.3, latitude: 39.8 },
  { longitude: 116.5, latitude: 39.8 },
  { longitude: 116.5, latitude: 40.0 },
  { longitude: 116.3, latitude: 40.0 },
];
record(measure('measureArea（四边形）', () => null, () => measureArea(square)));

const polygon = { outer: square };
const cityPoints = Array.from({ length: 10_000 }, (_, index) => ({
  longitude: 116.3 + ((index % 100) / 100) * 0.2,
  latitude: 39.8 + (Math.floor(index / 100) / 100) * 0.2,
}));
record(
  measure(
    'filterPointsInPolygon（1 万点）',
    () => cityPoints,
    (points) => filterPointsInPolygon(points, polygon),
    10_000,
    '点',
  ),
);

// ── 几何构造与抽稀 ────────────────────────────────────────────────────────────
const cloud = Array.from({ length: 2_000 }, (_, index) => ({
  longitude: ((index * 37) % 360) - 180,
  latitude: ((index * 53) % 170) - 85,
}));
record(measure('convexHull（2 千点）', () => cloud, (points) => convexHull(points), 2_000, '点'));

const track = Array.from({ length: 5_000 }, (_, index) => ({
  longitude: 116 + index * 0.0001,
  latitude: 39.9 + Math.sin(index / 50) * 0.001,
}));
record(
  measure('simplifyPath（5 千顶点，10 米容差）', () => track, (points) => simplifyPath(points, 10), 5_000, '顶点'),
);

const clusteredPoints = Array.from({ length: 50_000 }, (_, index) => ({
  longitude: 116 + ((index * 7) % 500) * 0.0005,
  latitude: 39.9 + ((index * 13) % 500) * 0.0005,
}));
record(
  measure(
    'clusterPoints（5 万点，1 公里网格）',
    () => clusteredPoints,
    (points) => clusterPoints(points, { cellSizeMeters: 1_000 }),
    50_000,
    '点',
  ),
);

// ── 地形剖面判据 ─────────────────────────────────────────────────────────────
const profile = Array.from({ length: 64 }, (_, index) => ({
  distanceMeters: (index + 1) * 100,
  heightMeters: Math.sin(index / 8) * 40,
}));
record(
  measure('evaluateLineOfSight（64 个剖面点）', () => profile, (points) =>
    evaluateLineOfSight({
      fromHeightMeters: 100,
      toHeightMeters: 120,
      distanceMeters: 6_500,
      profile: points,
    }),
  ),
);
record(
  measure('evaluateHorizon（32 个剖面点）', () => profile.slice(0, 32), (points) =>
    evaluateHorizon({ observerHeightMeters: 100, profile: points }),
  ),
);

// ── 姿态 ─────────────────────────────────────────────────────────────────────
const attitude = quaternionFromHeadingPitchRollDegrees({ heading: 45, pitch: -20, roll: 10 });
const otherAttitude = quaternionFromHeadingPitchRollDegrees({ heading: 200, pitch: 30, roll: -15 });
record(
  measure('slerp（两姿态之间）', () => 0, (index) => {
    slerp(attitude, otherAttitude, ((index % 100) + 0.5) / 100);
  }),
);
record(
  measure('headingPitchRollDegreesFromQuaternion', () => attitude, (value) =>
    headingPitchRollDegreesFromQuaternion(value),
  ),
);
record(
  measure('AttitudeDynamics.advance（10 ms 步长）', () => new AttitudeDynamics(), (dynamics) => {
    dynamics.setAngularVelocity({ x: 0, y: 0, z: Math.PI });
    dynamics.advance(0.01);
  }),
);

// ── 回放与时钟 ────────────────────────────────────────────────────────────────
const timelineSamples = Array.from({ length: 600 }, (_, index) => ({ time: index, x: index }));
record(
  measure('ReplayTimeline.sampleAt（600 样本，二分）', () => {
    const timeline = new ReplayTimeline({ interpolate: (a, b, ratio) => ({ time: a.time + ratio, x: a.x + ratio }) });
    timeline.addSamples('track', timelineSamples);
    return { timeline, index: 0 };
  }, (state) => {
    state.timeline.sampleAt('track', (state.index % 600) + 0.5);
    state.index += 1;
  }),
);
record(
  measure('SimulationClock.advance', () => new SimulationClock({ startTime: 0, endTime: 1e9 }), (clock) => {
    clock.advance(16);
  }),
);

// ── 数据准备 ─────────────────────────────────────────────────────────────────
const rawPositions = Array.from({ length: 10_000 }, (_, index) => ({
  id: `p-${String(index)}`,
  position: { longitude: 116 + index * 1e-4, latitude: 39.9 },
  timestamp: index,
}));
record(
  measure(
    'normalizePositions（1 万条 → Float64Array）',
    () => rawPositions,
    (input) => normalizePositions(input),
    10_000,
    '条',
  ),
);

// ── CZML ─────────────────────────────────────────────────────────────────────
const orbitPositions = Array.from({ length: 600 }, (_, index) => ({
  longitude: 116 + index * 0.01,
  latitude: 39.9,
  height: 500_000,
}));
const document = czmlFromPositions('sat-1', orbitPositions, { intervalSeconds: 5, model: { url: 'a.glb' } });
record(
  measure(
    'czmlFromPositions（600 个采样点）',
    () => orbitPositions,
    (points) => czmlFromPositions('sat-1', points, { intervalSeconds: 5 }),
    600,
    '采样点',
  ),
);
record(
  measure('positionsFromCzml（600 个采样点）', () => document, (input) => positionsFromCzml(input), 600, '采样点'),
);
record(
  measure('tracksFromCzml（含 model 与姿态）', () => document, (input) => tracksFromCzml(input), 600, '采样点'),
);

const tracks = tracksFromCzml(document);
record(
  measure('createTrackTimeline（600 个采样点）', () => tracks[0], (entry) => createTrackTimeline(entry), 600, '采样点'),
);

// ── 汇总 ─────────────────────────────────────────────────────────────────────
process.stdout.write(`\n## 环境\n\n`);
process.stdout.write(`- 平台：${process.platform} ${process.arch}，Node ${process.version}\n`);
const cpu = cpus()[0];
process.stdout.write(`- CPU：${cpu ? cpu.model.trim() : 'unknown'}\n`);
process.stdout.write(`- 内存：${(totalmem() / 1024 ** 3).toFixed(1)} GiB\n\n`);
