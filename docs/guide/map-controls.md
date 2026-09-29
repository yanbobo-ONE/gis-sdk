# 地图控制

本页说明当前 alpha 包已发布的基础地图控制：相机、一个 XYZ 底图和椭球 / Cesium Terrain 地形。它们都是地图实例的稳定句柄，调用方不需要保存 Cesium Provider 或 Camera 对象。

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

| 方法             | 参数           | 运行效果                                      | 可能抛出 / 拒绝                                  |
| ---------------- | -------------- | --------------------------------------------- | ------------------------------------------------ |
| `setView(view)`  | `CameraView`   | 立即切换视角，并先取消进行中的飞行            | `INVALID_CAMERA_VIEW`                            |
| `flyTo(view)`    | `CameraFlight` | 平滑飞行；完成时 Promise resolve              | `INVALID_CAMERA_VIEW`、`CAMERA_FLIGHT_CANCELLED` |
| `cancelFlight()` | 无             | 取消 SDK 发起的当前飞行；无进行中飞行时无操作 | 当前飞行以 `CAMERA_FLIGHT_CANCELLED` reject      |

`longitude` 必须在 `-180` 到 `180`，`latitude` 必须在 `-90` 到 `90`；`height`、姿态和 `duration` 必须是有限数，且 `duration` 不能为负数。再次调用 `flyTo()` 会先取消 SDK 的上一段飞行。

`setView()` 会先取消进行中的飞行。Cesium 的原生 `setView` 不会取消飞行，若不先取消，飞行会继续按帧覆写刚设置的视角。参数校验在取消之前完成，因此非法视角不会打断已有飞行。

地图创建时会为每个 Viewer 安装相机退化保护：跳过长度退化或非有限的旋转轴，并在每帧开始前把被写坏的相机位姿恢复为上一次有效位姿。这两道保护针对 Cesium 缩放分支在特定机位下把相机写成 `NaN`、进而中断渲染循环的问题，业务侧无需额外调用。

## 地形

默认是无网络请求的椭球地形。Cesium Terrain 服务采用异步加载：新 Provider 成功创建前，旧地形持续可用；加载失败不会留下半切换状态。

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
| `set(spec, options?)` | `TerrainSpec`    | 加载并替换地形；椭球模式立即生效                     | `INVALID_TERRAIN_CONFIG`、`TERRAIN_BUSY`、`TERRAIN_LOAD_FAILED` |
|                       | `{ timeoutMs? }` | 元数据请求超时，默认 `30000`；`0` 表示不限制         | `INVALID_TERRAIN_CONFIG`                                        |

地形元数据请求默认 30 秒超时。超时后当前地形保持不变并抛出可重试的 `TERRAIN_LOAD_FAILED`，切换状态随即释放，因此不会出现服务端一直无响应时永久 `TERRAIN_BUSY`、无法再次切换地形的情况。

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
