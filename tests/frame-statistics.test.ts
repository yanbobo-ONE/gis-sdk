import { beforeEach, describe, expect, it } from 'vitest';

import { FrameStatistics } from '../src/core/frame-statistics.js';
import { RenderQualityMonitor } from '../src/core/quality.js';
import { qualityProfiles } from '../src/core/quality.js';

describe('FrameStatistics', () => {
  let frames: FrameStatistics;

  beforeEach(() => {
    frames = new FrameStatistics({ windowSize: 20, longFrameMs: 50 });
  });

  it('reports zeroed readings for an empty window', () => {
    expect(frames.snapshot).toEqual({
      samples: 0,
      averageMs: 0,
      fps: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      longFrames: 0,
      longFrameRatio: 0,
    });
  });

  it('separates a steady window from one with a hitch', () => {
    // 20 帧 16 毫秒：平均、分位数、最长帧都是 16 毫秒。
    for (let index = 0; index < 20; index += 1) {
      frames.push(16);
    }
    const steady = frames.snapshot;
    expect(steady.samples).toBe(20);
    expect(steady.p50Ms).toBe(16);
    expect(steady.p95Ms).toBe(16);
    expect(steady.maxMs).toBe(16);
    expect(steady.longFrames).toBe(0);
    expect(steady.longFrameRatio).toBe(0);

    // 同样的 20 帧里有一帧卡到 200 毫秒：平均值只涨到 25 毫秒（仍有 40 fps），
    // 而且这一帧落在窗口 5% 之外，P95 仍然是 16 —— 只看平均或只看 P95 都发现不了它，
    // 要靠最长帧与长帧计数才暴露。
    frames.reset();
    for (let index = 0; index < 19; index += 1) {
      frames.push(16);
    }
    frames.push(200);
    const hitched = frames.snapshot;
    expect(hitched.averageMs).toBeCloseTo(25.2, 5);
    expect(hitched.fps).toBeCloseTo(1000 / 25.2, 5);
    expect(hitched.p50Ms).toBe(16);
    expect(hitched.p95Ms).toBe(16);
    expect(hitched.maxMs).toBe(200);
    expect(hitched.longFrames).toBe(1);
    expect(hitched.longFrameRatio).toBeCloseTo(0.05, 5);

    // 卡顿帧占到窗口 5% 以上（20 帧里的 2 帧）时，P95 才会跟着抬起来。
    frames.push(200);
    const repeated = frames.snapshot;
    expect(repeated.longFrames).toBe(2);
    expect(repeated.p95Ms).toBe(200);
  });

  it('uses nearest-rank percentiles so every reported value is a real frame', () => {
    // 1 到 20 毫秒各一帧：P50 取第 10 个样本（10 毫秒），P95 取第 19 个（19 毫秒）。
    for (let index = 1; index <= 20; index += 1) {
      frames.push(index);
    }
    const snapshot = frames.snapshot;
    expect(snapshot.p50Ms).toBe(10);
    expect(snapshot.p95Ms).toBe(19);
    expect(snapshot.maxMs).toBe(20);
    // 分位数一定是样本里出现过的值，不会是插值出来的中间数。
    expect([...Array(20).keys()].map((index) => index + 1)).toContain(snapshot.p50Ms);
    expect([...Array(20).keys()].map((index) => index + 1)).toContain(snapshot.p95Ms);
  });

  it('keeps only the newest window of frames', () => {
    for (let index = 0; index < 25; index += 1) {
      frames.push(10);
    }
    expect(frames.snapshot.samples).toBe(20);

    // 前 5 帧被挤出窗口：灌入 5 帧慢帧后，慢帧全部留在窗口里。
    frames.reset();
    for (let index = 0; index < 20; index += 1) {
      frames.push(10);
    }
    for (let index = 0; index < 5; index += 1) {
      frames.push(100);
    }
    const snapshot = frames.snapshot;
    expect(snapshot.samples).toBe(20);
    expect(snapshot.longFrames).toBe(5);
    expect(snapshot.maxMs).toBe(100);
    expect(snapshot.p50Ms).toBe(10);
  });

  it('drops non-positive and non-finite frame times', () => {
    frames.push(Number.NaN);
    frames.push(Number.POSITIVE_INFINITY);
    frames.push(0);
    frames.push(-16);

    expect(frames.snapshot.samples).toBe(0);

    frames.push(16);
    expect(frames.snapshot.samples).toBe(1);
  });

  it('rejects invalid configuration', () => {
    expect(() => new FrameStatistics({ windowSize: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_FRAME_STATISTICS_CONFIG', module: 'frames' }),
    );
    expect(() => new FrameStatistics({ windowSize: 1.5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_FRAME_STATISTICS_CONFIG' }),
    );
    expect(() => new FrameStatistics({ longFrameMs: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_FRAME_STATISTICS_CONFIG' }),
    );
  });
});

describe('RenderQualityMonitor frame percentiles', () => {
  it('exposes the same window statistics alongside the average', () => {
    const monitor = new RenderQualityMonitor({
      initial: qualityProfiles.default,
      adaptive: false,
      longFrameMs: 50,
    });

    // 首次采样只记时间戳、不产生帧耗时，因此 N 次调用得到 N-1 帧。
    let timestamp = 0;
    for (let index = 0; index < 31; index += 1) {
      timestamp += 16;
      monitor.sample(timestamp);
    }
    const steady = monitor.getSnapshot();
    expect(steady.sampleCount).toBe(30);
    expect(steady.frameTimeMs).toBeCloseTo(16, 5);
    expect(steady.frameTimeP50Ms).toBe(16);
    expect(steady.frameTimeP95Ms).toBe(16);
    expect(steady.frameTimeMaxMs).toBe(16);
    expect(steady.longFrames).toBe(0);

    // 一次 80 毫秒的顿挫：没到停滞阈值（250 毫秒）不会被丢窗口，只记账。
    timestamp += 80;
    const hitched = monitor.sample(timestamp);
    expect(hitched.sampleCount).toBe(31);
    expect(hitched.longFrames).toBe(1);
    expect(hitched.frameTimeMaxMs).toBe(80);
    // 平均帧耗时仍被摊平在 20 毫秒以内，光看平均值看不出这次顿挫。
    expect(hitched.frameTimeMs).toBeLessThan(20);
    expect(hitched.fps).toBeGreaterThan(50);
  });

  it('zeroes the percentile readings when a stall resets the window', () => {
    const monitor = new RenderQualityMonitor({
      initial: qualityProfiles.default,
      adaptive: false,
    });

    let timestamp = 0;
    for (let index = 0; index < 13; index += 1) {
      timestamp += 16;
      monitor.sample(timestamp);
    }
    expect(monitor.getSnapshot().sampleCount).toBe(12);

    // 超过停滞阈值：窗口重置，只留下这一帧的瞬时读数。
    timestamp += 400;
    const stalled = monitor.sample(timestamp);
    expect(stalled.sampleCount).toBe(0);
    expect(stalled.frameTimeMs).toBe(400);
    expect(stalled.frameTimeP50Ms).toBe(0);
    expect(stalled.frameTimeP95Ms).toBe(0);
    expect(stalled.frameTimeMaxMs).toBe(0);
    expect(stalled.longFrames).toBe(0);
    expect(stalled.longFrameRatio).toBe(0);
  });
});
