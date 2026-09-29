# 3D Tiles 图层

适用于城市模型、倾斜摄影或其他标准 3D Tiles 服务。SDK 在 Tileset 成功加载后才加入场景；取消、移除和地图销毁都会释放 SDK 创建的 Primitive。

## 添加 3D Tiles

```ts
const city = await map.layers.add({
  id: 'city',
  type: '3d-tiles',
  url: '/tiles/city/tileset.json',
  maximumScreenSpaceError: 8,
  skipLevelOfDetail: true,
});

city.setVisible(false);
```

| 字段                      | 类型         | 必填 | 默认值/说明                                              |
| ------------------------- | ------------ | ---- | -------------------------------------------------------- |
| `id`                      | `string`     | 是   | 地图内唯一 ID                                            |
| `type`                    | `'3d-tiles'` | 是   | 固定值                                                   |
| `url`                     | `string`     | 是   | 非空 `tileset.json` 或兼容服务地址                       |
| `visible`                 | `boolean`    | 否   | `true`；控制 Tileset 显隐                                |
| `maximumScreenSpaceError` | `number`     | 否   | Cesium 默认 `16`；越小越精细，也会增加网络、CPU/GPU 压力 |
| `skipLevelOfDetail`       | `boolean`    | 否   | Cesium 默认 `false`；开启层级跳跃遍历优化                |

**返回：** `Promise<LayerHandle>`。成功时 Tileset 已加入 `viewer.scene.primitives`。

## 生命周期与取消

```ts
const controller = new AbortController();

const loading = map.layers.add(
  { id: 'city', type: '3d-tiles', url: '/tiles/city/tileset.json' },
  { signal: controller.signal },
);

controller.abort('route changed');
await loading;
```

取消时 Promise 以 `LAYER_OPERATION_ABORTED` 拒绝；即使 Cesium 随后才完成加载，SDK 也会销毁迟到 Tileset，不会把它加入场景。

## 常见异常

| 错误码                    | 原因                                                   |
| ------------------------- | ------------------------------------------------------ |
| `INVALID_LAYER_CONFIG`    | URL 为空、屏幕空间误差非正有限数，或开关字段不是布尔值 |
| `LAYER_OPERATION_ABORTED` | AbortSignal、移除、清空或销毁取消了加载                |
| `LAYER_LOAD_FAILED`       | 网络、服务或 Tileset 解析失败；可重试                  |
| `DUPLICATE_LAYER_ID`      | 同一地图已有相同 ID 的加载中或已加载图层               |

## 当前边界

本 alpha 版本不封装变换、样式、裁剪、分类、拾取策略、缓存预算和更多 LOD 参数；单个 glTF / GLB 模型请使用[静态模型图层](./model-layer.md)，CZML 与动态实体仍未发布。需要这些能力时可用 `map.raw.viewer` 调用 Cesium 公共 API，并由业务负责资源所有权和销毁。
