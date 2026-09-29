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

## 姿态积分

```ts
const attitude = new AttitudeDynamics(); // 单位四元数
attitude.setAngularVelocity({ x: 0, y: 0, z: Math.PI });
attitude.advance(0.01); // 推进 10ms
attitude.attitude; // 归一化后的四元数
```

`AttitudeDynamics` 用角速度做运动学积分，每步重新归一化，长时间运行不会因为浮点累积而漂移。它只表达"给定角速度下的朝向变化"，不涉及转动惯量与力矩。

积分是一阶的，**大步长会低估转角**：需要精确角度时用小步长（例如按帧 16ms），不要一次推进一大段时间。

## 当前边界

- **不做轨道预报与时序**：星历、机动与摄动模型不在本模块范围；
- **不做坐标转换**：六根数来自惯性系状态；要落到经纬高需要 ECI→ECEF 的岁差与自转换算，本 SDK 未提供（可用服务端星历或专业库转换后交给 `map.coordinates`）；
- **不做碰撞分析**：最近接近判定需要业务阈值与统计口径，未封装；
- **CZML 未发布**：需要交给 Cesium 时，可用 `map.raw.viewer` 自行组装 CZML，或直接用[折线图层](./polyline-layer.md)渲染采样点。
