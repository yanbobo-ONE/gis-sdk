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

| 成员                  | 类型                      | 运行效果                                                         |
| --------------------- | ------------------------- | ---------------------------------------------------------------- |
| `id`                  | `string`                  | 地图内唯一 ID                                                    |
| `type`                | 见[图层导航](./layers.md) | 图层判别字段                                                     |
| `state`               | `LayerState`              | `loading`、`ready`、`hidden`、`disposing`、`disposed` 或 `error` |
| `visible`             | `boolean`                 | 当前显隐状态                                                     |
| `events`              | `EventHub<LayerEventMap>` | 订阅 `state:changed` 与 `error`                                  |
| `errorCount`          | `number`                  | 加入场景后异步请求失败的累计次数（瓦片级失败只计数不刷屏）       |
| `setVisible(visible)` | `void`                    | 修改底层对象显隐，不重建数据或 Provider                          |
| `dispose()`           | `Promise<void>`           | 幂等释放并从所属管理器移除                                       |

图层释放后调用修改方法会抛出 `LAYER_DISPOSED`。直接调用 `handle.dispose()` 与 `map.layers.remove(id)` 的资源结果一致。

## 堆叠顺序

影像图层（WMS / TMS / WMTS / 单图影像）四个句柄都有顺序控制：

```ts
const roads = await map.layers.add({ id: 'roads', type: 'wms', url, layers: 'city:roads' });
const labels = await map.layers.add({ id: 'labels', type: 'wms', url, layers: 'city:labels' });

labels.stackIndex; // 1（0 是最靠下的业务影像图层）
roads.raiseToTop(); // 提到最上层，盖住 labels
roads.stackIndex; // 1，与 labels 换了位置
roads.raise(); // 上移一层
roads.lower(); // 下移一层
roads.lowerToBottom(); // 移到最下层（底图之上）
```

| 成员              | 运行效果                                                      |
| ----------------- | ------------------------------------------------------------- |
| `stackIndex`      | 当前序号，从 0 起（0 最靠下）；不在影像集合里时为 `undefined` |
| `raise()`         | 上移一层；已在最上层返回 `false`                              |
| `lower()`         | 下移一层；已在底图之上返回 `false`                            |
| `raiseToTop()`    | 移到业务影像图层最上层；已在那儿返回 `false`                  |
| `lowerToBottom()` | 移到业务影像图层最下层（底图之上）；已在那儿返回 `false`      |

规则与边界：

- **底图恒在最底层**。这四个操作不会把业务图层排到底图之下，`stackIndex` 也按业务影像图层计数，底图不占号；底图清空后下限自动变为 0。底图与业务图层的关系见[地图控制](./map-controls.md#初始化的-xyz-底图)。
- **顺序只在影像通道内有定义**：影像图层按集合顺序叠加，所以顺序决定谁盖住谁。业务通过 `map.raw.viewer.imageryLayers` 手动调整顺序后，`stackIndex` 读数同样会跟着变。
- **非影像图层没有这套方法**：点位 / 折线 / 模型 / 3D Tiles 属于图元通道，CZML / GeoJSON 属于数据源通道。图元与实体的可见性由几何与深度决定，集合顺序不决定谁盖住谁；给一个"能调但看不出效果"的接口比没有更糟，因此 SDK 不提供，也不接受"跨通道排序"（比如把影像图层排到点位图层之上）。
- `reload()` / `setStyle()` / `setFilter()` 会重建 Provider，但句柄会停在原来的层号上，顺序不受影响。

## 远端请求失败的可观测性

影像图层（WMS、TMS、WMTS、单图影像）加入场景后，瓦片请求失败不会打断调用方，也不会重复抛异常：SDK 累计失败次数，并且只在首个失败时向图层事件发出一次 `error`，避免瓦片级错误刷屏。

```ts
const layer = await map.layers.add({ id: 'roads', type: 'wms', url, layers: 'city:roads' });

layer.events.on('error', ({ error }) => {
  console.warn('图层远端请求失败', error.code, error.retryable);
});

layer.errorCount; // 累计失败次数；0 表示没有观察到远端失败
```

底图（`createMap({ basemap })`）没有图层句柄，同样的失败会通过 `map:error` 上报首个，并可用 `map.basemap.errorCount` 读取累计次数——这样业务可以区分"没有配置底图"和"配置了但服务不可用"：

```ts
map.events.on('map:error', ({ error }) => {
  if (error.code === 'BASEMAP_LOAD_FAILED') {
    // 提示底图服务不可用，或切换到备用底图
  }
});
```

加载阶段（`add()`、`setData()`）的失败仍然以 Promise 拒绝的方式抛出，不会通过上面的事件重复上报。
