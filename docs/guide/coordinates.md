# 坐标转换

`map.coordinates` 提供 WGS84 经纬度、地心直角坐标（ECEF，米）与窗口像素坐标之间的类型化转换。所有角度单位都是度，所有长度单位都是米。

```ts
const map = createMap({ container: 'map', cesiumBaseUrl: '/cesium/' });

// 经纬高 → 世界坐标
const world = map.coordinates.toWorld({ longitude: 116.39, latitude: 39.9, height: 120 });

// 世界坐标 → 经纬高
const geo = map.coordinates.toGeoPosition(world);

// 经纬高 → 窗口像素（用于贴标签、弹窗定位）
const pixel = map.coordinates.toWindow({ longitude: 116.39, latitude: 39.9 });

// 鼠标像素 → 地球表面经纬高（用于点击落点、绘制起点）
const picked = map.coordinates.pickGeoPosition({ x: event.offsetX, y: event.offsetY });
```

## 返回值语义

| 方法                     | 参数          | 返回                                               |
| ------------------------ | ------------- | -------------------------------------------------- |
| `toWorld(position)`      | `GeoPosition` | `{ x, y, z }`，单位为米                            |
| `toGeoPosition(world)`   | `{ x, y, z }` | `{ longitude, latitude, height }`                  |
| `toWindow(position)`     | `GeoPosition` | `{ x, y }`，点在视锥外或被地球遮挡时为 `undefined` |
| `pickGeoPosition(point)` | `{ x, y }`    | `GeoPosition`，射线未命中地球表面时为 `undefined`  |

**`undefined` 表示"没有结果"**，不是失败：投影到屏幕外的点和落在太空里的鼠标位置都属于正常情况。SDK 不会返回 `0, 0` 这类伪坐标，以免调用方把无效像素当成有效值使用。

输入本身非法会抛出 `INVALID_COORDINATES`：经纬度必须是有限数且落在 `-180..180` / `-90..90` 内，`height` 与窗口坐标分量必须是有限数。`height` 省略时按 0（椭球面）处理。

## 与原生接口的关系

`toWindow()` 走 `SceneTransforms.worldToWindowCoordinates`，`pickGeoPosition()` 走 `camera.getPickRay()` 加 `scene.globe.pick()`。需要拾取 Cesium 实体、3D Tiles 或自定义图元时，仍然使用 `map.raw.viewer.scene.pick()`；本模块只负责坐标换算。

地形高度不在本模块范围内：`toGeoPosition()` 与 `pickGeoPosition()` 返回的是椭球高，需要贴合地形时用[地形采样](./map-controls.md)获取高程后再作为 `height` 传入。
