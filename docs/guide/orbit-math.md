# 轨道与姿态数学

这两块是纯计算：**开普勒轨道六根数与二体传播**，以及**刚体姿态积分**。它们不依赖 Cesium、不触碰 DOM，可以在主线程、Worker 或服务端使用。

```ts
import {
  AttitudeDynamics,
  calculateOrbitalElements,
  propagateTwoBody,
} from '@yanbobo/gis-sdk/core';

const state = {
  position: { x: 6_878_137, y: 0, z: 0 },
  velocity: { x: 0, y: 7_613, z: 0 },
};

const elements = calculateOrbitalElements(state);
elements.eccentricity; // ≈ 0（圆轨道）
elements.inclination; // 弧度
elements.periodSeconds; // 轨道周期

// 传播 600 秒（回放补帧、短时推演）
const next = propagateTwoBody(state, 600);
```

## 六根数

| 字段                  | 说明                                  |
| --------------------- | ------------------------------------- |
| `semiMajorAxis`       | 半长轴（米）                          |
| `eccentricity`        | 偏心率                                |
| `inclination`         | 倾角（弧度）                          |
| `ascendingNode`       | 升交点赤经（弧度）；赤道轨道按 0 返回 |
| `argumentOfPeriapsis` | 近地点幅角（弧度）；圆轨道按 0 返回   |
| `trueAnomaly`         | 真近点角（弧度）                      |
| `periodSeconds`       | 周期 `2π√(a³/μ)`                      |

圆轨道与赤道轨道这类退化情形不会产生 `NaN`：无定义的角按 0 返回。引力常数默认取地球（`EARTH_MU = 3.986004418e14`），可用第二个参数换成其它天体。

## 二体传播的模型边界

`propagateTwoBody` 只做**二体运动学**：没有 J2 摄动、大气阻力、三体效应与机动。它适合回放补帧与短时间推演；**长时间传播会累积误差**，需要高精度预报时应接入专业轨道力学库或服务端星历。

开普勒方程用二分法求解（椭圆轨道上该函数单调），高偏心率下也不会发散。逃逸轨道（比能量非负）会以 `INVALID_SPATIAL_INPUT` 拒绝。

## 由锚点生成轨道并采样

交互上最常见的需求是"点一下地图，得到一条过该点的轨道"：

```ts
import { orbitalElementsFromAnchor, sampleOrbitPositions } from '@yanbobo/gis-sdk/core';

const elements = orbitalElementsFromAnchor(116.39, 39.9, 500_000); // 经度、纬度、高度（米）
const positions = sampleOrbitPositions(elements); // 361 个经纬高点，首尾重合

await map.layers.add({
  id: 'orbit',
  type: 'polyline',
  material: 'glow',
  polylines: [{ positions }],
});
```

- `orbitalElementsFromAnchor()` 用锚点径向与当地东向的叉积确定轨道面，因此轨道一定穿过锚点，倾角与锚点纬度相适应（赤道锚点给出赤道轨道，极点锚点给出极轨）；返回的根数与 `calculateOrbitalElements` 一致，角度单位为**弧度**。
- `sampleOrbitPositions()` 生成可渲染的经纬高序列（默认 361 点、首尾重合），**可以直接交给折线图层**；`samples` 必须是不小于 36 的整数。

**与 Plugin-web 的一处差异**：参考实现为了滑块交互会对越界的半长轴、偏心率与锚点做静默收敛（clamp）；SDK 改成**校验并抛错**（`INVALID_SPATIAL_INPUT`），避免调用方拿到与输入不符的几何却毫无察觉。需要滑块体验时在业务侧自行钳制取值。

**坐标简化**：采样把惯性系方向直接当作地固系方向，没有做 ECI→ECEF 的岁差与自转转换。对"看轨道形状与倾角"足够，但不能用来判断某时刻卫星在哪个城市上方。

## 姿态积分

```ts
const attitude = new AttitudeDynamics(); // 单位四元数
attitude.setAngularVelocity({ x: 0, y: 0, z: Math.PI });
attitude.advance(0.01); // 推进 10ms
attitude.attitude; // 归一化后的四元数
```

`AttitudeDynamics` 用角速度做运动学积分，每步重新归一化，长时间运行不会因为浮点累积而漂移。它只表达"给定角速度下的朝向变化"，不涉及转动惯量与力矩。

积分是一阶的，**大步长会低估转角**：需要精确角度时用小步长（例如按帧 16ms），不要一次推进一大段时间。

## 姿态的四元数运算

姿态在数据侧常以两种形式出现：CZML 的 `unitQuaternion` 采样，和模型图层 / 相机用的航向、俯仰、翻滚（度）。两者互转与插值都由 `/core` 提供：

```ts
import {
  headingPitchRollDegreesFromQuaternion,
  quaternionFromHeadingPitchRollDegrees,
  slerp,
} from '@yanbobo/gis-sdk/core';

const attitude = quaternionFromHeadingPitchRollDegrees({ heading: 40, pitch: -25, roll: 15 });
headingPitchRollDegreesFromQuaternion(attitude); // { heading: 40, pitch: -25, roll: 15 }

// 两个姿态之间插值（走最短弧），用于回放补帧
slerp(previous, next, 0.35);
```

| 函数                                      | 说明                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `quaternionFromHeadingPitchRollDegrees()` | 航向 / 俯仰 / 翻滚（度）→ 单位四元数，与 Cesium 的 `HeadingPitchRoll` 逐位一致 |
| `headingPitchRollDegreesFromQuaternion()` | 反解：航向 ∈ [0,360)、俯仰 ∈ [-90,90]、翻滚 ∈ (-180,180]                       |
| `slerp(from, to, ratio)`                  | 四元数球面线性插值，夹角极小时退化为归一化线性插值；比例自动夹到 [0,1]         |
| `normalizeQuaternion(value)`              | 归一化；全零或非有限值抛 `INVALID_SPATIAL_INPUT`                               |

**口径与 Cesium 对齐**（航向绕 -Z、俯仰绕 -Y、翻滚绕 +X，组合顺序 `heading · pitch · roll`）：同一组角度传给 SDK 的模型图层与直接交给 Cesium 得到的是同一个姿态。这两组换算在 `tests/attitude-quaternion.test.ts` 里用真实 Cesium 的 `Quaternion.fromHeadingPitchRoll` 与 `Quaternion.slerp` 作为第二实现逐位比对。

## 最近接近预警

```ts
import { findClosestApproaches } from '@yanbobo/gis-sdk/core';

const warnings = findClosestApproaches(
  [
    { id: 'sat-1', position: { x: -10_000, y: 0, z: 0 }, velocity: { x: 1_000, y: 0, z: 0 } },
    {
      id: 'sat-2',
      position: { x: 10_000, y: 0, z: 0 },
      velocity: { x: -1_000, y: 0, z: 0 },
      radiusMeters: 20,
    },
  ],
  { horizonSeconds: 60, thresholdMeters: 100 },
);
// → [{ firstId: 'sat-1', secondId: 'sat-2', timeSeconds: 10, distanceMeters: 0 }]
```

对每一对物体求相对运动的最近点：最近时刻为 `clamp(−(r·v)/|v|², 0, 窗口)`；最近距离不超过 `max(阈值, 两半径之和)` 时给出告警，结果按最近时刻升序。

两点要注意：

- **O(n²) 两两比较**：几百个对象没问题，成千上万时应先按空间分箱裁剪候选对；
- **窗口内按匀速直线处理**：只适合短窗口预警。长时间推演请先用 `propagateTwoBody` 采样，再对采样序列比较。

## 当前边界

- **不做轨道预报与时序**：星历、机动与摄动模型不在本模块范围；
- **不做坐标转换**：六根数来自惯性系状态；要落到经纬高需要 ECI→ECEF 的岁差与自转换算，本 SDK 未提供（可用服务端星历或专业库转换后交给 `map.coordinates`）；
- **不做参考几何标注**：Plugin-web 的升交点/降交点标记、春分点、赤道圈、倾角弧等展示几何含较多展示参数，未移植；
- **不做碰撞规避建议**：只给"何时、多近"的告警，不含规避策略或风险等级口径；
- **CZML 未发布**：需要交给 Cesium 时，可用 `map.raw.viewer` 自行组装 CZML，或直接用[折线图层](./polyline-layer.md)渲染采样点。
