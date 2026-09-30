# 空间计算与坐标转换

`@yanbobo/gis-sdk/core` 导出一层**纯计算**的空间能力：量算、空间判断与坐标参考系转换。这一层不依赖 Cesium、不触碰 DOM，接收普通对象、返回普通对象，可以直接在 Node、Worker 或任意前端框架里调用。

下面这些函数是[分析工具](./analysis.md)（`map.analysis`）的算法底座，也可以单独使用：控制器只负责按工具 ID 路由与取地形高度，计算全部在这里。

## 量算

```ts
import { measureArea, measureBBox, measureDistance } from '@yanbobo/gis-sdk/core';

const { meters, value, unit } = measureDistance(
  { longitude: 116.39, latitude: 39.9 },
  { longitude: 121.47, latitude: 31.23 },
  { units: 'kilometers' },
);

measurePathLength(trackPoints); // 折线总长
measureArea({ outer: ring, holes: [holeRing] }); // 洞面积会被扣除
measureBearing(from, to); // 起始方位角（度）
measureDestination(from, 90, 1_000); // 起点 + 方位角 + 米 → 目标点
measureBBox({ outer: ring }); // { west, east, south, north }，可直接喂相机
measureCenterOfMass({ outer: ring }); // 面积质心
pointAlongPath(path, 5_000); // 沿线等距取点（超长时钳制到终点）
nearestPointOnPath(path, target); // { point, index, distanceMeters, alongMeters }
```

| 方法                                          | 输入                           | 返回                                            |
| --------------------------------------------- | ------------------------------ | ----------------------------------------------- |
| `measureDistance(from, to, options?)`         | 两个点；`units` 为米/公里/海里 | `{ meters, value, unit }`，米制值始终给出       |
| `measurePathLength(points, options?)`         | 至少 2 个顶点                  | 同上                                            |
| `measureArea(ring \| polygon)`                | 顶点环或 `{ outer, holes }`    | `{ squareMeters, squareKilometers }`            |
| `measureBearing(from, to)`                    | 两个点                         | `{ degrees }`，正北为 0，顺时针为正             |
| `measureDestination(origin, bearing, meters)` | 点 + 度数 + 米                 | 目标点                                          |
| `measureBBox(input)`                          | 点、顶点序列或带洞多边形       | `{ west, east, south, north }`                  |
| `measureCenterOfMass(input)`                  | 顶点序列或带洞多边形           | 质心点：多边形按面积质心，顶点序列按顶点平均    |
| `pointAlongPath(points, meters)`              | 折线 + 距离                    | 折线上的点                                      |
| `nearestPointOnPath(points, target)`          | 折线 + 目标点                  | `{ point, index, distanceMeters, alongMeters }` |

## 点聚合

```ts
import { clusterPoints } from '@yanbobo/gis-sdk/core';

const clusters = clusterPoints(stations, {
  cellSizeMeters: 1_000, // 网格边长按米给
  positionOf: (station) => station.position,
  minCount: 1, // 少于这么多成员的簇不返回
});
// [{ id, center, count, members, bounds }, ...]
```

只做分组、不做渲染：业务可以把簇当成一个点交给[点位图层](./points-layer.md)（用 `count` 决定大小），也可以把少于阈值的簇展开成原始点——"什么时候展开、怎么画"是渲染策略，SDK 不替业务决定。

- **网格边长按米给**：先按当前纬度把米换算成经纬步长，因此同样的 `cellSizeMeters` 在不同纬度覆盖的地面面积一致，高纬度不会被过度聚合。
- **跨 180° 经线安全**：经度用相对首个点的连续值参与计算，不会把一簇数据拆成两簇。
- **输出稳定**：按网格行列排序（从南到北、从西到东），同样的数据重复聚合得到同样的 `id`，可以直接用作渲染对象的 id。
- **复杂度 O(n)**：逐点分桶，没有成对比较，十万级点位也不需要 Worker。

需要"按屏幕像素聚合"（缩放时簇自动合并/展开）时，业务把当前视野下的分辨率换算成 `cellSizeMeters` 再调用即可；SDK 不内置按像素的网格，因为那等于替业务定义交互语义。

## 几何构造与校验

```ts
import { convexHull, simplifyPath, simplifyRing, validatePolygon } from '@yanbobo/gis-sdk/core';

convexHull(points);                       // 闭合凸包环，跨半球点集应先投影
simplifyPath(ring, 50);                   // RDP 抽稀，容差单位为米：{ points, removedCount }
simplifyRing(ring, 50);                   // 同理，但保证结果闭合
validatePolygon(polygon, { requireClosed: true }); // 问题列表，空数组表示通过
```

三者都是零依赖实现：凸包是安德鲁单调链，抽稀是 Ramer–Douglas–Peucker（距离用 `nearestPointOnPath()` 的米制口径，高纬度不会过抽），多边形校验含包围盒扫描的自交检测。需要依赖几何引擎的缓冲区与叠加分析仍按 `docs/research/spatial-analysis-plan.md` §3.3 的三选一推进，尚未引入。

## 空间判断

```ts
import { filterPointsInPolygon, isPointInPolygon } from '@yanbobo/gis-sdk/core';

const zone = { outer: fenceRing, holes: [forbiddenRing] };

isPointInPolygon(target, zone); // 支持外环与内环（洞）
isPointInPolygon(target, zone, { ignoreBoundary: true }); // 边界点算未命中

// 批量：先用包围盒预筛，再逐点判断；返回命中下标与命中点
const { indexes, points, count } = filterPointsInPolygon(candidates, zone);

normalizeRingWinding(ring, 'counterclockwise'); // 绕向规范化（GeoJSON 外环要求逆时针）
```

## 坐标参考系转换

```ts
import { describeCrs, registerChinaCrs, transformGeoPoint } from '@yanbobo/gis-sdk/core';

// 注册 CGCS2000 地理坐标 + 指定带号的高斯带（不预设全集，带号由调用方点名）
registerChinaCrs({ zones: [39] }); // 3 度带 39 号 → 中央经线 117°E，code 为 CGCS2000-GK-3D-CM117E

describeCrs('CGCS2000-GK-3D-CM117E');
// → { kind: 'projected', units: 'm', ellipsoid: 'GRS80', centralMeridian: 117, zone: 39, zoneWidth: 3, ... }

// 投影与回算
const projected = transformGeoPoint(
  { longitude: 116.39, latitude: 39.9 },
  'EPSG:4490',
  'CGCS2000-GK-3D-CM117E',
);
// → { longitude: 447833.66, latitude: 4418603.79 }（东坐标 / 北坐标，单位米）

transformGeoPoint(projected, 'CGCS2000-GK-3D-CM117E', 'EPSG:4490'); // 回算精确
transformGeoPath(csvPoints, 'EPSG:4547', 'EPSG:4490'); // 批量转换，顺序不变
```

**投影坐标下的 `longitude` / `latitude` 字段是东坐标与北坐标（米）**，不是经纬度：字段名沿用同一套结构，含义随 CRS 变化。地理坐标输入会做 `±180 / ±90` 范围校验，投影坐标只要求是有限数。

| 方法                                    | 说明                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| `registerCrs(code, definition)`         | 注册 proj4 字符串或 WKT；重复注册需显式 `{ overwrite: true }` |
| `registerChinaCrs(options)`             | 注册 `EPSG:4490` 与指定带号的高斯带；返回注册后的描述列表     |
| `listCrs()` / `describeCrs(code)`       | 列出已注册 CRS / 查看中央经线、带号、单位与坐标类型           |
| `transformGeoPoint(point, from, to)`    | 单点转换                                                      |
| `transformGeoPath` / `transformGeoRing` | 批量转换，顺序与数量不变                                      |

带号与中央经线按公式计算并校验范围：**3 度带 `CM = 3n`、6 度带 `CM = 6n − 3`，合法带号对应 75°E–135°E**。x 坐标两套约定分别对应"东坐标带带号前缀"（`x_0 = 带号 × 1000000 + 500000`）与"不带前缀"（`x_0 = 500000`），用 `withZonePrefix` 选择。

**SDK 不预设 EPSG 号段**：proj4 自带定义里没有 CGCS2000 与中国高斯带，也没有 UTM 各带，需要自行注册；`registerChinaCrs` 生成的 code 是 SDK 约定名（如 `CGCS2000-GK-3D-CM117E`）。要按 EPSG 号（例如 4547）登记时，请先核对中央经线、`x_0` 与单位再传入 `code`，SDK 不校验该号与 EPSG 注册表的对应关系。

## 精度与容差

量算基于**球面模型（R = 6371008.8 m，turf）**，不是 WGS84 椭球。与 Cesium `EllipsoidGeodesic` 的实测偏差在中纬度约 0.1%–0.2%，任何尺度上都小于 0.5%；需要椭球精度的场景请用 `map.raw.viewer` 的 Cesium 原生测地线。这条容差在 `tests/spatial-cross-validation.test.ts` 里用真实 Cesium 作为第二实现锁定。

## 限额与错误码

| 常量                    | 值       | 含义                     |
| ----------------------- | -------- | ------------------------ |
| `MAX_BATCH_POINTS`      | `200000` | 单次批量判断的点数上限   |
| `MAX_GEOMETRY_VERTICES` | `200000` | 单个环或折线的顶点数上限 |

| 错误码                   | 场景                                                    |
| ------------------------ | ------------------------------------------------------- |
| `INVALID_COORDINATES`    | 坐标非有限数，或地理坐标超出 `±180 / ±90`               |
| `INVALID_ANALYSIS_INPUT` | 分析工具半径非正等参数问题                              |
| `ANALYSIS_TERRAIN_UNAVAILABLE` | 分析所需的地形高度不可用（可重试）                |
| `ANALYSIS_ABORTED`       | 分析调用被 `signal` 中止                                |
| `UNKNOWN_ANALYSIS_TOOL`  | 请求了未注册的分析工具 ID                               |
| `INVALID_SPATIAL_INPUT`  | 顶点不足、形状不是数组、单位/绕向取值不受支持、超过限额 |
| `INVALID_CRS_DEFINITION` | 标识或定义为空、重复注册、带号越界、宽度不是 3 或 6     |
| `UNSUPPORTED_CRS`        | 转换用到的 CRS 既未注册、也不是 proj4 内置定义          |

所有失败都抛 `GisError`，`module` 为 `spatial`，`code` 稳定可用于分支判断。没有结果的情况（例如屏幕拾取未命中）不在这里——那属于 `map.coordinates`。

## 包体积

`src/spatial` 依赖 `proj4`（约 42 KB gzip）与若干 turf 子包（量算与判断路径去掉 proj4 后约 1.4 KB）。

**只要从 `/core` 导入，就会带上 proj4**：`proj4` 没有声明 `sideEffects: false`，打包器无法在保留模块的前提下丢弃它的顶层副作用。实测数据与可选方案见 `docs/research/spatial-analysis-plan.md` §3.5。只用 turf 一侧能力、且对体积敏感的应用，可以按该节给出的方案在 P1/P2 之前自建子入口。

## 当前边界

- [分析工具](./analysis.md)（`map.analysis`）已可用：量算、判断、CRS 转换、地形采样、通视、视域与坡度坡向。
- 分析结果图层、任务模型与 Worker 执行接口尚未提供：`run()` 直接返回数值，渲染与后台编排由业务自己做。
- 凸包、抽稀、多边形校验与点聚合已提供（零依赖）；缓冲区、叠加分析与 Delaunay/Voronoi 尚未提供（等待 §3.3 的依赖三选一）。
- 不提供任何交互 UI：点选量算面板、结果标注样式属于应用层。
- 多边形合法性校验（自交诊断）依赖 `@turf/boolean-valid`，排在 P2。
- CGCS2000 与 WGS84 在现有业务尺度按恒等处理；厘米级基准转换需要七参数或格网改正，本 SDK 不承诺。
