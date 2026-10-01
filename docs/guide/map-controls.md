# 地图控制

本页说明当前 alpha 包已发布的基础地图控制：相机、一个 XYZ 底图、椭球 / Cesium Terrain 地形，以及地图时钟。它们都是地图实例的稳定句柄，调用方不需要保存 Cesium Provider 或 Camera 对象。

## 初始化 XYZ 底图

```ts
import { createMap } from '@yanbobo/gis-sdk/cesium';

const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
  basemap: {
    type: 'xyz',
    url: 'https://tiles.example.com/{z}/{x}/{y}.png',
    opacity: 0.85,
  },
});
```

`url` 必须包含 `{z}`、`{x}`、`{y}`。SDK 将底图放在 index `0`，业务 WMS 等影像图层会在其上方；替换或清理底图不会移除由 `map.layers` 管理的图层。

### map.basemap

```ts
map.basemap.set({
  type: 'xyz',
  url: 'https://tiles-next.example.com/{z}/{x}/{y}.png',
});
map.basemap.setOpacity(0.6);
map.basemap.setVisible(false);
map.basemap.clear();
```

| 成员                  | 参数                | 运行效果                                            | 可能抛出                  |
| --------------------- | ------------------- | --------------------------------------------------- | ------------------------- |
| `type`                | 无                  | 返回 `'none'` 或 `'xyz'`                            | -                         |
| `visible` / `opacity` | 无                  | 返回当前 SDK 底图的显隐和透明度                     | -                         |
| `set(spec)`           | `XyzBasemapSpec`    | 原子替换底图；省略 `visible`/`opacity` 时保留当前值 | `INVALID_BASEMAP_CONFIG`  |
| `setVisible(value)`   | `boolean`           | 立即修改当前底图显隐，不重建 Provider               | -                         |
| `setOpacity(value)`   | `0` 到 `1` 的有限数 | 立即修改当前底图透明度，不重建 Provider             | `INVALID_BASEMAP_OPACITY` |
| `clear()`             | 无                  | 只释放 SDK 当前拥有的底图                           | -                         |

`map.basemap` 当前只封装“地图基础底图”的 XYZ 管理。TMS 与 WMTS 已通过[影像图层](./imagery-layers.md)的 `map.layers.add()` 发布；单图、企业地图目录和缓存策略仍未发布，临时使用时由业务通过 `map.raw.viewer` 管理资源。

## 相机

相机位置使用经纬度角度和米，SDK 在 Cesium 适配器内部完成弧度转换。

```ts
map.camera.setView({
  longitude: 116.39,
  latitude: 39.9,
  height: 30_000,
  heading: 0,
  pitch: -45,
});

await map.camera.flyTo({
  longitude: 121.47,
  latitude: 31.23,
  height: 10_000,
  duration: 1.2,
});
```

| 方法             | 参数           | 运行效果                                                   | 可能抛出 / 拒绝                                  |
| ---------------- | -------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `view`           | 无（只读）     | 当前位姿快照：经纬高（度 / 米）与航向 / 俯仰 / 翻滚        | `CAMERA_VIEW_UNAVAILABLE`                        |
| `viewRectangle`  | 无（只读）     | 当前视口在地表覆盖的经纬四至；不可用时为 `undefined`       | -                                                |
| `metersPerPixel` | 无（只读）     | 屏幕中心处每像素多少米；中心射线打不到椭球时为 `undefined` | -                                                |
| `setView(view)`  | `CameraView`   | 立即切换视角，并先取消进行中的飞行                         | `INVALID_CAMERA_VIEW`                            |
| `flyTo(view)`    | `CameraFlight` | 平滑飞行；完成时 Promise resolve                           | `INVALID_CAMERA_VIEW`、`CAMERA_FLIGHT_CANCELLED` |
| `cancelFlight()` | 无             | 取消 SDK 发起的当前飞行；无进行中飞行时无操作              | 当前飞行以 `CAMERA_FLIGHT_CANCELLED` reject      |

`longitude` 必须在 `-180` 到 `180`，`latitude` 必须在 `-90` 到 `90`；`height`、姿态和 `duration` 必须是有限数，且 `duration` 不能为负数。再次调用 `flyTo()` 会先取消 SDK 的上一段飞行。

### 读取当前视角

```ts
const view = map.camera.view;
// { longitude, latitude, height, heading, pitch, roll } 全部存在，角度为度

const bounds = map.camera.viewRectangle;
// { west, south, east, north }（度）或 undefined

map.camera.setView(view); // 快照可以直接传回 setView() / flyTo()
```

与传入侧的 `CameraView` 不同，`view` 的每个字段都一定存在，可以直接参与计算或原样传回 `setView()`。两种取值都反映**当前**相机状态，包括业务通过 `map.raw.viewer` 发起的飞行。

- `view` 在相机位姿退化（例如相机落到地心、位姿为 `NaN`）时抛 `CAMERA_VIEW_UNAVAILABLE`；这类位姿会被地图创建时安装的退化保护在下一帧修复，因此调用方按可重试错误处理即可。
- `viewRectangle` 在相机看不到椭球（例如指向天空）或视野覆盖全球时返回 `undefined`，而不是给出全球范围的假四至。二维模式下同样是当前视口范围，可直接用于按图幅查询业务数据。

### 按屏幕像素换算世界尺度

`metersPerPixel` 把"屏幕上多少像素"和"地面上多少米"接起来，用于聚合网格、符号大小、LOD 阈值这类按像素设计的策略：

```ts
const perPixel = map.camera.metersPerPixel; // 屏幕中心处，二维 / 三维都适用
if (perPixel !== undefined) {
  // 每 48 像素合并成一个聚合簇
  const clusters = clusterPoints(points, { cellSizeMeters: perPixel * 48 });
}
```

深度基准是**屏幕中心与椭球的交点**，因此它随缩放和倾斜变化；中心射线打不到椭球（指向天空）时返回 `undefined`——不要用一个猜的近似值替代，那会让聚合在天空视角下行为突变。

`setView()` 会先取消进行中的飞行。Cesium 的原生 `setView` 不会取消飞行，若不先取消，飞行会继续按帧覆写刚设置的视角。参数校验在取消之前完成，因此非法视角不会打断已有飞行。

地图创建时会为每个 Viewer 安装相机退化保护：跳过长度退化或非有限的旋转轴，并在每帧开始前把被写坏的相机位姿恢复为上一次有效位姿。这两道保护针对 Cesium 缩放分支在特定机位下把相机写成 `NaN`、进而中断渲染循环的问题，业务侧无需额外调用。

## 地形

默认是无网络请求的椭球地形。Cesium Terrain 服务采用异步加载：新 Provider 成功创建前，旧地形持续可用；加载失败不会留下半切换状态。

地形服务地址既可以在创建时声明，也可以之后切换：

```ts
const map = createMap({
  container: 'map',
  terrain: { type: 'cesium-terrain', url: 'https://terrain.example.com/' },
});

await map.terrain.ready; // 创建期声明的地形安装完成；失败则在这里拒绝
```

```ts
await map.terrain.set({
  type: 'cesium-terrain',
  url: 'https://terrain.example.com/',
  requestVertexNormals: true,
  requestWaterMask: true,
});

await map.terrain.set({ type: 'ellipsoid' });
```

| 成员                  | 参数             | 运行效果                                             | 可能拒绝                                                        |
| --------------------- | ---------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `type`                | 无               | 返回当前已安装的 `'ellipsoid'` 或 `'cesium-terrain'` | -                                                               |
| `pending`             | 无               | 是否有地形安装在途（含创建期声明的初始加载）         | -                                                               |
| `ready`               | 无               | `createMap({ terrain })` 的初始地形何时可用          | `TERRAIN_LOAD_FAILED`                                           |
| `set(spec, options?)` | `TerrainSpec`    | 加载并替换地形；椭球模式立即生效                     | `INVALID_TERRAIN_CONFIG`、`TERRAIN_BUSY`、`TERRAIN_LOAD_FAILED` |
|                       | `{ timeoutMs? }` | 元数据请求超时，默认 `30000`；`0` 表示不限制         | `INVALID_TERRAIN_CONFIG`                                        |

创建期声明地形的语义与 `set()` 一致，只是把地址写在创建处；`INVALID_TERRAIN_CONFIG`（类型未知、`url` 为空、开关不是布尔）在 `createMap` 时同步抛出，不会先建出地图再失败。初始加载失败时 `map.terrain.type` 保持 `'ellipsoid'`——不会静默改用其他地形服务——错误同时经 `map.terrain.ready` 拒绝与 `map:error` 上报一次，因此不 `await` 也不会丢错误。初始加载在途时调用 `set()` 会以可重试的 `TERRAIN_BUSY` 拒绝。

地形元数据请求默认 30 秒超时。超时后当前地形保持不变并抛出可重试的 `TERRAIN_LOAD_FAILED`，切换状态随即释放，因此不会出现服务端一直无响应时永久 `TERRAIN_BUSY`、无法再次切换地形的情况。

外部服务地址（瓦片、地形、影像、数据）的统一约定见[外部接入点](./external-endpoints.md)。

### 地形高度采样

`sample()` 批量读取地形高度，结果顺序与输入一致：

```ts
const samples = await map.terrain.sample([
  { longitude: 116.39, latitude: 39.9 },
  { longitude: 121.47, latitude: 31.23 },
]);

for (const sample of samples) {
  if (sample.status === 'ok') {
    console.log(sample.longitude, sample.latitude, sample.height);
  }
}
```

| 字段     | 说明                                               |
| -------- | -------------------------------------------------- |
| `height` | 椭球高，单位为米；该点没有地形数据时为 `undefined` |
| `status` | `ok` 表示取到高度；`no-data` 表示该点没有可用瓦片  |

采样配置与异常：

| 配置项     | 默认值            | 说明                                                             |
| ---------- | ----------------- | ---------------------------------------------------------------- |
| `strategy` | `'most-detailed'` | 当前地形服务不提供可用层级时（例如椭球地形）自动退化为 `'level'` |
| `level`    | `0`               | `'level'` 策略使用的层级                                         |
| `signal`   | 无                | 取消尚未完成的采样                                               |

| 错误码                         | 原因                               |
| ------------------------------ | ---------------------------------- |
| `INVALID_TERRAIN_CONFIG`       | 采样点为空，或单次超过 2048 点     |
| `INVALID_COORDINATES`          | 采样点坐标非有限数或超出经纬度范围 |
| `TERRAIN_SAMPLING_UNAVAILABLE` | 当前场景没有地形服务               |
| `TERRAIN_SAMPLING_ABORTED`     | 调用方取消                         |
| `TERRAIN_SAMPLING_FAILED`      | 请求或解析失败；可重试             |
| `TERRAIN_DISPOSED`             | 地图已销毁后继续采样               |

相同位置、策略和层级会命中缓存（坐标量化到 1e-5 度，约 1 米），因此对同一区域反复采样只会产生一次请求。切换地形会清空缓存。采样是椭球高，不是正高；需要贴地放置对象时，把 `height` 传回 `map.layers.add()` 或 `setTransform()` 即可。

地图销毁中或销毁后，对以上任一控制器的调用均会抛出 `MAP_DISPOSED`。`destroy()` 会取消进行中的相机飞行、移除 SDK 底图并停止后续地形切换。

## 地图时钟

`map.clock` 读写地图时间轴。CZML 与其它带时间区间的动态实体都按当前地图时间求值，因此推进时钟就能播放轨迹。时间单位统一是**毫秒时间戳**——CZML 文档里的秒要乘 1000。

```ts
const snapshot = map.clock.snapshot;
// { time, startTime, endTime, multiplier, animating }

map.clock.setRange(Date.parse('2026-09-30T00:00:00Z'), Date.parse('2026-09-30T06:00:00Z'));
map.clock.setTime(Date.parse('2026-09-30T01:00:00Z'));
map.clock.setMultiplier(8);
map.clock.setAnimating(true);
```

| 成员                     | 参数                | 运行效果                                  | 可能抛出                 |
| ------------------------ | ------------------- | ----------------------------------------- | ------------------------ |
| `snapshot`               | 无（只读）          | 当前读数：时间、范围、倍率、是否推进      | `CLOCK_TIME_UNAVAILABLE` |
| `time`                   | 无（只读）          | 当前地图时间（毫秒时间戳）                | `CLOCK_TIME_UNAVAILABLE` |
| `setTime(value)`         | 毫秒时间戳或 `Date` | 跳转到指定时间                            | `INVALID_CLOCK_CONFIG`   |
| `setRange(start, end)`   | 毫秒时间戳或 `Date` | 设置时间范围，结束不得早于开始            | `INVALID_CLOCK_CONFIG`   |
| `setMultiplier(value)`   | 正有限数            | 设置倍率                                  | `INVALID_CLOCK_CONFIG`   |
| `setAnimating(value)`    | `boolean`           | 开始或停止推进                            | `INVALID_CLOCK_CONFIG`   |
| `bind(source, options?)` | `SimulationClock`   | 用 SDK 时钟驱动地图时钟，返回解除绑定函数 | `INVALID_CLOCK_CONFIG`   |

`setTime()` 等直接写入只在**未绑定** SDK 时钟时生效。绑定期间地图时间以源时钟为准，直接写入会在下一帧被覆盖，控制播放请用源时钟的方法。

### 用仿真时钟驱动

`bind()` 把[仿真 / 回放时钟](./simulation-clock.md)接成地图的时间来源，业务不必自己写帧循环：

```ts
import { SimulationClock } from '@yanbobo/gis-sdk/core';

const clock = new SimulationClock({
  startTime: Date.parse('2026-09-30T00:00:00Z'),
  endTime: Date.parse('2026-09-30T06:00:00Z'),
  initialTime: Date.parse('2026-09-30T00:00:00Z'),
  rate: 8,
});

const unbind = map.clock.bind(clock); // 默认 drive: true
clock.play();
clock.seek(Date.parse('2026-09-30T02:00:00Z'));

unbind(); // 之后地图时钟不再跟随源时钟
```

`drive: true`（默认）时，控制器在每个渲染帧按真实帧间隔调用 `source.advance()`，因此 `play()` / `pause()` / `seek()` / `setRate()` / `setDirection()` 都由源时钟负责，源时钟自己按倍率推进、地图时钟的倍率恒为 1。帧间隔取非负值：挂起恢复或系统时间回拨都不会让时间倒退。

`bind(clock, { drive: false })` 只做镜像、不推进，适合推进由业务负责的场景（例如实时样本驱动，配合 `setWatermark()` 使用）。源时钟还没有时间基准（`currentTime` 为 `undefined`，即尚未 `seek()`）时不做任何镜像，时钟保持原值。重复 `bind()` 会先解除上一次绑定，因此始终只有一个帧回调。

CZML 图层文档里自带的 `clock` 不会被自动应用——时间轴联动属于业务编排，用 `map.clock.bind()` 显式接上即可。
