# GeoJSON 图层

适用于业务要素、行政区、点位、轨迹和面数据。数据可以是内存中的 GeoJSON 对象，也可以是满足 CORS/CSP 的 URL。

## 添加图层

```ts
const areas = await map.layers.add({
  id: 'areas',
  type: 'geojson',
  data: '/data/areas.geojson',
  visible: true,
  style: {
    marker: { color: '#38d996', size: 14, symbol: 'circle' },
    stroke: '#dce7e1',
    strokeWidth: 2,
    fill: '#249b6a66',
    clampToGround: true,
  },
});
```

| 字段                    | 类型                | 必填 | 说明                            |
| ----------------------- | ------------------- | ---- | ------------------------------- |
| `id`                    | `string`            | 是   | 地图内唯一 ID                   |
| `type`                  | `'geojson'`         | 是   | 固定值                          |
| `data`                  | `GeoJSON \| string` | 是   | GeoJSON 对象或可 `fetch` 的 URL |
| `visible`               | `boolean`           | 否   | 默认 `true`                     |
| `style.marker.color`    | `string`            | 否   | CSS 颜色                        |
| `style.marker.size`     | `number`            | 否   | 正有限数，单位 px               |
| `style.marker.symbol`   | `string`            | 否   | Maki 图标名                     |
| `style.stroke` / `fill` | `string`            | 否   | CSS 颜色                        |
| `style.strokeWidth`     | `number`            | 否   | 正有限数，单位 px               |
| `style.clampToGround`   | `boolean`           | 否   | 是否贴地                        |

**返回：** `Promise<GeoJsonLayerHandle>`。成功后数据已加入 Cesium `dataSources`。

**异常：** 样式不合法为 `INVALID_LAYER_STYLE`；下载、JSON 解析或 Cesium 加载失败为 `LAYER_LOAD_FAILED`。

## 原子替换数据：setData(data, options?)

适用于刷新要素列表、切换区域或整体替换轨迹。SDK 先加载新数据，成功后才移除旧数据，因此失败或取消不会白屏。

```ts
const controller = new AbortController();

await areas.setData('/data/areas-next.geojson', {
  signal: controller.signal,
});
```

| 参数             | 类型                | 必填 | 说明         |
| ---------------- | ------------------- | ---- | ------------ |
| `data`           | `GeoJSON \| string` | 是   | 新对象或 URL |
| `options.signal` | `AbortSignal`       | 否   | 取消本次替换 |

**返回：** `Promise<void>`。

**常见异常：** 并发替换时为 `LAYER_BUSY`；取消时为 `LAYER_OPERATION_ABORTED`；加载失败时为 `LAYER_LOAD_FAILED`。

## 常见问题

### URL 加载失败

确认 URL 对当前页面允许 CORS，且 CSP 的 `connect-src` 未拦截该域名。SDK 无法绕过浏览器安全策略。

### 高频实时更新

`setData()` 是整体原子替换，不适合每帧刷新大量对象。高频输入应先进入[数据管线](./data-pipeline.md)；当前 SDK 尚未提供 Entity/Primitive 动态渲染器。
