import { describe, expect, it } from 'vitest';

import { czmlFromPositions, czmlFromSamples, positionsFromCzml } from '../src/core/czml.js';

const beijing = { longitude: 116.39, latitude: 39.9, height: 500_000 };
const shanghai = { longitude: 121.47, latitude: 31.23, height: 500_000 };

describe('czmlFromPositions', () => {
  it('writes a document and a sampled entity packet', () => {
    const document = czmlFromPositions('sat-1', [beijing, shanghai], {
      epoch: '2026-09-30T00:00:00Z',
      intervalSeconds: 10,
      name: '卫星一号',
    });

    expect(document).toHaveLength(2);
    expect(document[0]).toMatchObject({
      id: 'document',
      version: '1.0',
      clock: {
        interval: '2026-09-30T00:00:00.000Z/2026-09-30T00:00:10.000Z',
        currentTime: '2026-09-30T00:00:00.000Z',
      },
    });
    expect(document[1]).toMatchObject({
      id: 'sat-1',
      name: '卫星一号',
      position: {
        epoch: '2026-09-30T00:00:00Z',
        cartographicDegrees: [0, 116.39, 39.9, 500_000, 10, 121.47, 31.23, 500_000],
      },
      availability: '2026-09-30T00:00:00.000Z/2026-09-30T00:00:10.000Z',
    });
  });

  it('writes a static position for a single point and can omit availability', () => {
    const document = czmlFromPositions('station', [beijing], { availability: false });

    // 单点：没有时钟，也没有 availability。
    expect(document[0]).toEqual({ id: 'document', version: '1.0' });
    expect(document[1]).toEqual({
      id: 'station',
      position: { epoch: '1970-01-01T00:00:00Z', cartographicDegrees: [116.39, 39.9, 500_000] },
    });
  });

  it('honours interval, start seconds, and height defaults', () => {
    const document = czmlFromPositions(
      'track',
      [
        { longitude: 1, latitude: 2 },
        { longitude: 3, latitude: 4 },
      ],
      { intervalSeconds: 2.5, startSeconds: 100 },
    );

    expect(
      (document[1]?.position as { cartographicDegrees: number[] }).cartographicDegrees,
    ).toEqual([100, 1, 2, 0, 102.5, 3, 4, 0]);
  });

  it('rejects invalid ids, samples, and options', () => {
    expect(() => czmlFromPositions('  ', [beijing])).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() => czmlFromPositions('id', [])).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() => czmlFromPositions('id', [beijing], { intervalSeconds: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() => czmlFromPositions('id', [beijing], { startSeconds: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() => czmlFromPositions('id', [beijing], { epoch: 'not-a-date' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() => czmlFromPositions('id', [{ longitude: Number.NaN, latitude: 0 }])).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
  });
});

describe('czmlFromSamples', () => {
  it('sorts samples by time before writing', () => {
    const document = czmlFromSamples('sat-1', [
      { timeSeconds: 20, position: shanghai },
      { timeSeconds: 5, position: beijing },
    ]);

    expect(
      (document[1]?.position as { cartographicDegrees: number[] }).cartographicDegrees,
    ).toEqual([5, 116.39, 39.9, 500_000, 20, 121.47, 31.23, 500_000]);
  });

  it('rejects non-finite times', () => {
    expect(() =>
      czmlFromSamples('sat-1', [{ timeSeconds: Number.NaN, position: beijing }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
  });
});

describe('positionsFromCzml', () => {
  it('round-trips an exported document', () => {
    const document = czmlFromPositions('sat-1', [beijing, shanghai], {
      epoch: '2026-09-30T00:00:00Z',
      intervalSeconds: 10,
      name: '卫星一号',
    });

    const tracks = positionsFromCzml(document);

    expect(tracks).toHaveLength(1);
    // epoch 取文档 clock 区间的起点，并按 ISO 规范化（带毫秒）。
    expect(tracks[0]).toMatchObject({
      id: 'sat-1',
      name: '卫星一号',
      epoch: '2026-09-30T00:00:00.000Z',
    });
    expect(tracks[0]?.samples).toEqual([
      { timeSeconds: 0, position: beijing },
      { timeSeconds: 10, position: shanghai },
    ]);
    expect(tracks[0]?.availability).toEqual([{ startSeconds: 0, endSeconds: 10 }]);
  });

  it('accepts ISO timestamps and per-packet epochs', () => {
    const document = [
      {
        id: 'document',
        clock: { interval: '2026-09-30T00:00:00Z/2026-09-30T00:01:00Z' },
      },
      {
        id: 'a',
        position: {
          cartographicDegrees: ['2026-09-30T00:00:05Z', 1, 2, 3, '2026-09-30T00:00:15Z', 4, 5, 6],
        },
      },
      {
        id: 'b',
        position: {
          epoch: '2026-09-30T00:00:10Z',
          cartographicDegrees: [0, 7, 8, 9, 5, 10, 11, 12],
        },
      },
    ];

    const tracks = positionsFromCzml(document);

    expect(tracks[0]?.samples.map((sample) => sample.timeSeconds)).toEqual([5, 15]);
    // 包的 epoch 覆盖文档 epoch：0 秒相对 10 秒 ⇒ 文档时间 10 秒。
    expect(tracks[1]?.samples.map((sample) => sample.timeSeconds)).toEqual([10, 15]);
  });

  it('reads static positions by default epoch and skips packets without position', () => {
    const tracks = positionsFromCzml([
      { id: 'document', version: '1.0' },
      { id: 'no-position', billboard: { image: 'x.png' } },
      { id: 'static', position: { cartographicDegrees: [10, 20, 30] } },
    ]);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: 'static', epoch: '1970-01-01T00:00:00Z' });
    expect(tracks[0]?.samples).toEqual([
      { timeSeconds: 0, position: { longitude: 10, latitude: 20, height: 30 } },
    ]);
  });

  it('rejects malformed documents', () => {
    expect(() => positionsFromCzml('nope')).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() => positionsFromCzml([{ position: { cartographicDegrees: [1, 2, 3] } }])).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() =>
      positionsFromCzml([{ id: 'a', position: { cartographicDegrees: [Number.NaN, 1, 2] } }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
    expect(() =>
      positionsFromCzml([{ id: 'a', position: { cartographicDegrees: [0, 1, 2, 3, 4] } }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
    expect(() =>
      positionsFromCzml([
        { id: 'a', position: { cartographicDegrees: [0, 1, 2, 3] }, availability: 'bad-interval' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
    expect(() =>
      positionsFromCzml([{ id: 'a', position: { cartographicDegrees: [0, 1, 2, 3] } }], {
        epoch: 'nope',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
  });
});
