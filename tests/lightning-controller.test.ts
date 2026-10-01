import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class Polyline {
    show = true;
    width = 1;
    material: unknown;
    positions: unknown;

    constructor(options: Record<string, unknown> = {}) {
      Object.assign(this, options);
    }
  }

  class PolylineCollection {
    readonly items: Polyline[] = [];

    add(options: Record<string, unknown> | Polyline): Polyline {
      const polyline = options instanceof Polyline ? options : new Polyline(options);
      this.items.push(polyline);
      return polyline;
    }

    remove(polyline: Polyline): boolean {
      const index = this.items.indexOf(polyline);
      if (index < 0) {
        return false;
      }
      this.items.splice(index, 1);
      return true;
    }

    get length(): number {
      return this.items.length;
    }
  }

  class PolylineGlowMaterialProperty {
    color: unknown;
    glowPower: { getValue(): number; set(value: number): void } | undefined;
    taperPower: unknown;

    constructor(options: Record<string, unknown> = {}) {
      this.color = options.color;
      this.glowPower = options.glowPower as PolylineGlowMaterialProperty['glowPower'];
      this.taperPower = options.taperPower;
    }
  }

  class Event {
    addEventListener(): () => void {
      return () => undefined;
    }
    removeEventListener(): void {
      return undefined;
    }
    raiseEvent(): void {
      return undefined;
    }
  }

  class PostProcessStage {
    enabled = true;
    readonly uniforms: Record<string, unknown>;

    constructor(options: { readonly uniforms?: Record<string, unknown> } = {}) {
      this.uniforms = options.uniforms ?? {};
    }
  }

  return {
    Event,
    Polyline,
    PolylineCollection,
    PolylineGlowMaterialProperty,
    PostProcessStage,
    fromDegreesArrayHeights: vi.fn((values: readonly number[]) => values),
  };
});

vi.mock('cesium', () => ({
  Cartesian3: { fromDegreesArrayHeights: cesium.fromDegreesArrayHeights },
  Color: {
    fromCssColorString: (value: string) => ({ red: 1, green: 1, blue: 1, alpha: 1, css: value }),
  },
  ConstantProperty: class ConstantProperty {
    constructor(readonly value: unknown) {}
  },
  Event: cesium.Event,
  PolylineCollection: cesium.PolylineCollection,
  PolylineGlowMaterialProperty: cesium.PolylineGlowMaterialProperty,
  PostProcessStage: cesium.PostProcessStage,
}));

import { CesiumLightningController } from '../src/cesium/lightning-controller.js';

const ORIGIN = { longitude: 116.391, latitude: 39.907, height: 1_500 };

function createHarness() {
  const primitives = {
    add: vi.fn((collection: InstanceType<typeof cesium.PolylineCollection>) => collection),
    remove: vi.fn(() => true),
  };
  const frameListeners = new Set<() => void>();
  const stage = { value: undefined as InstanceType<typeof cesium.PostProcessStage> | undefined };
  const viewer = {
    scene: {
      primitives,
      postProcessStages: {
        add: (added: InstanceType<typeof cesium.PostProcessStage>) => {
          stage.value = added;
          return added;
        },
      },
      preRender: {
        addEventListener: (listener: () => void) => {
          frameListeners.add(listener);
          return () => frameListeners.delete(listener);
        },
      },
    },
  };
  let now = 1_000;
  const controller = new CesiumLightningController(viewer as never, () => now);
  const collection = primitives.add.mock.calls[0]?.[0];
  return {
    collection,
    controller,
    frame: () => {
      for (const listener of frameListeners) {
        listener();
      }
    },
    frameListeners,
    primitives,
    stage,
    tick: (deltaMs: number) => {
      now += deltaMs;
    },
  };
}

describe('CesiumLightningController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one polyline per path and drives the envelope frame by frame', () => {
    const harness = createHarness();
    const id = harness.controller.strike({ origin: ORIGIN, branches: 'sparse', seed: 4 });

    expect(id).toBe('lightning-1');
    expect(harness.controller.activeCount).toBe(1);
    // 主干 + sparse 的 2 条分支。
    expect(harness.collection?.length).toBe(3);
    expect(harness.controller.flashLevel).toBe(0);

    // 推进到主峰附近：辉光与屏幕闪光都应抬起。
    harness.tick(130);
    harness.frame();
    const peak = harness.controller.flashLevel;
    expect(peak).toBeGreaterThan(0.5);
    expect(harness.stage.value?.enabled).toBe(true);

    // 闪击结束后几何释放、闪光随衰减归零。
    harness.tick(900);
    harness.frame();
    expect(harness.controller.activeCount).toBe(0);
    expect(harness.collection?.length).toBe(0);
    harness.tick(1_000);
    harness.frame();
    expect(harness.controller.flashLevel).toBe(0);
  });

  it('replaces a strike with the same id instead of stacking duplicates', () => {
    const harness = createHarness();
    harness.controller.strike({ id: 'bolt-a', origin: ORIGIN, branches: 'sparse' });
    const firstCount = harness.collection?.length ?? 0;
    harness.controller.strike({ id: 'bolt-a', origin: ORIGIN, branches: 'sparse' });

    expect(harness.controller.activeCount).toBe(1);
    expect(harness.collection?.length).toBe(firstCount);
  });

  it('evicts the oldest strike beyond the concurrency cap', () => {
    const harness = createHarness();
    for (let index = 0; index < harness.controller.maxActive + 2; index += 1) {
      harness.controller.strike({
        id: `bolt-${String(index)}`,
        origin: ORIGIN,
        branches: 'sparse',
      });
    }

    expect(harness.controller.activeCount).toBe(harness.controller.maxActive);
    expect(harness.controller.cancel('bolt-0')).toBe(false);
    expect(harness.controller.cancel('bolt-2')).toBe(true);
  });

  it('cancels strikes and clears the flash', () => {
    const harness = createHarness();
    const first = harness.controller.strike({ origin: ORIGIN });
    const second = harness.controller.strike({ origin: ORIGIN });
    harness.tick(130);
    harness.frame();
    expect(harness.controller.flashLevel).toBeGreaterThan(0);

    expect(harness.controller.cancel(first)).toBe(true);
    expect(harness.controller.cancel(first)).toBe(false);
    expect(harness.controller.activeCount).toBe(1);

    harness.controller.cancelAll();
    expect(harness.controller.activeCount).toBe(0);
    expect(harness.controller.flashLevel).toBe(0);
    expect(harness.controller.cancel(second)).toBe(false);
  });

  it('applies style changes to running strikes and validates them', () => {
    const harness = createHarness();
    harness.controller.strike({ origin: ORIGIN, branches: 'sparse' });
    harness.controller.setStyle({ thickness: 6, coreColor: '#ffd166', screenFlash: false });

    const polylines = harness.collection?.items ?? [];
    expect(polylines.length).toBeGreaterThan(0);
    for (const polyline of polylines) {
      expect(polyline.width).toBe(6);
    }
    harness.tick(130);
    harness.frame();
    // 关闭屏幕闪光后，即使有闪击也不启用后处理。
    expect(harness.stage.value?.enabled).toBe(false);

    expect(() => {
      harness.controller.setStyle({ thickness: 0 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() => {
      harness.controller.setStyle({ coreColor: '  ' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });

  it('rejects invalid strike parameters without leaving geometry behind', () => {
    const harness = createHarness();
    for (const options of [
      { origin: ORIGIN, durationMs: 0 },
      { origin: ORIGIN, pulses: 5 },
      { origin: ORIGIN, intensity: 2 },
      { origin: { longitude: Number.NaN, latitude: 0 } },
    ]) {
      expect(() => {
        harness.controller.strike(options);
      }).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    }
    expect(harness.controller.activeCount).toBe(0);
    expect(harness.collection?.length).toBe(0);
  });

  it('releases the collection and stops accepting input after destroy', () => {
    const harness = createHarness();
    harness.controller.strike({ origin: ORIGIN });
    harness.controller.destroy();

    expect(harness.primitives.remove).toHaveBeenCalledWith(harness.collection);
    expect(harness.collection?.length).toBe(0);
    expect(harness.frameListeners.size).toBe(0);
    expect(() => {
      harness.controller.strike({ origin: ORIGIN });
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED' }));
  });
});
