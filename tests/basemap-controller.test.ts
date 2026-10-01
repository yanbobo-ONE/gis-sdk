import { describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class UrlTemplateImageryProvider {
    constructor(readonly options: Record<string, unknown>) {}
  }

  return { UrlTemplateImageryProvider };
});

vi.mock('cesium', () => ({ UrlTemplateImageryProvider: cesium.UrlTemplateImageryProvider }));

import { CesiumBasemapController } from '../src/cesium/basemap-controller.js';

function createViewer() {
  const layers: { alpha: number; show: boolean; provider: unknown }[] = [];
  return {
    layers,
    viewer: {
      imageryLayers: {
        addImageryProvider: vi.fn((provider: unknown, index: number = layers.length) => {
          const layer = { alpha: 1, show: true, provider };
          layers.splice(index, 0, layer);
          return layer;
        }),
        remove: vi.fn((layer: (typeof layers)[number]) => {
          const index = layers.indexOf(layer);
          if (index >= 0) layers.splice(index, 1);
          return index >= 0;
        }),
        indexOf: vi.fn((layer: (typeof layers)[number]) => layers.indexOf(layer)),
      },
    },
  };
}

describe('CesiumBasemapController', () => {
  it('owns one XYZ layer at index zero and preserves it during replacement', () => {
    const fixture = createViewer();
    const controller = new CesiumBasemapController(fixture.viewer as never);

    controller.set({ type: 'xyz', url: '/tiles/{z}/{x}/{y}.png', opacity: 0.7 });
    controller.setVisible(false);
    controller.set({ type: 'xyz', url: '/tiles-next/{z}/{x}/{y}.png' });

    expect(fixture.viewer.imageryLayers.addImageryProvider).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ options: { url: '/tiles/{z}/{x}/{y}.png' } }),
      0,
    );
    expect(controller.type).toBe('xyz');
    expect(controller.visible).toBe(false);
    expect(controller.opacity).toBe(0.7);
    expect(fixture.layers).toHaveLength(1);
    expect(fixture.layers[0]?.provider).toMatchObject({
      options: { url: '/tiles-next/{z}/{x}/{y}.png' },
    });
  });

  it('clears the owned layer and rejects malformed templates', () => {
    const fixture = createViewer();
    const controller = new CesiumBasemapController(fixture.viewer as never);

    expect(() => {
      controller.set({ type: 'xyz', url: '/tiles' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_BASEMAP_CONFIG' }));
    controller.set({ type: 'xyz', url: '/tiles/{z}/{x}/{y}.png' });
    controller.clear();

    expect(controller.type).toBe('none');
    expect(fixture.layers).toHaveLength(0);
  });

  it('keeps business imagery layers outside SDK basemap ownership', () => {
    const fixture = createViewer();
    const businessLayer = { alpha: 1, show: true, provider: { kind: 'business' } };
    fixture.layers.push(businessLayer);
    const controller = new CesiumBasemapController(fixture.viewer as never);

    controller.set({ type: 'xyz', url: '/tiles/{z}/{x}/{y}.png' });
    controller.clear();

    expect(fixture.layers).toEqual([businessLayer]);
    expect(fixture.viewer.imageryLayers.remove).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('reports the imagery floor business layers may not go below', () => {
    const fixture = createViewer();
    const businessLayer = { alpha: 1, show: true, provider: { kind: 'business' } };
    fixture.layers.push(businessLayer);
    const controller = new CesiumBasemapController(fixture.viewer as never);

    // 没有底图时下限是 0：业务图层可以占最底层。
    expect(controller.imageryFloorIndex()).toBe(0);

    // 底图插到 index 0 之后，下限是它上面一层。
    controller.set({ type: 'xyz', url: '/tiles/{z}/{x}/{y}.png' });
    expect(controller.imageryFloorIndex()).toBe(1);

    // 清空底图后下限回到 0（业务图层随之落到最底层）。
    controller.clear();
    expect(controller.imageryFloorIndex()).toBe(0);
  });
});
