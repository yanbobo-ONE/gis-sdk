# 密度热力图图层 type: 'heatmap'

把**业务点位**（经纬度 + 可选权重）画成密度热力图：SDK 在本地把权重按四次核摊成密度网格、着色成带透明度的位图，再作为单张影像贴合到覆盖范围上。因此**不依赖任何外部数据集**，也不需要业务预处理——实时刷新的点位表直接 `setData()` 即可。

```ts
const layer = await map.layers.add({
  id: 'density',
  type: 'heatmap',
  points: [
    { longitude: 116.391, latitude: 39.907, weight: 3 },
    { longitude: 116.401, latitude: 39.911 },
  ],
  radiusMeters: 800, // 每个点的影响半径
  resolution: 256, // 位图长边像素
  colorRamp: 'thermal',
  opacity: 0.75,
});

await layer.setData(nextPoints); // 原子替换，不闪断
await layer.setStyle({ radiusMeters: 1_500, colorRamp: 'radar' });
```

## 参数

| 参数           | 默认值                 | 说明                                                                   |
| -------------- | ---------------------- | ---------------------------------------------------------------------- |
| `points`       | 必填                   | `{ longitude, latitude, weight? }`；空数组表示"暂时没有数据"，整幅透明 |
| `radiusMeters` | `800`                  | 每个点的核影响半径                                                     |
| `resolution`   | `256`                  | 位图**长边**的像素数，16 到 1024；短边按范围长宽比缩放                 |
| `colorRamp`    | `'thermal'`            | 内置 `thermal` / `radar` / `cool`，或自定义 2 到 8 个色标              |
| `maxDensity`   | 数据最大值             | 归一化上限；固定它可以让不同批次的数据用同一把尺子比较                 |
| `bounds`       | 点位包围盒外扩一个半径 | 覆盖范围（`{ west, south, east, north }`）                             |
| `opacity`      | `1`                    | 图层透明度（影像图层 alpha，与 `map.basemap` 同一套叠放规则）          |

句柄具备影像图层的全部能力：`setOpacity()` / `setVisible()` / `stackIndex` / `raise()` / `lower()` / `raiseToTop()` / `lowerToBottom()`，以及热力图自己的 `setData()` / `setStyle()` / `pointCount` / `errorCount`。

## 语义与口径

- **核函数**：`(1 - d²/r²)²`，在半径处平滑归零，所以相邻点的密度叠加没有硬边；权重是相对量，`weight: 2` 的点在同一位置贡献两倍密度。
- **米与度**：按点的纬度做米→度换算（与 `clusterPoints()` 同一套球面基准），几十公里量级内足够；要精确量算请用 `measureDistance()`。
- **透明度随密度增长**（`alpha = 密度比例 × opacity`），密度为零的格子完全透明，叠加在底图上不会出现"方形遮罩"。
- **原子替换**：`setData()` / `setStyle()` 都是先按新参数栅格化、成功后再换影像，并继承透明度、显隐与堆叠位置；替换期间再调用会以可重试的 `LAYER_BUSY` 拒绝。
- **空数据不是错误**：`points: []` 会得到一张全透明的小图，图层照常存在、`pointCount` 为 0。
- **色带是相对量具**：默认按当前数据的最大密度归一化；想让多批数据可比，显式传 `maxDensity`。

自定义色带：

```ts
colorRamp: [
  { offset: 0, color: '#0b1020' },
  { offset: 0.6, color: '#f59e0b' },
  { offset: 1, color: '#ef4444' },
];
```

色标必须按 `offset` 升序、首尾覆盖 0 与 1，颜色支持 `#rgb` 与 `#rrggbb`。

## 边界

- **规模**：点数上限 20 万（与批量点位一致），位图长边上限 1024；栅格化在主线程做一次（`setData` 一次），超大点集建议先用[点聚合 `clusterPoints()`](./performance.md) 或按屏幕像素降采样，再交给热力图。
- **不做时序混合**：没有时间片插值与播控，那是业务数据集的事；需要动效时按帧/按批 `setData()`。
- **不做聚合标注**：热力图只表达密度，不显示数值；要读数请在业务侧用 `pointCount` 与自己的统计，或叠加[点位图层](./points-layer.md)。
- **不透明度不烘焙进位图**：`opacity` 走影像图层 alpha，因此调透明度不需要重新栅格化。

## 相关页面

- [点位图层与 CSV 导入](./points-layer.md)：原始点位的渲染与标签
- [图层管理](./layer-management.md)：图层的添加、查询、堆叠顺序与释放
- [渲染质量与自动降档](./quality.md)：密度位图的分辨率与整体画质档的关系
