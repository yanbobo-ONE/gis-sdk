# 静态模型图层

适用于车辆、设备、地面站等由 glTF / GLB 表达的单个静态模型。SDK 在模型加载成功后才加入场景；取消、移除和地图销毁都会释放 SDK 创建的 Primitive。

## 添加模型

```ts
const vehicle = await map.layers.add({
  id: 'vehicle-1',
  type: 'model',
  url: '/models/vehicle.glb',
  position: { longitude: 116.39, latitude: 39.9, height: 12 },
  orientation: { heading: 90, pitch: 0, roll: 0 },
  scale: 2,
  minimumPixelSize: 48,
});

vehicle.setVisible(false);
```

| 字段               | 类型                               | 必填 | 默认值/说明                                                |
| ------------------ | ---------------------------------- | ---- | ---------------------------------------------------------- |
| `id`               | `string`                           | 是   | 地图内唯一 ID                                              |
| `type`             | `'model'`                          | 是   | 固定值                                                     |
| `url`              | `string`                           | 是   | 非空 `.gltf` 或 `.glb` 地址；首尾空白会被去除              |
| `position`         | `{ longitude, latitude, height? }` | 是   | WGS84 度数位置，`height` 单位为米并默认 0                  |
| `orientation`      | `{ heading?, pitch?, roll? }`      | 否   | 角度制，均默认 0                                           |
| `scale`            | `number`                           | 否   | 必须为正有限数，默认由 Cesium 使用 1                       |
| `minimumPixelSize` | `number`                           | 否   | 最小屏幕像素尺寸；省略时按真实尺寸渲染                     |
| `maximumScale`     | `number`                           | 否   | `minimumPixelSize` 生效时的缩放上限                        |
| `allowPicking`     | `boolean`                          | 否   | 默认 `true`                                                |
| `color`            | `string`                           | 否   | CSS 颜色；按完全混合叠加到模型材质，省略时保留模型原始外观 |
| `visible`          | `boolean`                          | 否   | 默认 `true`                                                |

**返回：** `Promise<ModelLayerHandle>`，成功时模型已加入 `viewer.scene.primitives`。

## 运行时更新

位置、朝向和缩放可以在不重新请求模型资源的前提下就地更新：

```ts
vehicle.setTransform({
  position: { longitude: 116.42, latitude: 39.91, height: 40 },
  orientation: { heading: 135 },
  scale: 1.5,
});
```

`setTransform()` 只写入传入的字段：省略 `orientation` 时按全 0 角度重建朝向，省略 `scale` 时保留当前缩放。参数不合法会抛出 `INVALID_LAYER_CONFIG`，且不会改动模型。

颜色叠加与恢复原始外观：

```ts
vehicle.setColor('#ff8800');
vehicle.setColor(); // 恢复模型原始材质外观
```

`setColor()` 使用 Cesium 的完全混合模式，因此模型贴图仍然可见但会被整体着色。无法解析的颜色字符串会抛出 `INVALID_LAYER_COLOR`。

## 并发加载

同一地图内并发的模型加载数量默认限制为 4，超出配额的任务按先入先出排队。一次添加大量模型（星座、设备群）时，这能避免浏览器同时发起等量的模型请求与解析任务：

```ts
const map = createMap({
  container: 'map',
  modelLoad: { concurrency: 8 },
});
```

`concurrency` 必须是正的安全整数，否则 `createMap()` 抛出 `INVALID_MODEL_LOAD_CONFIG`。排队中的图层被取消（`remove`、`clear`、地图销毁或 `AbortSignal`）时会立即失败并释放配额，不会占用后续加载。

## 生命周期与取消

```ts
const controller = new AbortController();

const loading = map.layers.add(
  {
    id: 'vehicle-1',
    type: 'model',
    url: '/models/vehicle.glb',
    position: { longitude: 116.39, latitude: 39.9 },
  },
  { signal: controller.signal },
);

controller.abort('route changed');
await loading;
```

取消时 Promise 以 `LAYER_OPERATION_ABORTED` 拒绝；即使 Cesium 随后才完成加载，SDK 也会销毁迟到模型，不会把它加入场景。

## 常见异常

| 错误码                      | 原因                                                    |
| --------------------------- | ------------------------------------------------------- |
| `INVALID_LAYER_CONFIG`      | URL 为空、位置越界、朝向非有限数，或缩放等参数不合法    |
| `INVALID_LAYER_COLOR`       | `color` 或 `setColor()` 传入的颜色字符串无法解析        |
| `INVALID_MODEL_LOAD_CONFIG` | `createMap()` 的 `modelLoad.concurrency` 不是正安全整数 |
| `LAYER_OPERATION_ABORTED`   | AbortSignal、移除、清空或销毁取消了加载                 |
| `LAYER_LOAD_FAILED`         | 网络、服务或模型解析失败；可重试                        |
| `DUPLICATE_LAYER_ID`        | 同一地图已有相同 ID 的加载中或已加载图层                |
| `LAYER_DISPOSED`            | 图层已释放后继续调用 `setTransform()` 或 `setColor()`   |

## 当前边界

本 alpha 版本只封装静态模型：没有模型动画、属性更新、CZML 或动态实体、拾取事件、分类/裁剪、外观提亮与无光照策略，也没有失败降级（占位点或标记）。需要这些能力时可用 `map.raw.viewer` 调用 Cesium 公共 API，并由业务负责资源所有权和销毁。
