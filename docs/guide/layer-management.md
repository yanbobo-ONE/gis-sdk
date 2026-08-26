# 图层管理

`map.layers` 统一管理 SDK 创建的图层。它会预留 ID、处理取消、维护生命周期并在 `map.destroy()` 时释放资源。

## 添加图层：map.layers.add(spec, options?)

根据 `spec.type` 选择图层类型并返回对应能力句柄。

```ts
const controller = new AbortController();
const areas = await map.layers.add(
  { id: 'areas', type: 'geojson', data: '/data/areas.geojson' },
  { signal: controller.signal },
);
```

| 参数             | 类型                                                                                    | 必填 | 说明                     |
| ---------------- | --------------------------------------------------------------------------------------- | ---- | ------------------------ |
| `spec`           | `GeoJsonLayerSpec \| WmsLayerSpec \| TmsLayerSpec \| WmtsLayerSpec \| Tiles3dLayerSpec` | 是   | 带 `type` 判别字段的配置 |
| `options.signal` | `AbortSignal`                                                                           | 否   | 取消尚未完成的加载       |

**返回：** `Promise<LayerHandle>`。TypeScript 会自动推导：GeoJSON 返回 `GeoJsonLayerHandle`，WMS 返回 `WmsLayerHandle`，TMS/WMTS 返回 `ImageryLayerHandle`，3D Tiles 返回 `LayerHandle`。

**效果：** 图层 ID 在加载开始即被预留；只有加载成功后，`get()` 和 `list()` 才能看到该图层。

**常见异常：** `INVALID_LAYER_ID`、`DUPLICATE_LAYER_ID`、`LAYER_OPERATION_ABORTED`、`LAYER_LOAD_FAILED`、`LAYER_MANAGER_BUSY`、`LAYER_MANAGER_DISPOSED`。

## 查询：map.layers.get(id) 与 list()

```ts
const areas = map.layers.get('areas');
areas?.setVisible(false);

const snapshot = map.layers.list();
// [{ id: 'areas', type: 'geojson', state: 'ready', visible: false }]
```

| 方法      | 返回                       | 适用场景                     |
| --------- | -------------------------- | ---------------------------- |
| `get(id)` | `LayerHandle \| undefined` | 根据 ID 取得已完成加载的句柄 |
| `list()`  | `readonly LayerInfo[]`     | 渲染图层列表或诊断快照       |

`list()` 返回的是快照，修改快照不会影响地图；加载中的图层不会提前暴露。

## 移除一个图层：map.layers.remove(id)

```ts
const removed = await map.layers.remove('areas');
if (!removed) console.info('图层不存在');
```

**返回：** `Promise<boolean>`。存在时取消加载或释放资源并返回 `true`；不存在返回 `false`。清理失败抛出 `LAYER_DISPOSE_FAILED`。

## 清空图层：map.layers.clear()

```ts
await map.layers.clear();
```

无参数，返回 `Promise<void>`。会取消全部加载并释放全部已加载图层。清理期间不能继续添加图层；部分图层释放失败时抛出 `LAYER_CLEAR_FAILED`，失败句柄保留供重试。

## 所有图层共有的 LayerHandle

| 成员                  | 类型                                                  | 运行效果                                                         |
| --------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `id`                  | `string`                                              | 地图内唯一 ID                                                    |
| `type`                | `'geojson' \| 'wms' \| 'tms' \| 'wmts' \| '3d-tiles'` | 图层判别字段                                                     |
| `state`               | `LayerState`                                          | `loading`、`ready`、`hidden`、`disposing`、`disposed` 或 `error` |
| `visible`             | `boolean`                                             | 当前显隐状态                                                     |
| `events`              | `EventHub<LayerEventMap>`                             | 订阅 `state:changed`                                             |
| `setVisible(visible)` | `void`                                                | 修改底层对象显隐，不重建数据或 Provider                          |
| `dispose()`           | `Promise<void>`                                       | 幂等释放并从所属管理器移除                                       |

图层释放后调用修改方法会抛出 `LAYER_DISPOSED`。直接调用 `handle.dispose()` 与 `map.layers.remove(id)` 的资源结果一致。
