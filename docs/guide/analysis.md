# 分析工具 map.analysis

`map.analysis` 把量算、通视、视域、坡度坡向这些分析能力收在一个按工具 ID 路由的入口下：输入与输出都按工具窄化类型，结果里带算法版本；需要地形高度的工具走 `map.terrain.sample()`，**不做**任何隐式的数据加载。

```ts
const { meters } = await map.analysis.run('distance', { from, to, units: 'kilometers' });

const los = await map.analysis.run('line-of-sight', { from, to });
// { visible, minClearanceMeters, blockedAtIndex, sampleCount, algorithmVersion }

const { horizon, blockedDistanceMeters } = await map.analysis.run('viewshed', {
  center,
  radiusMeters: 4_800,
});

const { slopeDegrees, aspectDegrees } = await map.analysis.run('slope-aspect', {
  center,
  radiusMeters: 200,
});

map.analysis.list(); // 13 个内置工具的 id / 名称 / 说明
```

取消与地形采样一致：`{ signal }` 中止后以 `ANALYSIS_ABORTED` 拒绝，已发出的地形请求不撤回但结果不再返回。

## 工具清单

| 工具 ID               | 输入要点                          | 结果要点                                              |
| --------------------- | --------------------------------- | ----------------------------------------------------- |
| `distance`            | `from`、`to`、可选 `units`        | 大圆距离（米 + 换算值 + 单位）                        |
| `surface-distance`    | 同上 + 可选分段数                 | 沿线采样地形后的三维折线长度与采样点数                |
| `area`                | `polygon`（环或带洞多边形）       | 球面面积（平方米 + 平方公里）                         |
| `bearing`             | `from`、`to`                      | 方位角（正北 0、顺时针为正）                          |
| `terrain-sample`      | `points`、可选 `strategy`/`level` | 与 `map.terrain.sample()` 同构，无数据的点标记 no-data |
| `line-of-sight`       | `from`、`to`、可选分段数          | 可见性、最小余隙、首个遮挡点序号                      |
| `viewshed`            | `center`、`radiusMeters`、方位数  | 可见范围边界环、最近遮挡距离                          |
| `slope-aspect`        | `center`、`radiusMeters`、邻域数  | 坡度、坡向、中心高度、参与拟合的采样点数              |
| `transform`           | `point`、`from`、`to`             | 目标 CRS 下的坐标                                     |
| `point-in-polygon`    | `point`、`polygon`                | 是否落在面内                                          |
| `points-in-polygon`   | `points`、`polygon`               | 命中下标、命中点、数量                                |
| `bbox`                | 点 / 环 / 多边形                  | 经纬包围盒                                            |
| `center-of-mass`      | 环 / 多边形                       | 质心                                                  |

除 `terrain-sample` 外，结果都带 `algorithmVersion`（当前 `1`）：算法口径变化时会递增，业务据此判断是否需要重算历史结果。

## 通视与视域的判定口径

两者都建立在同一条地形剖面判据上：

- **通视（`line-of-sight`）**：沿线取中间点，比较**直线视线高度**与地面高度，最小余隙为负即被遮挡，并给出首个遮挡点的序号。两个端点的高度优先用输入里的 `height`，没给就采样地形。`includeTerrain: false` 时完全不采样地形，只比较两端高度。
- **视域（`viewshed`）**：按方位扇形扫描，每条射线用**视线仰角的滑动最大值**做地平线包络——某点的仰角高于此前所有点才算可见。比"比上一点高"稳健，不会被中间的小起伏骗过。可见边界落在可见距离上（不是固定半径），`blockedDistanceMeters` 取所有射线上最早的遮挡距离。
- **坡度坡向（`slope-aspect`）**：在半径 `radiusMeters` 的圆环上采样，最小二乘拟合平面 `h = a·e + b·n + c`，坡度是梯度模长的反正切，坡向指向**下坡**方向（正北 0、顺时针）。平地（梯度趋近 0）的坡向没有意义，约定返回 0。
- **地球曲率**：默认忽略。几公里范围内的曲率下沉远小于地形起伏；需要精确口径时用 `/core` 的 `curvatureDropMeters()` 自行修正，或直接调用带 `applyEarthCurvature` 的底层函数。

## 默认采样与代价

| 工具                | 默认采样                          | 说明                                     |
| ------------------- | --------------------------------- | ---------------------------------------- |
| `surface-distance`  | 32 段（33 个点）                  | 覆盖线与两端高度，不额外采样端点         |
| `line-of-sight`     | 32 段（31 个中间点）              | 端点只在其高度缺失时参与采样             |
| `viewshed`          | 72 个方位 × 32 步 = 2304 个采样点 | 一次批量请求，命中地形缓存时代价很低     |
| `slope-aspect`      | 圆环 8 点 + 中心                  | 半径 100–500 米是常用范围                |

这些默认值可以在 `createAnalysisController()` 上覆盖；`map.analysis` 用 SDK 默认值。地形采样的分批、并发与缓存由 `map.terrain.sample()` 统一负责。

## 无数据与错误

- 缺地形数据的采样点**不参与**判定（不会伪造成 0 高），`sampleCount` 只计有效点。
- 整条线、整条射线或过多邻域点都没有数据时抛 `ANALYSIS_TERRAIN_UNAVAILABLE`（可重试：地形可能还在加载）。
- 半径非正、坐标非法等输入问题抛 `INVALID_ANALYSIS_INPUT`；未知工具 ID 抛 `UNKNOWN_ANALYSIS_TOOL`。
- 中止的调用抛 `ANALYSIS_ABORTED`。

## 与 `@yanbobo/gis-sdk/core` 的关系

`map.analysis` 只是一层路由：算法都在 `/core`，零渲染引擎依赖，可以直接在 Worker 或其它终端复用。

```ts
import {
  createAnalysisController,
  evaluateLineOfSight,
  evaluateHorizon,
  slopeAspectFromPlane,
  surfacePathLength,
} from '@yanbobo/gis-sdk/core';

const controller = createAnalysisController({
  sample: (points, options) => myTerrainPort.sample(points, options),
});
```

- `createAnalysisController(port)`：注入任意地形采样端口（端口签名与 `map.terrain.sample()` 相同）。
- `evaluateLineOfSight()` / `evaluateHorizon()` / `slopeAspectFromPlane()` / `surfacePathLength()` / `curvatureDropMeters()`：只要剖面或邻域点，纯计算、可离线复算。
- 量算、判断与 CRS 转换的纯函数见[空间计算与坐标转换](./spatial-analysis.md)。

## 当前边界

- **不做结果图层**：`viewshed` 给的是边界环，`line-of-sight` 给的是余隙数值；要显示就用[折线图层](./polyline-layer.md) / [点位图层](./points-layer.md) 自己渲染。
- **不做任务模型与 Worker 池**：没有任务队列、进度上报或后台执行；批量场景请在业务侧编排，必要时把 `/core` 的纯函数搬进自己的 Worker。
- **不做通视的高程插值细化**：剖面只在采样点上判定，采样越密越准；一个薄山脊正好落在两个采样点之间时可能漏判。
- **不做插件注册**：`list()` 目前只返回内置工具；插件工具 ID 的注册协议尚未发布。
