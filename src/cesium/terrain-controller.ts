import { CesiumTerrainProvider, EllipsoidTerrainProvider } from 'cesium';
import type { Viewer } from 'cesium';

import type { TerrainController, TerrainSpec } from '../core/controls.js';
import { GisError } from '../core/errors.js';

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_TERRAIN_CONFIG',
    module: 'terrain',
    operation: 'set',
  });
}

/** @internal */
export class CesiumTerrainController implements TerrainController {
  private currentType: TerrainSpec['type'] = 'ellipsoid';
  private pending: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly viewer: Pick<Viewer, 'terrainProvider'>) {}

  get type(): TerrainSpec['type'] {
    return this.currentType;
  }

  set(spec: TerrainSpec): Promise<void> {
    this.assertActive();
    if (this.pending) {
      return Promise.reject(
        new GisError('A terrain change is already in progress.', {
          code: 'TERRAIN_BUSY',
          module: 'terrain',
          operation: 'set',
          retryable: true,
        }),
      );
    }
    if (spec.type === 'ellipsoid') {
      this.viewer.terrainProvider = new EllipsoidTerrainProvider();
      this.currentType = 'ellipsoid';
      return Promise.resolve();
    }

    const url = spec.url.trim();
    if (!url) {
      return Promise.reject(invalidConfig('Cesium terrain URL must be non-empty.'));
    }
    const request = CesiumTerrainProvider.fromUrl(url, {
      ...(spec.requestVertexNormals === undefined
        ? {}
        : { requestVertexNormals: spec.requestVertexNormals }),
      ...(spec.requestWaterMask === undefined ? {} : { requestWaterMask: spec.requestWaterMask }),
    });
    const operation = request.then(
      (provider) => {
        this.assertActive();
        this.viewer.terrainProvider = provider;
        this.currentType = 'cesium-terrain';
      },
      (cause: unknown) => {
        throw new GisError('Failed to load Cesium terrain.', {
          code: 'TERRAIN_LOAD_FAILED',
          module: 'terrain',
          operation: 'set',
          retryable: true,
          cause,
        });
      },
    );
    this.pending = operation.finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  destroy(): void {
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new GisError('Terrain controller has been disposed.', {
        code: 'TERRAIN_DISPOSED',
        module: 'terrain',
        operation: 'set',
      });
    }
  }
}
