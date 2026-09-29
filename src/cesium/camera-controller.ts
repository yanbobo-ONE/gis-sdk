import { Cartesian3, Math as CesiumMath } from 'cesium';
import type { Camera } from 'cesium';

import type { CameraController, CameraFlight, CameraView } from '../core/controls.js';
import { GisError } from '../core/errors.js';

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

  constructor(private readonly camera: Pick<Camera, 'cancelFlight' | 'flyTo' | 'setView'>) {}

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
