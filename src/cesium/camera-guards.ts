/**
 * 相机基向量模长平方的下界：低于它的旋转轴已经没有方向可言，对应约 1e-12 弧度的不可见旋转。
 */
const MIN_ROTATION_AXIS_SQUARED = 1e-24;

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

/** Cesium 相机在缩放分支中会被直接修改的位姿。 */
export interface CameraPose {
  position: Vector3Like;
  direction: Vector3Like;
  up: Vector3Like;
  right: Vector3Like;
}

interface RotatableCamera {
  /** 轴允许为空，用于兜住在 JS 侧传入退化参数的情况。 */
  rotate(axis: Vector3Like | undefined, angle?: number): void;
}

interface GuardedScene {
  readonly preUpdate?: {
    addEventListener(listener: () => void): (() => void) | undefined;
  };
  /** Cesium 未公开该控制器的 `update`，运行时按鸭子类型接管。 */
  readonly screenSpaceCameraController?: object;
}

/** 相机位姿兜底的释放入口与诊断计数。 */
export interface CameraPoseGuard {
  /** 本相机实例累计恢复异常位姿的次数。 */
  getRecoveryCount(): number;
  /** 移除帧监听并恢复控制器原有的更新方法。 */
  dispose(): void;
}

function isFiniteVector(vector: Vector3Like | undefined): boolean {
  return (
    !!vector && Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
  );
}

function hasFinitePose(camera: Partial<CameraPose> | undefined): boolean {
  return (
    isFiniteVector(camera?.position) &&
    isFiniteVector(camera?.direction) &&
    isFiniteVector(camera?.up) &&
    isFiniteVector(camera?.right)
  );
}

function isFinitePose(camera: Partial<CameraPose> | undefined): camera is CameraPose {
  return hasFinitePose(camera);
}

/** 原地复制向量，保留 Cesium 相机持有的对象引用。 */
function copyVector(target: Vector3Like, source: Vector3Like): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

/**
 * 给相机旋转补退化入参兜底，避免 Cesium 把相机本身写成 NaN。
 *
 * `ScreenSpaceCameraController` 的“绕光标缩放”用两个几乎同向的单位向量做叉积当旋转轴，
 * 浮点相消会把轴退化成零向量；`Camera.rotate` 先归一化该轴，零向量归一化得到 NaN，
 * 相机位置与朝向随即整体变成 NaN，下一帧可见集计算抛出 `RangeError`，渲染循环停止。
 * 被跳过的旋转量在 1e-8 弧度量级，远小于一个像素的视角。
 *
 * @returns 是否完成兜底安装；相机不提供 `rotate` 时返回 false。
 */
export function guardDegenerateCameraRotation(camera: RotatableCamera | undefined): boolean {
  if (typeof camera?.rotate !== 'function') {
    return false;
  }

  const rotate = camera.rotate.bind(camera);
  camera.rotate = (axis: Vector3Like | undefined, angle?: number) => {
    if (angle !== undefined && !Number.isFinite(angle)) {
      return;
    }
    const squared = axis ? axis.x * axis.x + axis.y * axis.y + axis.z * axis.z : Number.NaN;
    if (!(squared > MIN_ROTATION_AXIS_SQUARED)) {
      return;
    }
    rotate(axis, angle);
  };
  return true;
}

/**
 * 安装相机位姿兜底，在缩放更新后立即回滚 NaN，并在每帧开头处理被外部写坏的位姿。
 *
 * 四元数与位姿互为输入：一旦 NaN 进入相机，后续帧只会继续放大错误，因此必须在写入后
 * 立刻恢复上一次有效位姿。
 */
export function guardCameraPose(
  camera: Partial<CameraPose> | undefined,
  scene: GuardedScene,
): CameraPoseGuard {
  if (!isFinitePose(camera)) {
    return {
      getRecoveryCount: () => 0,
      dispose: () => undefined,
    };
  }

  const live: CameraPose = camera;
  const saved: CameraPose = {
    position: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 0 },
    right: { x: 0, y: 0, z: 0 },
  };
  let hasSaved = false;
  let recoveryCount = 0;

  const save = () => {
    copyVector(saved.position, live.position);
    copyVector(saved.direction, live.direction);
    copyVector(saved.up, live.up);
    copyVector(saved.right, live.right);
    hasSaved = true;
  };

  const check = (): boolean => {
    if (hasFinitePose(live)) {
      save();
      return false;
    }
    if (!hasSaved) {
      return false;
    }
    copyVector(live.position, saved.position);
    copyVector(live.direction, saved.direction);
    copyVector(live.up, saved.up);
    copyVector(live.right, saved.right);
    recoveryCount += 1;
    return true;
  };

  check();
  const removePreUpdate = scene.preUpdate?.addEventListener(check);
  const controller = scene.screenSpaceCameraController as { update?: () => void } | undefined;
  const originalUpdate = controller?.update;
  if (controller && typeof originalUpdate === 'function') {
    controller.update = () => {
      try {
        originalUpdate.call(controller);
      } catch (error: unknown) {
        if (check()) {
          return;
        }
        throw error;
      }
      check();
    };
  }

  return {
    getRecoveryCount: () => recoveryCount,
    dispose: () => {
      if (typeof removePreUpdate === 'function') {
        removePreUpdate();
      }
      if (controller && typeof originalUpdate === 'function') {
        controller.update = originalUpdate;
      }
    },
  };
}
