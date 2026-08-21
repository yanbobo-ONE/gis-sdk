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

当前只封装 XYZ。TMS、WMTS、单图、企业地图目录和缓存策略仍未发布；使用它们时可暂时通过 `map.raw.viewer` 调用 Cesium 公共 API，并由业务负责资源释放。

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
| `setView(view)`  | `CameraView`   | 立即切换视角                                  | `INVALID_CAMERA_VIEW`                            |
| `flyTo(view)`    | `CameraFlight` | 平滑飞行；完成时 Promise resolve              | `INVALID_CAMERA_VIEW`、`CAMERA_FLIGHT_CANCELLED` |
| `cancelFlight()` | 无             | 取消 SDK 发起的当前飞行；无进行中飞行时无操作 | 当前飞行以 `CAMERA_FLIGHT_CANCELLED` reject      |

`longitude` 必须在 `-180` 到 `180`，`latitude` 必须在 `-90` 到 `90`；`height`、姿态和 `duration` 必须是有限数，且 `duration` 不能为负数。再次调用 `flyTo()` 会先取消 SDK 的上一段飞行。

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

| 成员        | 参数          | 运行效果                                             | 可能拒绝                                                        |
| ----------- | ------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `type`      | 无            | 返回当前已安装的 `'ellipsoid'` 或 `'cesium-terrain'` | -                                                               |
| `set(spec)` | `TerrainSpec` | 加载并替换地形；椭球模式立即生效                     | `INVALID_TERRAIN_CONFIG`、`TERRAIN_BUSY`、`TERRAIN_LOAD_FAILED` |

地图销毁中或销毁后，对以上任一控制器的调用均会抛出 `MAP_DISPOSED`。`destroy()` 会取消进行中的相机飞行、移除 SDK 底图并停止后续地形切换。
