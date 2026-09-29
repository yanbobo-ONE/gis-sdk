import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class FakeModel {
    show = true;
    modelMatrix: unknown;
    scale = 1;
    color: unknown = undefined;
    colorBlendMode: unknown = undefined;
    colorBlendAmount = 0.5;
    readonly destroy = vi.fn();
  }
  const fromGltfAsync = vi.fn<(options?: Record<string, unknown>) => Promise<FakeModel>>();
  const fromDegrees = vi.fn((longitude: number, latitude: number, height: number) => ({
    longitude,
    latitude,
    height,
  }));
  const hprFromDegrees = vi.fn((heading: number, pitch: number, roll: number) => ({
    heading,
    pitch,
    roll,
  }));
  const headingPitchRollToFixedFrame = vi.fn((position: unknown, orientation: unknown) => ({
    position,
    orientation,
  }));
  return {
    Model: { fromGltfAsync },
    Cartesian3: { fromDegrees },
    HeadingPitchRoll: { fromDegrees: hprFromDegrees },
    Transforms: { headingPitchRollToFixedFrame },
    Color: {
      WHITE: { css: 'white' },
      fromCssColorString: vi.fn((value: string) =>
        value === 'invalid-color' ? undefined : { css: value },
      ),
    },
    ColorBlendMode: { HIGHLIGHT: 'HIGHLIGHT', MIX: 'MIX' },
    FakeModel,
    fromGltfAsync,
    fromDegrees,
    hprFromDegrees,
    headingPitchRollToFixedFrame,
    reset() {
      fromGltfAsync.mockReset();
      fromGltfAsync.mockImplementation(() => Promise.resolve(new FakeModel()));
      fromDegrees.mockClear();
      hprFromDegrees.mockClear();
      headingPitchRollToFixedFrame.mockClear();
    },
  };
});

vi.mock('cesium', () => ({
  Model: cesium.Model,
  Cartesian3: cesium.Cartesian3,
  HeadingPitchRoll: cesium.HeadingPitchRoll,
  Transforms: cesium.Transforms,
  Color: cesium.Color,
  ColorBlendMode: cesium.ColorBlendMode,
}));

import { createModelLayer } from '../src/cesium/layers/model-layer.js';
import { LoadLimiter } from '../src/cesium/load-limiter.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

type FakeModel = InstanceType<typeof cesium.FakeModel>;

function createViewer() {
  const items: FakeModel[] = [];
  const add = vi.fn((model: FakeModel) => (items.push(model), model));
  const remove = vi.fn((model: FakeModel) => {
    const index = items.indexOf(model);
    if (index >= 0) items.splice(index, 1);
    return index >= 0;
  });
  return { viewer: { scene: { primitives: { add, remove } } }, items, add, remove };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

const limiter = new LoadLimiter(4);

describe('model layer', () => {
  beforeEach(() => {
    cesium.reset();
  });

  it('loads a glTF model with WGS84 position, degree orientation, and visual state', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createModelLayer(
      view.viewer as never,
      {
        id: 'vehicle-1',
        type: 'model',
        url: ' /models/vehicle.glb ',
        position: { longitude: 116.39, latitude: 39.9, height: 12 },
        orientation: { heading: 90, pitch: 0, roll: 0 },
        scale: 2,
        minimumPixelSize: 48,
        maximumScale: 20,
        allowPicking: false,
        visible: false,
      },
      context,
      limiter,
    );

    expect(cesium.fromDegrees).toHaveBeenCalledWith(116.39, 39.9, 12);
    expect(cesium.hprFromDegrees).toHaveBeenCalledWith(90, 0, 0);
    const [options] = cesium.fromGltfAsync.mock.calls[0] ?? [];
    expect(options?.modelMatrix).toEqual(
      cesium.headingPitchRollToFixedFrame.mock.results[0]?.value,
    );
    expect(options).toMatchObject({
      url: '/models/vehicle.glb',
      scale: 2,
      minimumPixelSize: 48,
      maximumScale: 20,
      allowPicking: false,
      show: false,
    });
    expect(layer).toMatchObject({ id: 'vehicle-1', type: 'model', visible: false });
    layer.setVisible(true);
    expect(view.items[0]?.show).toBe(true);
    await layer.dispose();
    expect(view.remove).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it('omits unspecified Cesium options so model defaults stay in effect', async () => {
    const view = createViewer();
    await createModelLayer(
      view.viewer as never,
      {
        id: 'defaults',
        type: 'model',
        url: '/models/a.glb',
        position: { longitude: 0, latitude: 0 },
      },
      createContext().context,
      limiter,
    );

    const [options] = cesium.fromGltfAsync.mock.calls[0] ?? [];
    expect(options?.modelMatrix).toEqual(
      cesium.headingPitchRollToFixedFrame.mock.results[0]?.value,
    );
    expect(options).toMatchObject({
      url: '/models/a.glb',
      show: true,
      allowPicking: true,
    });
    expect(options).not.toHaveProperty('scale');
    expect(cesium.fromDegrees).toHaveBeenCalledWith(0, 0, 0);
    expect(cesium.hprFromDegrees).toHaveBeenCalledWith(0, 0, 0);
  });

  it('applies a CSS color with full mix blending and can restore the original appearance', async () => {
    const view = createViewer();
    const layer = await createModelLayer(
      view.viewer as never,
      {
        id: 'tinted',
        type: 'model',
        url: '/models/a.glb',
        position: { longitude: 0, latitude: 0 },
        color: '#ff8800',
      },
      createContext().context,
      limiter,
    );

    expect(cesium.fromGltfAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        color: { css: '#ff8800' },
        colorBlendMode: 'MIX',
        colorBlendAmount: 1,
      }),
    );

    layer.setColor('rgba(0, 128, 255, 0.5)');
    expect(view.items[0]).toMatchObject({
      color: { css: 'rgba(0, 128, 255, 0.5)' },
      colorBlendMode: 'MIX',
      colorBlendAmount: 1,
    });

    layer.setColor();
    expect(view.items[0]).toMatchObject({
      color: { css: 'white' },
      colorBlendMode: 'HIGHLIGHT',
      colorBlendAmount: 0.5,
    });
  });

  it('rejects an unparsable color without changing the model', async () => {
    const view = createViewer();
    const layer = await createModelLayer(
      view.viewer as never,
      {
        id: 'bad-color',
        type: 'model',
        url: '/models/a.glb',
        position: { longitude: 0, latitude: 0 },
      },
      createContext().context,
      limiter,
    );

    expect(() => {
      layer.setColor('invalid-color');
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_COLOR' }));
    await expect(
      createModelLayer(
        view.viewer as never,
        {
          id: 'bad-color-spec',
          type: 'model',
          url: '/models/a.glb',
          position: { longitude: 0, latitude: 0 },
          color: 'invalid-color',
        },
        createContext().context,
        limiter,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_COLOR' });
  });

  it('updates position, orientation, and scale without reloading the model', async () => {
    const view = createViewer();
    const layer = await createModelLayer(
      view.viewer as never,
      {
        id: 'moving',
        type: 'model',
        url: '/models/a.glb',
        position: { longitude: 10, latitude: 20 },
        scale: 1,
      },
      createContext().context,
      limiter,
    );

    cesium.fromDegrees.mockClear();
    cesium.hprFromDegrees.mockClear();
    const previousMatrix = view.items[0]?.modelMatrix;

    layer.setTransform({
      position: { longitude: 116.39, latitude: 39.9, height: 500 },
      orientation: { heading: 45, pitch: -10, roll: 5 },
      scale: 3,
    });

    expect(cesium.fromDegrees).toHaveBeenCalledWith(116.39, 39.9, 500);
    expect(cesium.hprFromDegrees).toHaveBeenCalledWith(45, -10, 5);
    expect(view.items[0]?.modelMatrix).not.toBe(previousMatrix);
    expect(view.items[0]?.scale).toBe(3);
    expect(cesium.fromGltfAsync).toHaveBeenCalledOnce();

    expect(() => {
      layer.setTransform({ position: { longitude: 200, latitude: 0 } });
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }));
    expect(() => {
      layer.setTransform({ position: { longitude: 0, latitude: 0 }, scale: 0 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }));
  });

  it('rejects operations after disposal', async () => {
    const view = createViewer();
    const layer = await createModelLayer(
      view.viewer as never,
      {
        id: 'disposed',
        type: 'model',
        url: '/models/a.glb',
        position: { longitude: 0, latitude: 0 },
      },
      createContext().context,
      limiter,
    );

    await layer.dispose();
    expect(() => {
      layer.setColor('#fff000');
    }).toThrow(expect.objectContaining({ code: 'LAYER_DISPOSED' }));
    expect(() => {
      layer.setTransform({ position: { longitude: 0, latitude: 0 } });
    }).toThrow(expect.objectContaining({ code: 'LAYER_DISPOSED' }));
  });

  it('rejects invalid configuration before Cesium loading', async () => {
    const view = createViewer();
    await expect(
      createModelLayer(
        view.viewer as never,
        { id: 'bad', type: 'model', url: '', position: { longitude: 0, latitude: 0 } },
        createContext().context,
        limiter,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
    await expect(
      createModelLayer(
        view.viewer as never,
        { id: 'bad', type: 'model', url: '/a.glb', position: { longitude: 0, latitude: 91 } },
        createContext().context,
        limiter,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
    expect(cesium.fromGltfAsync).not.toHaveBeenCalled();
  });

  it('wraps load failures and destroys models resolving after cancellation', async () => {
    const view = createViewer();
    cesium.fromGltfAsync.mockRejectedValueOnce(new Error('missing model'));
    await expect(
      createModelLayer(
        view.viewer as never,
        {
          id: 'missing',
          type: 'model',
          url: '/missing.glb',
          position: { longitude: 0, latitude: 0 },
        },
        createContext().context,
        limiter,
      ),
    ).rejects.toMatchObject({ code: 'LAYER_LOAD_FAILED', retryable: true });

    const lateModel = new cesium.FakeModel();
    let resolveModel: ((model: FakeModel) => void) | undefined;
    cesium.fromGltfAsync.mockImplementationOnce(
      () =>
        new Promise<FakeModel>((resolve) => {
          resolveModel = resolve;
        }),
    );
    const controller = new AbortController();
    const adding = createModelLayer(
      view.viewer as never,
      { id: 'late', type: 'model', url: '/late.glb', position: { longitude: 0, latitude: 0 } },
      createContext(controller.signal).context,
      limiter,
    );
    await vi.waitFor(() => {
      expect(cesium.fromGltfAsync).toHaveBeenCalledTimes(2);
    });
    controller.abort('route changed');
    await expect(adding).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    resolveModel?.(lateModel);
    await vi.waitFor(() => {
      expect(lateModel.destroy).toHaveBeenCalledOnce();
    });
  });
});
