import { describe, expect, it } from 'vitest';

import { AttitudeDynamics } from '../src/spatial/attitude.js';
import { calculateOrbitalElements, EARTH_MU, propagateTwoBody } from '../src/spatial/orbit.js';
import type { OrbitState } from '../src/spatial/orbit.js';

const EARTH_RADIUS = 6_378_137;

/** 高度 500 km 的圆轨道，位于赤道面内、绕 +Z 轴运动。 */
function circularState(altitude = 500_000): OrbitState {
  const r = EARTH_RADIUS + altitude;
  return {
    position: { x: r, y: 0, z: 0 },
    velocity: { x: 0, y: Math.sqrt(EARTH_MU / r), z: 0 },
  };
}

describe('calculateOrbitalElements', () => {
  it('recovers circular equatorial elements and the period', () => {
    const state = circularState();
    const elements = calculateOrbitalElements(state);
    const r = EARTH_RADIUS + 500_000;

    expect(elements.semiMajorAxis).toBeCloseTo(r, 3);
    expect(elements.eccentricity).toBeCloseTo(0, 9);
    expect(elements.inclination).toBeCloseTo(0, 9);
    // 赤道圆轨道：无定义的角按 0 返回，不会出现 NaN。
    expect(elements.ascendingNode).toBe(0);
    expect(elements.argumentOfPeriapsis).toBe(0);
    expect(Number.isNaN(elements.trueAnomaly)).toBe(false);
    // 周期 = 2π√(a³/μ)。
    expect(elements.periodSeconds).toBeCloseTo(2 * Math.PI * Math.sqrt(r ** 3 / EARTH_MU), 6);
    expect(elements.periodSeconds / 60).toBeCloseTo(94.6, 1);
  });

  it('recovers inclination and node for an inclined orbit', () => {
    const speed = Math.sqrt(EARTH_MU / (EARTH_RADIUS + 700_000));
    const inclination = Math.PI / 4;
    const state: OrbitState = {
      position: { x: EARTH_RADIUS + 700_000, y: 0, z: 0 },
      velocity: {
        x: 0,
        y: speed * Math.cos(inclination),
        z: speed * Math.sin(inclination),
      },
    };

    const elements = calculateOrbitalElements(state);
    expect(elements.inclination).toBeCloseTo(inclination, 9);
    expect(elements.eccentricity).toBeCloseTo(0, 8);
  });

  it('rejects degenerate, non-finite, and escape states', () => {
    expect(() =>
      calculateOrbitalElements({ position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));

    expect(() =>
      calculateOrbitalElements({
        position: { x: EARTH_RADIUS, y: 0, z: 0 },
        velocity: { x: 1_000, y: 0, z: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));

    expect(() =>
      calculateOrbitalElements({
        position: { x: Number.NaN, y: 0, z: 0 },
        velocity: { x: 0, y: 7_000, z: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));

    // 逃逸轨道：比能量非负。
    expect(() =>
      calculateOrbitalElements(
        { position: { x: EARTH_RADIUS, y: 0, z: 0 }, velocity: { x: 0, y: 20_000, z: 0 } },
        EARTH_MU,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));

    expect(() => calculateOrbitalElements(circularState(), 0)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('propagateTwoBody', () => {
  it('returns to the same position after one period', () => {
    const state = circularState();
    const period = calculateOrbitalElements(state).periodSeconds;
    const next = propagateTwoBody(state, period);

    expect(next.position.x).toBeCloseTo(state.position.x, 3);
    expect(next.position.y).toBeCloseTo(state.position.y, 3);
    expect(next.position.z).toBeCloseTo(state.position.z, 3);
    expect(next.velocity.x).toBeCloseTo(state.velocity.x, 6);
    expect(next.velocity.y).toBeCloseTo(state.velocity.y, 6);
  });

  it('moves to the opposite side after half a period', () => {
    const state = circularState();
    const period = calculateOrbitalElements(state).periodSeconds;
    const next = propagateTwoBody(state, period / 2);

    expect(next.position.x).toBeCloseTo(-state.position.x, 3);
    expect(next.position.y).toBeCloseTo(0, 3);
    expect(next.velocity.y).toBeCloseTo(-state.velocity.y, 6);
  });

  it('propagates backwards and keeps the radius for a circular orbit', () => {
    const state = circularState();
    const back = propagateTwoBody(state, -60);
    expect(Math.hypot(back.position.x, back.position.y, back.position.z)).toBeCloseTo(
      Math.hypot(state.position.x, state.position.y, state.position.z),
      3,
    );
  });

  it('handles eccentric orbits and rejects invalid time', () => {
    // 近地点 300 km、远地点 1200 km 的椭圆轨道。
    const perigee = EARTH_RADIUS + 300_000;
    const apogee = EARTH_RADIUS + 1_200_000;
    const semiMajorAxis = (perigee + apogee) / 2;
    const speedAtPerigee = Math.sqrt(EARTH_MU * (2 / perigee - 1 / semiMajorAxis));
    const state: OrbitState = {
      position: { x: perigee, y: 0, z: 0 },
      velocity: { x: 0, y: speedAtPerigee, z: 0 },
    };

    const elements = calculateOrbitalElements(state);
    expect(elements.eccentricity).toBeGreaterThan(0);
    expect(elements.eccentricity).toBeLessThan(1);

    const atApogee = propagateTwoBody(state, elements.periodSeconds / 2);
    expect(Math.hypot(atApogee.position.x, atApogee.position.y, atApogee.position.z)).toBeCloseTo(
      apogee,
      2,
    );

    expect(() => propagateTwoBody(state, Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('AttitudeDynamics', () => {
  it('integrates a constant angular velocity and stays normalized', () => {
    const attitude = new AttitudeDynamics();
    attitude.setAngularVelocity({ x: 0, y: 0, z: Math.PI });

    // 一阶积分在大步长下会低估转角，因此用 0.01s 小步长累计 1 秒：
    // 绕 Z 轴 π rad/s 转 1 秒等价于 180° 旋转，结果应逼近 (0, 0, ±1, 0)。
    for (let step = 0; step < 100; step += 1) {
      attitude.advance(0.01);
    }
    const after = attitude.attitude;
    expect(Math.abs(after.w)).toBeLessThan(0.01);
    expect(Math.abs(after.z)).toBeCloseTo(1, 2);
    expect(Math.hypot(after.x, after.y, after.z, after.w)).toBeCloseTo(1, 12);

    // 每一步都重新归一化：长时间累计不会漂移。
    for (let step = 0; step < 1_000; step += 1) {
      attitude.advance(0.01);
    }
    const drifted = attitude.attitude;
    expect(Math.hypot(drifted.x, drifted.y, drifted.z, drifted.w)).toBeCloseTo(1, 12);
  });

  it('keeps a tiny step close to identity and normalizes inputs', () => {
    const attitude = new AttitudeDynamics({ x: 0, y: 0, z: 0, w: 2 });
    // 构造时归一化：w=2 → 1。
    expect(attitude.attitude).toEqual({ x: 0, y: 0, z: 0, w: 1 });

    attitude.setAngularVelocity({ x: 0.1, y: 0, z: 0 });
    const after = attitude.advance(0.001);
    expect(Math.hypot(after.x, after.y, after.z, after.w)).toBeCloseTo(1, 12);
    expect(Math.abs(after.x)).toBeLessThan(0.001);
  });

  it('rejects invalid attitudes, velocities, and time steps', () => {
    expect(() => new AttitudeDynamics({ x: 0, y: 0, z: 0, w: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => new AttitudeDynamics({ x: 0, y: 0, z: 0, w: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );

    const attitude = new AttitudeDynamics();
    expect(() => {
      attitude.setAngularVelocity({ x: 0, y: Number.NaN, z: 0 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() => attitude.advance(-1)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => attitude.advance(Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
