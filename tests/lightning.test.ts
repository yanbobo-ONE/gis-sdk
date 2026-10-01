import { describe, expect, it } from 'vitest';

import { GisError } from '../src/core/errors.js';
import {
  createSeededRandom,
  generateLightningBolt,
  LightningFlashChannel,
  lightningEnvelope,
} from '../src/core/lightning.js';
import { measureDistance } from '../src/spatial/measure.js';

const ORIGIN = { longitude: 116.391, latitude: 39.907, height: 1_500 };

describe('createSeededRandom', () => {
  it('reproduces the same sequence for the same seed and differs across seeds', () => {
    const first = createSeededRandom(7);
    const second = createSeededRandom(7);
    const other = createSeededRandom(8);
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    expect(a).toEqual(b);
    expect(a).not.toEqual([other(), other(), other()]);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('lightningEnvelope', () => {
  it('peaks at the main flash and decays through pulses into afterglow', () => {
    // 主峰在 0.14 附近；包络始终落在 0 到 1。
    const samples = Array.from({ length: 101 }, (_, index) => lightningEnvelope(index / 100, 2));
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    const mainIndex = samples.indexOf(Math.max(...samples));
    expect(mainIndex / 100).toBeGreaterThan(0.1);
    expect(mainIndex / 100).toBeLessThan(0.2);
    expect(lightningEnvelope(0.14, 2)).toBeGreaterThan(0.9);
    // 预闪存在但弱于主峰。
    expect(lightningEnvelope(0, 2)).toBeGreaterThan(0.2);
    expect(lightningEnvelope(0, 2)).toBeLessThan(0.4);
    // 尾段回到余辉水平，且随脉冲次数增加出现次级峰。
    expect(lightningEnvelope(1, 2)).toBeLessThan(0.25);
    expect(lightningEnvelope(0.51, 3)).toBeGreaterThan(lightningEnvelope(0.51, 1));
  });

  it('clamps out-of-range phase and tolerates non-finite pulses', () => {
    expect(lightningEnvelope(-1, 2)).toBe(lightningEnvelope(0, 2));
    expect(lightningEnvelope(5, 2)).toBe(lightningEnvelope(1, 2));
    expect(lightningEnvelope(0.14, Number.NaN)).toBe(lightningEnvelope(0.14, 1));
  });
});

describe('LightningFlashChannel', () => {
  it('clamps published values and decays to zero', () => {
    const channel = new LightningFlashChannel();
    expect(channel.read()).toBe(0);

    channel.publish(0.5);
    expect(channel.read()).toBe(0.5);
    channel.publish(3);
    expect(channel.read()).toBe(1);
    channel.publish(-2);
    expect(channel.read()).toBe(0);
    channel.publish(Number.NaN);
    expect(channel.read()).toBe(0);

    channel.publish(1);
    channel.advance(0.25);
    expect(channel.read()).toBeCloseTo(0.6, 6);
    // 非正数与非有限值无副作用。
    channel.advance(0);
    channel.advance(-1);
    channel.advance(Number.NaN);
    expect(channel.read()).toBeCloseTo(0.6, 6);
    // 约 1 秒后回到零点。
    channel.advance(1);
    expect(channel.read()).toBe(0);

    channel.publish(0.8);
    channel.reset();
    expect(channel.read()).toBe(0);
  });
});

describe('generateLightningBolt', () => {
  it('reproduces the same shape for the same seed and changes with the seed', () => {
    const first = generateLightningBolt({ origin: ORIGIN, seed: 42 });
    const second = generateLightningBolt({ origin: ORIGIN, seed: 42 });
    const other = generateLightningBolt({ origin: ORIGIN, seed: 43 });

    expect(second).toEqual(first);
    expect(other.paths[0]?.points).not.toEqual(first.paths[0]?.points);
    expect(first.seed).toBe(42);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.paths)).toBe(true);
  });

  it('starts at the origin and ends at the target', () => {
    const target = { longitude: 116.4, latitude: 39.91, height: 0 };
    const shape = generateLightningBolt({ origin: ORIGIN, target });
    const trunk = shape.paths[0];

    expect(trunk?.kind).toBe('trunk');
    // 顶点经局部 ENU 往返换算，数值上一致但不再是同一个对象，按坐标断言。
    const first = trunk?.points[0];
    expect(first?.longitude).toBeCloseTo(ORIGIN.longitude, 9);
    expect(first?.latitude).toBeCloseTo(ORIGIN.latitude, 9);
    expect(first?.height).toBeCloseTo(ORIGIN.height, 6);
    const last = trunk?.points.at(-1);
    expect(last?.longitude).toBeCloseTo(target.longitude, 9);
    expect(last?.latitude).toBeCloseTo(target.latitude, 9);
    expect(last?.height).toBeCloseTo(target.height, 6);
  });

  it('honours the derived length and bearing when no target is given', () => {
    const shape = generateLightningBolt({
      origin: ORIGIN,
      lengthMeters: 4_000,
      bearingDegrees: 90,
      seed: 5,
    });
    const trunk = shape.paths[0]?.points ?? [];
    const end = trunk.at(-1);
    expect(end).toBeDefined();
    if (!end) {
      return;
    }
    const ground = { longitude: end.longitude, latitude: end.latitude, height: 0 };
    // 起点在地面投影处向东 4 km：距离与方位都可核对（局部 ENU 与球面距离差在 0.5% 内）。
    const from = { longitude: ORIGIN.longitude, latitude: ORIGIN.latitude, height: 0 };
    expect(measureDistance(from, ground).meters).toBeGreaterThan(3_980);
    expect(measureDistance(from, ground).meters).toBeLessThan(4_020);
    expect(ground.latitude).toBeCloseTo(ORIGIN.latitude, 4);
    expect(ground.longitude).toBeGreaterThan(ORIGIN.longitude);
    // 高度沿用起点（云底到地面只改水平位置）。
    expect(end.height).toBeCloseTo(ORIGIN.height, 6);
  });

  it('scales branch count with the density profile and keeps branches attached to the trunk', () => {
    const sparse = generateLightningBolt({ origin: ORIGIN, branches: 'sparse', seed: 3 });
    const dense = generateLightningBolt({ origin: ORIGIN, branches: 'dense', seed: 3 });

    expect(sparse.paths.filter((path) => path.kind === 'branch')).toHaveLength(2);
    expect(dense.paths.filter((path) => path.kind === 'branch')).toHaveLength(6);

    const trunkPoints = sparse.paths[0]?.points;
    for (const branch of sparse.paths.slice(1)) {
      expect(branch.points.length).toBeGreaterThanOrEqual(2);
      const root = branch.points[0];
      expect(root).toBeDefined();
      // 分支必须挂在主干节点上：与某个主干顶点的距离为零（段端抖动量恒为 0）。
      const attached = (trunkPoints ?? []).some((point) =>
        root === undefined ? false : measureDistance(point, root).meters < 1e-6,
      );
      expect(attached).toBe(true);
    }
  });

  it('keeps the trunk inside the vertex budget and jitter bounded', () => {
    const shape = generateLightningBolt({ origin: ORIGIN, trunkVertices: 60, seed: 11 });
    const trunk = shape.paths[0]?.points ?? [];
    expect(trunk.length).toBeGreaterThan(4);
    expect(trunk.length).toBeLessThanOrEqual(50);

    // 抖动的横向偏离不超过 320 米量级：逐点与起终点连线比较。
    const start = ORIGIN;
    for (const point of trunk) {
      expect(measureDistance(start, point).meters).toBeLessThan(6_000);
    }
  });

  it('supports waypoints and rejects invalid configuration', () => {
    const waypoint = { longitude: 116.395, latitude: 39.909, height: 900 };
    const shape = generateLightningBolt({ origin: ORIGIN, waypoints: [waypoint], seed: 1 });
    const trunk = shape.paths[0]?.points;
    // 途经点是段的连接点，抖动为 0，因此主干上应有一个顶点与它重合。
    expect((trunk ?? []).some((point) => measureDistance(point, waypoint).meters < 1e-6)).toBe(
      true,
    );

    expect(() => generateLightningBolt({ origin: ORIGIN, lengthMeters: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => generateLightningBolt({ origin: ORIGIN, trunkVertices: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => generateLightningBolt({ origin: ORIGIN, branches: 'storm' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => generateLightningBolt({ origin: { longitude: Number.NaN, latitude: 0 } })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() =>
      generateLightningBolt({
        origin: ORIGIN,
        waypoints: [{ longitude: 0, latitude: Number.POSITIVE_INFINITY }],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() => generateLightningBolt(undefined as never)).toThrow(GisError);
  });
});
