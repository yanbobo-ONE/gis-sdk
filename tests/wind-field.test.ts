import { describe, expect, it } from 'vitest';

import { GisError } from '../src/core/errors.js';
import {
  advectWindParticles,
  buildWindField,
  createWindParticles,
  MAX_WIND_PARTICLES,
  sampleWind,
  windFieldBounds,
} from '../src/core/wind-field.js';
import type { WindParticle } from '../src/core/wind-field.js';

/** 3×3×2 的测试网格：经度 116..118（步长 1）、纬度 39..41（步长 1）、高度 0..1000（步长 1000）。 */
function gridAxes() {
  return {
    lon: { start: 116, step: 1, count: 3 },
    lat: { start: 39, step: 1, count: 3 },
    height: { start: 0, step: 1_000, count: 2 },
  };
}

function indexOf(x: number, y: number, z: number): number {
  return (z * 3 + y) * 3 + x;
}

/** 按给定函数在网格上铺平分量。 */
function fill(write: (x: number, y: number, z: number) => number): Float32Array {
  const values = new Float32Array(18);
  for (let z = 0; z < 2; z += 1) {
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        values[indexOf(x, y, z)] = write(x, y, z);
      }
    }
  }
  return values;
}

describe('buildWindField', () => {
  it('validates the grid and reports the maximum speed', () => {
    const field = buildWindField({
      axes: gridAxes(),
      u: fill((x) => x * 3),
      v: fill((y) => y),
      w: fill(() => 1),
    });

    expect(field.count).toBe(18);
    // 最大风速出现在 (x=2, y=2, z 任意)：u=6、v=2、w=1。
    expect(field.maxSpeed).toBeCloseTo(Math.hypot(6, 2, 1), 5);
    expect(Object.isFrozen(field)).toBe(true);
    expect(windFieldBounds(field)).toEqual({ west: 116, east: 118, south: 39, north: 41 });
  });

  it('rejects malformed grids', () => {
    const base = { axes: gridAxes(), u: fill(() => 1), v: fill(() => 1) };
    const cases: readonly (() => unknown)[] = [
      () => buildWindField({ ...base, u: new Float32Array(5) }),
      () =>
        buildWindField({
          ...base,
          axes: { ...gridAxes(), lon: { start: 116, step: 0, count: 3 } },
        }),
      () =>
        buildWindField({ ...base, axes: { ...gridAxes(), lat: { start: 39, step: 1, count: 1 } } }),
      () =>
        buildWindField({
          ...base,
          axes: { ...gridAxes(), height: { start: 0, step: 1, count: 2.5 } },
        }),
      () => {
        const broken = fill(() => 1);
        broken[7] = Number.NaN;
        return buildWindField({ ...base, v: broken });
      },
      () => buildWindField(undefined as never),
      () => buildWindField({ axes: undefined as never, u: base.u, v: base.v }),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    }
  });
});

describe('sampleWind', () => {
  it('returns constant fields exactly and interpolates linear fields', () => {
    const uniform = buildWindField({
      axes: gridAxes(),
      u: fill(() => 8),
      v: fill(() => -3),
      w: fill(() => 0.5),
    });
    const sample = sampleWind(uniform, { longitude: 116.5, latitude: 40.25, height: 400 });
    expect(sample?.east).toBeCloseTo(8, 6);
    expect(sample?.north).toBeCloseTo(-3, 6);
    expect(sample?.up).toBeCloseTo(0.5, 6);
    expect(sample?.speed).toBeCloseTo(Math.hypot(8, -3, 0.5), 6);

    // u 随经度线性增长：116.5° 处应为 1（角点值 0/2 的中值）。
    const ramp = buildWindField({ axes: gridAxes(), u: fill((x) => x * 2), v: fill(() => 0) });
    expect(sampleWind(ramp, { longitude: 116.5, latitude: 39, height: 0 })?.east).toBeCloseTo(1, 6);
    expect(sampleWind(ramp, { longitude: 117.25, latitude: 39, height: 0 })?.east).toBeCloseTo(
      2.5,
      6,
    );
    // 高度方向也插值：z 轴上 u 从 0 到 1（这里用 w 验证高度插值）。
    const vertical = buildWindField({
      axes: gridAxes(),
      u: fill(() => 0),
      v: fill(() => 0),
      w: fill((_x, _y, z) => z * 10),
    });
    expect(sampleWind(vertical, { longitude: 116, latitude: 39, height: 250 })?.up).toBeCloseTo(
      2.5,
      6,
    );
  });

  it('returns undefined outside the grid and tolerates a missing height', () => {
    const field = buildWindField({ axes: gridAxes(), u: fill(() => 1), v: fill(() => 1) });

    expect(sampleWind(field, { longitude: 115.9, latitude: 40, height: 0 })).toBeUndefined();
    expect(sampleWind(field, { longitude: 116.5, latitude: 41.5, height: 0 })).toBeUndefined();
    expect(sampleWind(field, { longitude: 116.5, latitude: 40, height: 5_000 })).toBeUndefined();
    // 高度缺省按 0 处理（在网格内）。
    expect(sampleWind(field, { longitude: 116.5, latitude: 40 })?.east).toBeCloseTo(1, 6);

    expect(() => sampleWind(field, { longitude: Number.NaN, latitude: 40 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('createWindParticles', () => {
  it('scatters particles inside the bounds deterministically', () => {
    const field = buildWindField({ axes: gridAxes(), u: fill(() => 1), v: fill(() => 1) });

    const first = createWindParticles(field, { count: 20, seed: 7 });
    const second = createWindParticles(field, { count: 20, seed: 7 });
    const other = createWindParticles(field, { count: 20, seed: 8 });

    expect(first).toHaveLength(20);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    for (const particle of first) {
      expect(particle.longitude).toBeGreaterThanOrEqual(116);
      expect(particle.longitude).toBeLessThanOrEqual(118);
      expect(particle.latitude).toBeGreaterThanOrEqual(39);
      expect(particle.latitude).toBeLessThanOrEqual(41);
      expect(particle.height).toBe(500); // 高度轴中点
      expect(particle.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(particle.ageSeconds).toBeLessThan(12);
    }
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('honours explicit height, bounds, and lifetime', () => {
    const field = buildWindField({ axes: gridAxes(), u: fill(() => 1), v: fill(() => 1) });
    const particles = createWindParticles(field, {
      count: 5,
      heightMeters: 800,
      lifetimeSeconds: 3,
      bounds: { west: 116.5, south: 39.5, east: 117, north: 40 },
    });
    for (const particle of particles) {
      expect(particle.height).toBe(800);
      expect(particle.longitude).toBeGreaterThanOrEqual(116.5);
      expect(particle.longitude).toBeLessThanOrEqual(117);
      expect(particle.ageSeconds).toBeLessThan(3);
    }
  });

  it('rejects invalid particle options', () => {
    const field = buildWindField({ axes: gridAxes(), u: fill(() => 1), v: fill(() => 1) });
    const cases: readonly (() => unknown)[] = [
      () => createWindParticles(field, { count: 0 }),
      () => createWindParticles(field, { count: MAX_WIND_PARTICLES + 1 }),
      () => createWindParticles(field, { count: 2.5 }),
      () => createWindParticles(field, { lifetimeSeconds: 0 }),
      () => createWindParticles(field, { seed: Number.NaN }),
      () => createWindParticles(field, { bounds: { west: 117, south: 39, east: 116, north: 40 } }),
      () => createWindParticles(field, { heightMeters: Number.POSITIVE_INFINITY }),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    }
  });
});

describe('advectWindParticles', () => {
  const field = buildWindField({
    axes: gridAxes(),
    u: fill(() => 10),
    v: fill(() => 0),
    w: fill(() => 2),
  });

  it('moves particles with the wind, ages them, and leaves the input untouched', () => {
    const particles = createWindParticles(field, { count: 3, seed: 3, heightMeters: 500 });
    const before = JSON.parse(JSON.stringify(particles)) as typeof particles;

    const next = advectWindParticles(field, particles, { deltaSeconds: 1 });

    expect(particles).toEqual(before); // 非破坏性
    expect(next).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      const particle = particles[index];
      const moved = next[index];
      expect(particle && moved).toBeTruthy();
      if (!particle || !moved) continue;
      // 向东 10 米/秒、1 秒：正东位移换算成经度增量。
      const expectedLon =
        particle.longitude + 10 / (111_195 * Math.cos((particle.latitude * Math.PI) / 180));
      expect(moved.longitude).toBeCloseTo(expectedLon, 6);
      expect(moved.latitude).toBeCloseTo(particle.latitude, 9);
      expect(moved.height).toBeCloseTo(particle.height + 2, 6);
      expect(moved.ageSeconds).toBeCloseTo(particle.ageSeconds + 1, 6);
    }
  });

  it('scales displacement with speedScale', () => {
    const particles = createWindParticles(field, { count: 1, seed: 4, heightMeters: 500 });
    const slow = advectWindParticles(field, particles, { deltaSeconds: 1, speedScale: 1 });
    const fast = advectWindParticles(field, particles, { deltaSeconds: 1, speedScale: 3 });
    const delta = (list: typeof slow): number =>
      (list[0]?.longitude ?? 0) - (particles[0]?.longitude ?? 0);
    expect(delta(fast)).toBeCloseTo(delta(slow) * 3, 9);
  });

  it('respawns particles that age out or leave the grid', () => {
    const aged = advectWindParticles(
      field,
      [{ longitude: 117, latitude: 40, height: 500, ageSeconds: 11.5 }],
      { deltaSeconds: 1, lifetimeSeconds: 12 },
    );
    expect(aged[0]?.ageSeconds).toBe(0);
    expect(aged[0]?.longitude).toBeGreaterThanOrEqual(116);

    // 向西 5 km/s（测试用的极端风）：一步就跨出网格，出界即重掷。
    const westward = buildWindField({
      axes: gridAxes(),
      u: fill(() => -5_000),
      v: fill(() => 0),
    });
    const escaped = advectWindParticles(
      westward,
      [{ longitude: 116.01, latitude: 40, height: 500, ageSeconds: 0 }],
      { deltaSeconds: 1 },
    );
    expect(escaped[0]?.ageSeconds).toBe(0);
    expect(escaped[0]?.longitude).toBeGreaterThanOrEqual(116);
  });

  it('is deterministic for a given state and seed', () => {
    const particles = createWindParticles(field, { count: 10, seed: 9, heightMeters: 500 });
    const first = advectWindParticles(field, particles, { deltaSeconds: 0.5, seed: 2 });
    const second = advectWindParticles(field, particles, { deltaSeconds: 0.5, seed: 2 });
    expect(first).toEqual(second);
  });

  it('conserves the orbit radius in a divergence-free circulating field', () => {
    // 刚体旋转场（u/v 与到中心的东向/北向距离成正比，散度为零）：粒子沿圆轨道走，半径守恒。
    // 只统计"持续平流"的粒子——重掷那一帧 ageSeconds 归零，位置本来就是随机瞬移，
    // 计入会把真实误差淹没在域尺寸里（这正是上一轮测出 4 千米漂移的原因）。
    const metersPerDegreeLatitude = (2 * Math.PI * 6_371_008.8) / 360;
    const metersPerDegreeLongitude = (latitude: number): number =>
      metersPerDegreeLatitude * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    const axes = {
      lon: { start: 116, step: 0.1, count: 21 },
      lat: { start: 39, step: 0.1, count: 21 },
      height: { start: 0, step: 1_000, count: 2 },
    };
    const center = { lon: 117, lat: 40 };
    const omega = 0.005;
    const cells = axes.lon.count * axes.lat.count * axes.height.count;
    const u = new Float32Array(cells);
    const v = new Float32Array(cells);
    for (let z = 0; z < axes.height.count; z += 1) {
      for (let y = 0; y < axes.lat.count; y += 1) {
        for (let x = 0; x < axes.lon.count; x += 1) {
          const lon = axes.lon.start + x * axes.lon.step;
          const lat = axes.lat.start + y * axes.lat.step;
          const index = (z * axes.lat.count + y) * axes.lon.count + x;
          u[index] = -omega * (lat - center.lat) * metersPerDegreeLatitude;
          v[index] = omega * (lon - center.lon) * metersPerDegreeLongitude(lat);
        }
      }
    }
    const vortex = buildWindField({ axes, u, v });
    const radiusOf = (particle: { longitude: number; latitude: number }): number =>
      Math.hypot(
        (particle.longitude - center.lon) * metersPerDegreeLongitude(particle.latitude),
        (particle.latitude - center.lat) * metersPerDegreeLatitude,
      );
    // 只保留内切圆里的粒子：纯旋转下它们不会跑出网格，省得被"出界重掷"干扰。
    const seeded = createWindParticles(vortex, {
      count: 200,
      seed: 5,
      heightMeters: 500,
      lifetimeSeconds: 1_000_000,
    }).filter((particle) => radiusOf(particle) <= 90_000);
    const initialRadius = seeded.map(radiusOf);
    const tracked = seeded.map(() => true);
    let current: readonly WindParticle[] = seeded;
    let driftSum = 0;
    let samples = 0;
    for (let step = 0; step < 200; step += 1) {
      const next = advectWindParticles(vortex, current, {
        deltaSeconds: 0.05,
        lifetimeSeconds: 1_000_000,
        seed: 5 + step,
      });
      next.forEach((particle, index) => {
        if (!tracked[index]) return;
        if (particle.ageSeconds === 0) {
          tracked[index] = false;
          return;
        }
        driftSum += Math.abs(radiusOf(particle) - (initialRadius[index] ?? 0));
        samples += 1;
      });
      current = next;
    }
    const trackedCount = tracked.filter(Boolean).length;
    const meanRadius =
      initialRadius.reduce((sum, radius) => sum + radius, 0) / initialRadius.length;
    expect(trackedCount).toBeGreaterThan(100);
    expect(samples).toBeGreaterThan(0);
    // 一阶欧拉会有 O(ω·Δt²) 的每步外扩；200 步后相对漂移应在 1% 以内。
    // 符号或经纬换算错位会让漂移量级远超它（一个分量错号即 ~5%）。
    expect(driftSum / samples / meanRadius).toBeLessThan(0.01);
  });

  it('rejects invalid options and malformed particles', () => {
    const cases: readonly (() => unknown)[] = [
      () => advectWindParticles(field, [], { deltaSeconds: 0 }),
      () => advectWindParticles(field, [], { deltaSeconds: 1, speedScale: 0 }),
      () => advectWindParticles(field, [], { deltaSeconds: 1, lifetimeSeconds: -1 }),
      () => advectWindParticles(field, [], { deltaSeconds: 1, seed: Number.NaN }),
      () => advectWindParticles(field, 'nope' as never, { deltaSeconds: 1 }),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    }
    expect(() => advectWindParticles(field, [], undefined as never)).toThrow(GisError);

    // 数组里混入坏值：当作"该重掷"，不抛错、不中断整帧。
    const mixed = advectWindParticles(
      field,
      [undefined as never, { longitude: Number.NaN } as never],
      {
        deltaSeconds: 1,
      },
    );
    expect(mixed).toHaveLength(2);
    expect(mixed.every((particle) => particle.ageSeconds === 0)).toBe(true);
  });
});
