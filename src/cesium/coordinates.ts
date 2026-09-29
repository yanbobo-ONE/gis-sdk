import { Cartesian2, Cartesian3, Math as CesiumMath, SceneTransforms } from 'cesium';
import type { Viewer } from 'cesium';

import type {
  CoordinateTransform,
  GeoPosition,
  WindowCoordinates,
  WorldCoordinates,
} from '../core/controls.js';
import { GisError } from '../core/errors.js';

function invalidCoordinates(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_COORDINATES',
    module: 'coordinates',
    operation,
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 按运行时未知输入校验；非 TS 调用方可能传入缺少字段的对象。 */
function validateGeoPosition(position: unknown, operation: string): Required<GeoPosition> {
  const { longitude, latitude, height = 0 } = (position ?? {}) as Partial<GeoPosition>;
  if (!finite(longitude) || !finite(latitude) || !finite(height)) {
    throw invalidCoordinates(
      'Geo position must contain finite longitude, latitude, and height.',
      operation,
    );
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw invalidCoordinates(
      'Geo position longitude must be within -180..180 and latitude within -90..90.',
      operation,
    );
  }
  return { longitude, latitude, height };
}

function validateWorld(world: unknown, operation: string): WorldCoordinates {
  const { x, y, z } = (world ?? {}) as Partial<WorldCoordinates>;
  if (!finite(x) || !finite(y) || !finite(z)) {
    throw invalidCoordinates('World coordinates must contain finite x, y, and z.', operation);
  }
  return { x, y, z };
}

function validateWindow(point: unknown, operation: string): WindowCoordinates {
  const { x, y } = (point ?? {}) as Partial<WindowCoordinates>;
  if (!finite(x) || !finite(y)) {
    throw invalidCoordinates('Window coordinates must contain finite x and y.', operation);
  }
  return { x, y };
}

/** @internal */
export class CesiumCoordinateTransform implements CoordinateTransform {
  constructor(private readonly viewer: Pick<Viewer, 'camera'> & Pick<Viewer, 'scene'>) {}

  toWorld(position: GeoPosition): WorldCoordinates {
    const { longitude, latitude, height } = validateGeoPosition(position, 'toWorld');
    const cartesian = Cartesian3.fromDegrees(longitude, latitude, height);
    return { x: cartesian.x, y: cartesian.y, z: cartesian.z };
  }

  toGeoPosition(world: WorldCoordinates): GeoPosition {
    const { x, y, z } = validateWorld(world, 'toGeoPosition');
    const cartographic = this.viewer.scene.globe.ellipsoid.cartesianToCartographic(
      new Cartesian3(x, y, z),
    );
    return {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      height: cartographic.height,
    };
  }

  toWindow(position: GeoPosition): WindowCoordinates | undefined {
    const { longitude, latitude, height } = validateGeoPosition(position, 'toWindow');
    const projected = SceneTransforms.worldToWindowCoordinates(
      this.viewer.scene,
      Cartesian3.fromDegrees(longitude, latitude, height),
    );
    return projected ? { x: projected.x, y: projected.y } : undefined;
  }

  pickGeoPosition(point: WindowCoordinates): GeoPosition | undefined {
    const { x, y } = validateWindow(point, 'pickGeoPosition');
    const ray = this.viewer.camera.getPickRay(new Cartesian2(x, y));
    if (!ray) {
      return undefined;
    }
    const picked = this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!picked) {
      return undefined;
    }
    const cartographic = this.viewer.scene.globe.ellipsoid.cartesianToCartographic(picked);
    return {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      height: cartographic.height,
    };
  }
}
