# 折线图层

用于航线、轨迹、链路、边界这类批量线要素。图层使用 Cesium 的 `PolylineCollection` 批量渲染，**不创建 Entity 或 DataSource**。

```ts
const routes = await map.layers.add({
  id: 'routes',
  type: 'polyline',
  width: 3,
  color: '#43bfeb',
  material: 'glow',
  polylines: [
    { positions: [from, mid, to] },
    { id: 'route-2', positions: path2, color: '#ff8800', material: 'dash', dashLength: 24 },
  ],
});

routes.count; // 折线条数
```

## 参数

| 字段        | 类型                   | 必填 | 默认值/说明                 |
| ----------- | ---------------------- | ---- | --------------------------- |
| `id`        | `string`               | 是   | 图层内唯一 ID               |
| `type`      | `'polyline'`           | 是   | 固定值                      |
| `polylines` | `PolylineSpec[]`       | 是   | 初始折线，单层上限 10000 条 |
| `width`     | `number`               | 否   | 线宽（像素），0–64，默认 2  |
| `color`     | `string`               | 否   | 线颜色，默认 `#ffffff`      |
| `material`  | `PolylineMaterialKind` | 否   | 材质类型，默认 `'solid'`    |

`PolylineSpec` 继承上述样式字段，另加 `id`（业务对象 id）与 `positions`（至少 2 个点，单条上限 100000 个顶点）。单条折线的样式覆盖图层默认值。

## 材质

材质全部对应 **Cesium 内置材质类型**，因此不需要访问任何私有材质缓存：

| `material`  | Cesium 类型       | 额外参数                       |
| ----------- | ----------------- | ------------------------------ |
| `'solid'`   | `Color`           | —                              |
| `'glow'`    | `PolylineGlow`    | `glowPower`（0–1，默认 0.2）   |
| `'outline'` | `PolylineOutline` | `outlineWidth`、`outlineColor` |
| `'arrow'`   | `PolylineArrow`   | —                              |
| `'dash'`    | `PolylineDash`    | `dashLength`（1–128，默认 16） |

```ts
routes.setStyle({ material: 'arrow', width: 6, color: '#ff6b35' });
```

## 运行时更新

```ts
await routes.setData(nextPolylines); // 原子替换：先加入新集合再移除旧集合
routes.setStyle({ width: 4 }); // 整层调整，未传字段保持原值
```

取消、并发与释放语义与其它图层一致：取消抛 `LAYER_OPERATION_ABORTED` 且旧折线不变，并发替换抛 `LAYER_BUSY`。

## 拾取

与点位图层一致：每条折线在创建时写入拾取标记，`map.picking.on('click')` 的 `hit` 会给出 `layerId` 与 `objectId`（取自 `PolylineSpec.id`）。

## 当前边界

- **不做贴地折线**：贴地需要 `GroundPolylinePrimitive` 与地形交互，未封装；需要时用 `map.raw.viewer` 自行创建。
- **不提供自定义 GLSL 材质**：Plugin-web 的流动线、激光波、星间波材质通过 Cesium 私有材质缓存注册，属于版本敏感的内部接口；SDK 只用公开材质类型。需要自定义着色器时，可在业务侧注册后再走 `map.raw.viewer`。
- **不做屏幕空间线宽补偿**：线宽是像素单位，缩放时视觉粗细不变（Cesium 的默认行为）；世界单位宽度需要 `PolylineVolumeGeometry` 一类几何，未封装。
- **不做线面一体**：带状/走廊（`PolylineVolume`）与缓冲区不在本图层范围。
