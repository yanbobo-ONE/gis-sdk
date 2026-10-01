import { describe, expect, it } from 'vitest';

import {
  czmlFromPositions,
  czmlFromSamples,
  positionsFromCzml,
  tracksFromCzml,
} from '../src/core/czml.js';

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

describe('CZML model packet and attitude samples', () => {
  const epoch = '2026-09-30T00:00:00Z';

  it('writes a model packet with the reference defaults', () => {
    const document = czmlFromPositions(
      'platform-1',
      [
        { longitude: 1, latitude: 2, height: 3 },
        { longitude: 1.1, latitude: 2.1, height: 3.2 },
      ],
      { epoch, intervalSeconds: 5, model: { url: 'https://example.com/platform.glb' } },
    );

    expect(document[1]?.model).toEqual({
      gltf: 'https://example.com/platform.glb',
      minimumPixelSize: 24,
    });

    const scaled = czmlFromPositions('p', [{ longitude: 0, latitude: 0 }], {
      model: { url: 'model.glb', minimumPixelSize: 48, scale: 2 },
    });
    expect(scaled[1]?.model).toEqual({ gltf: 'model.glb', minimumPixelSize: 48, scale: 2 });
  });

  it('rejects an empty model url and non-positive rendering values', () => {
    const positions = [{ longitude: 0, latitude: 0 }];

    expect(() => czmlFromPositions('p', positions, { model: { url: '  ' } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
    expect(() =>
      czmlFromPositions('p', positions, { model: { url: 'a.glb', minimumPixelSize: 0 } }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
    expect(() => czmlFromPositions('p', positions, { model: { url: 'a.glb', scale: -1 } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CZML' }),
    );
  });

  it('reads model url and per-sample attitude from tracks', () => {
    const document = [
      { id: 'document', version: '1.0' },
      {
        id: 'platform-1',
        name: '平台一号',
        model: { gltf: 'platform.glb', minimumPixelSize: 32 },
        position: { epoch, cartographicDegrees: [0, 10, 20, 30, 5, 11, 21, 31] },
        orientation: { epoch, unitQuaternion: [0, 0, 0, 0, 1, 5, 0, 0, 0, 1] },
        availability: `2026-09-30T00:00:00Z/2026-09-30T00:00:05Z`,
      },
      { id: 'marker', position: { cartographicDegrees: [0, 1, 2, 3] } },
    ];

    const tracks = tracksFromCzml(document);

    expect(tracks).toHaveLength(2);
    const platform = tracks[0];
    expect(platform?.modelUrl).toBe('platform.glb');
    expect(platform?.name).toBe('平台一号');
    expect(platform?.samples).toEqual([
      {
        timeSeconds: 0,
        position: { longitude: 10, latitude: 20, height: 30 },
        attitude: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        timeSeconds: 5,
        position: { longitude: 11, latitude: 21, height: 31 },
        attitude: { x: 0, y: 0, z: 0, w: 1 },
      },
    ]);
    expect(platform?.availability).toEqual([{ startSeconds: 0, endSeconds: 5 }]);
    // 没有 model 与 orientation 的包给出 undefined，不伪造默认值。
    expect(tracks[1]?.modelUrl).toBeUndefined();
    expect(tracks[1]?.samples[0]?.attitude).toBeUndefined();
  });

  it('normalizes unit quaternions and rejects degenerate ones', () => {
    const track = tracksFromCzml([
      {
        id: 'a',
        position: { cartographicDegrees: [0, 1, 2, 3] },
        orientation: { unitQuaternion: [0, 0, 0, 2] },
      },
    ])[0];

    expect(track?.samples[0]?.attitude).toEqual({ x: 0, y: 0, z: 0, w: 1 });

    expect(() =>
      tracksFromCzml([
        {
          id: 'a',
          position: { cartographicDegrees: [0, 1, 2, 3] },
          orientation: { unitQuaternion: [0, 0, 0, 0] },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
    expect(() =>
      tracksFromCzml([
        {
          id: 'a',
          position: { cartographicDegrees: [0, 1, 2, 3] },
          orientation: { unitQuaternion: [0, 0, 0] },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
  });

  it('ignores orientation forms outside the minimal set instead of failing', () => {
    const tracks = tracksFromCzml([
      {
        id: 'a',
        position: { cartographicDegrees: [0, 1, 2, 3] },
        orientation: { velocityReference: '#position' },
      },
    ]);

    expect(tracks[0]?.samples[0]?.attitude).toBeUndefined();
  });

  it('keeps positionsFromCzml output unchanged', () => {
    const document = czmlFromPositions('a', [{ longitude: 1, latitude: 2 }], {
      model: { url: 'a.glb' },
    });

    expect(positionsFromCzml(document)).toEqual([
      {
        id: 'a',
        name: undefined,
        epoch: '1970-01-01T00:00:00Z',
        samples: [{ timeSeconds: 0, position: { longitude: 1, latitude: 2, height: 0 } }],
        availability: [],
      },
    ]);
  });
});
