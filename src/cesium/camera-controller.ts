import { Cartesian3, Math as CesiumMath } from 'cesium';
import type { Camera } from 'cesium';

import type {
  CameraController,
  CameraFlight,
  CameraView,
  CameraViewSnapshot,
} from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { GeoBBox } from '../spatial/types.js';

/** 相机打不中椭球时的四至哨兵：全球范围，按"没有结果"处理。 */
const GLOBE_SENTINEL_TOLERANCE = 1e-9;

/** 相机位置的最小读数形状（波束的 Cesium `Cartographic` 结构兼容）。 */
interface ReadableCartographic {
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
}

/** 相机视口四至的最小读数形状（Cesium `Rectangle` 结构兼容）。 */
interface ReadableRectangle {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * 相机控制器需要读取的成员。
 *
 * 只依赖四个边界值与位姿字段，不依赖 Cesium 的类方法，便于其它终端替换实现。
 */
type ReadableCamera = Pick<Camera, 'cancelFlight' | 'flyTo' | 'setView'> & {
  readonly positionCartographic: ReadableCartographic;
  readonly heading?: number | undefined;
  readonly pitch?: number | undefined;
  readonly roll?: number | undefined;
  computeViewRectangle(ellipsoid?: unknown): ReadableRectangle | undefined;
};

interface ActiveFlight {
  readonly reject: (reason: GisError) => void;
}

function invalidView(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_CAMERA_VIEW',
    module: 'camera',
    operation: 'view',
  });
}

function unavailableView(message: string): GisError {
  return new GisError(message, {
    code: 'CAMERA_VIEW_UNAVAILABLE',
    module: 'camera',
    operation: 'view',
    retryable: true,
  });
}

function finite(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && !Number.isFinite(value)) {
    throw invalidView(`Camera ${name} must be a finite number.`);
  }
  return value;
}

function validate(view: CameraView): CameraView {
  const longitude = finite(view.longitude, 'longitude');
  const latitude = finite(view.latitude, 'latitude');
  if (longitude === undefined || longitude < -180 || longitude > 180) {
    throw invalidView('Camera longitude must be between -180 and 180 degrees.');
  }
  if (latitude === undefined || latitude < -90 || latitude > 90) {
    throw invalidView('Camera latitude must be between -90 and 90 degrees.');
  }
  finite(view.height, 'height');
  finite(view.heading, 'heading');
  finite(view.pitch, 'pitch');
  finite(view.roll, 'roll');
  return view;
}

function optionsFor(view: CameraView) {
  const normalized = validate(view);
  const destination = Cartesian3.fromDegrees(
    normalized.longitude,
    normalized.latitude,
    normalized.height ?? 0,
  );
  const hasOrientation =
    normalized.heading !== undefined ||
    normalized.pitch !== undefined ||
    normalized.roll !== undefined;
  const orientation = hasOrientation
    ? {
        heading: CesiumMath.toRadians(normalized.heading ?? 0),
        pitch: CesiumMath.toRadians(normalized.pitch ?? -90),
        roll: CesiumMath.toRadians(normalized.roll ?? 0),
      }
    : undefined;

  return orientation ? { destination, orientation } : { destination };
}

function cancelled(): GisError {
  return new GisError('Camera flight was cancelled.', {
    code: 'CAMERA_FLIGHT_CANCELLED',
    module: 'camera',
    operation: 'flyTo',
    retryable: true,
  });
}

/** @internal */
export class CesiumCameraController implements CameraController {
  private activeFlight: ActiveFlight | undefined;
  private disposed = false;

  constructor(private readonly camera: ReadableCamera) {}

  get view(): CameraViewSnapshot {
    const position = this.camera.positionCartographic;
    const longitude = CesiumMath.toDegrees(position.longitude);
    const latitude = CesiumMath.toDegrees(position.latitude);
    const height = position.height;
    if (![longitude, latitude, height].every(Number.isFinite)) {
      throw unavailableView('Camera position is not a finite WGS84 coordinate.');
    }
    // 形变过程中三个角度可能读不到，按"正俯视"兜底，与输入侧的默认值一致。
    return {
      longitude,
      latitude,
      height,
      heading: CesiumMath.toDegrees(this.camera.heading ?? 0),
      pitch: CesiumMath.toDegrees(this.camera.pitch ?? -Math.PI / 2),
      roll: CesiumMath.toDegrees(this.camera.roll ?? 0),
    };
  }

  get viewRectangle(): GeoBBox | undefined {
    let rectangle: ReadableRectangle | undefined;
    try {
      rectangle = this.camera.computeViewRectangle();
    } catch {
      return undefined;
    }
    if (!rectangle) {
      return undefined;
    }
    const west = CesiumMath.toDegrees(rectangle.west);
    const south = CesiumMath.toDegrees(rectangle.south);
    const east = CesiumMath.toDegrees(rectangle.east);
    const north = CesiumMath.toDegrees(rectangle.north);
    if (![west, south, east, north].every(Number.isFinite)) {
      return undefined;
    }
    const globe =
      Math.abs(west + 180) < GLOBE_SENTINEL_TOLERANCE &&
      Math.abs(east - 180) < GLOBE_SENTINEL_TOLERANCE &&
      Math.abs(south + 90) < GLOBE_SENTINEL_TOLERANCE &&
      Math.abs(north - 90) < GLOBE_SENTINEL_TOLERANCE;
    // 相机看不到椭球时 Cesium 返回全球哨兵矩形，这里按"没有结果"处理。
    return globe ? undefined : { west, south, east, north };
  }

  setView(view: CameraView): void {
    this.assertActive('setView');
    const options = optionsFor(view);
    // Cesium 的 setView 不会取消进行中的飞行；不先取消，飞行会继续按帧覆写刚设置的视角。
    if (this.activeFlight) {
      this.cancelFlight();
    } else {
      // 没有 SDK 飞行时仍可能通过 `map.raw.viewer` 发起了飞行。
      this.camera.cancelFlight();
    }
    this.camera.setView(options);
  }

  flyTo(view: CameraFlight): Promise<void> {
    this.assertActive('flyTo');
    const duration = finite(view.duration, 'duration');
    if (duration !== undefined && duration < 0) {
      throw invalidView('Camera duration must be zero or greater.');
    }

    const options = optionsFor(view);
    this.cancelFlight();
    return new Promise<void>((resolve, reject) => {
      const active: ActiveFlight = {
        reject: (reason) => {
          reject(reason);
        },
      };
      this.activeFlight = active;
      this.camera.flyTo({
        ...options,
        ...(duration === undefined ? {} : { duration }),
        complete: () => {
          if (this.activeFlight === active) {
            this.activeFlight = undefined;
            resolve();
          }
        },
        cancel: () => {
          if (this.activeFlight === active) {
            this.activeFlight = undefined;
            reject(cancelled());
          }
        },
      });
    });
  }

  cancelFlight(): void {
    if (!this.activeFlight) {
      return;
    }
    const active = this.activeFlight;
    this.activeFlight = undefined;
    this.camera.cancelFlight();
    active.reject(cancelled());
  }

  destroy(): void {
    this.disposed = true;
    this.cancelFlight();
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new GisError('Camera controller has been disposed.', {
        code: 'MAP_DISPOSED',
        module: 'camera',
        operation,
      });
    }
  }
}
