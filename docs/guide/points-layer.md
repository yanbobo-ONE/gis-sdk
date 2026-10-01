# 点位图层

用于把成批点位渲染成地图上的点：设备位置、导入的测点、目标清单等。图层使用 Cesium 的 `PointPrimitiveCollection` 批量渲染，**不创建 Entity 或 DataSource**，单层上限 20 万点。

## 添加点位

```ts
const targets = await map.layers.add({
  id: 'targets',
  type: 'points',
  pixelSize: 10,
  outlineWidth: 1,
  color: '#43bfeb',
  points: [
    { longitude: 116.39, latitude: 39.9, height: 0 },
    { longitude: 121.47, latitude: 31.23, color: '#ff8800', pixelSize: 16 },
  ],
});

targets.count; // 当前渲染的点数
```

| 字段           | 类型          | 必填 | 默认值/说明                    |
| -------------- | ------------- | ---- | ------------------------------ |
| `id`           | `string`      | 是   | 地图内唯一 ID                  |
| `type`         | `'points'`    | 是   | 固定值                         |
| `points`       | `PointSpec[]` | 是   | 初始点位，单层上限 200000      |
| `color`        | `string`      | 否   | CSS 颜色，默认 `#43bfeb`       |
| `pixelSize`    | `number`      | 否   | 点直径（像素），2–40，默认 8   |
| `outlineWidth` | `number`      | 否   | 轮廓宽度（像素），0–16，默认 0 |
| `outlineColor` | `string`      | 否   | 轮廓颜色，默认与 `color` 相同  |
| `labels`       | 见下          | 否   | 标签样式，默认关闭             |
| `visible`      | `boolean`     | 否   | 默认 `true`                    |

`PointSpec` 是 `{ longitude, latitude, height?, color?, pixelSize?, label? }`

## 标签

给带 `label` 的点打开标签（用 Cesium 的 `LabelCollection` 批量绘制，同样不创建 Entity）：

```ts
const layer = await map.layers.add({
  id: 'targets',
  type: 'points',
  points: [
    { id: 'a', longitude: 116.39, latitude: 39.9, label: '目标 A' },
    { id: 'b', longitude: 121.47, latitude: 31.23 }, // 没有 label 就不画文字
  ],
  labels: { enabled: true, font: '13px sans-serif', color: '#ffffff', offsetPixels: [0, -18] },
});

layer.labelCount; // 实际渲染的标签数（可能因 maxLabels 截断）
```

| 标签字段       | 类型               | 默认值            | 说明                                          |
| -------------- | ------------------ | ----------------- | --------------------------------------------- |
| `enabled`      | `boolean`          | `false`           | 是否显示标签                                  |
| `font`         | `string`           | `13px sans-serif` | CSS font 简写                                 |
| `color`        | `string`           | `#ffffff`         | 文字颜色                                      |
| `outlineColor` | `string`           | `#0b1310`         | 描边颜色（浅色底图上的可读性保障）            |
| `outlineWidth` | `number`           | `2`               | 描边宽度，0–8                                 |
| `offsetPixels` | `[number, number]` | `[0, -18]`        | 相对点的像素偏移，默认把文字放在点上方        |
| `maxLabels`    | `number`           | `2000`            | 单层标签上限，0–50000；超出部分只画点、不画字 |

行为约定：

- **只有带 `label` 的点会画文字**；`label` 两端空白会被去掉，空白字符串按"没有标签"处理，超过 64 字符直接报错（避免把整段描述灌进 GPU）。
- **超过 `maxLabels` 的部分静默只画点**，`labelCount` 会如实反映渲染了多少条，便于业务判断是否需要按视野过滤。
- **文字本身也带拾取标记**，悬停文字命中的是同一个点和同一个业务 id。
- **`setData()` 会把点和标签一起原子替换**，`setStyle({ labels: … })` 可以随时开关标签或改外观（标签的字体 / 颜色 / 偏移是逐条属性，改样式时按当前点位重建标签集合）。
- **默认上限 2000 是经验值**：文字是逐条绘制且始终朝向屏幕，比点贵得多；需要成千上万条标签时，建议先按视野或缩放级别筛选要标注的点，而不是一味提高上限。：单个点可以用 `color` / `pixelSize` 覆盖图层默认值，`height` 省略时按 0（椭球面）处理。

## 运行时更新

```ts
// 原子替换：先建好新集合再加入场景，最后移除旧集合，替换过程中不出现空白帧
await targets.setData(nextPoints);

// 整层样式：只传要改的字段，其余保持
targets.setStyle({ pixelSize: 14, outlineWidth: 2 });

// 取消替换：旧点位保持不变，图层回到稳定状态
const controller = new AbortController();
targets.setData(nextPoints, { signal: controller.signal });
controller.abort('route changed');
```

`setData()` 与 `setStyle()` 的边界与图层管理一致：并发替换抛 `LAYER_BUSY`，取消抛 `LAYER_OPERATION_ABORTED`，非法样式抛 `INVALID_LAYER_CONFIG` / `INVALID_LAYER_COLOR`。

## 从 CSV 导入点位

`@yanbobo/gis-sdk/core` 提供一套纯函数解析 CSV，与图层解耦、可在 Worker 或 Node 里跑：

```ts
import { guessCsvPointColumns, parseCsv, readPointCsv } from '@yanbobo/gis-sdk/core';

const table = parseCsv(csvText); // 解析表头与数据行，返回拒绝行样本
const guess = guessCsvPointColumns(table.columns); // { longitude: '经度', latitude: '纬度' }

const { points, rejected, rejectedCount } = readPointCsv(csvText, {
  longitudeColumn: guess.longitude ?? '经度',
  latitudeColumn: guess.latitude ?? '纬度',
  heightColumn: '海拔', // 可选
});

await map.layers.add({
  id: 'imported',
  type: 'points',
  points: points.map((row) => ({
    longitude: row.longitude,
    latitude: row.latitude,
    height: row.height,
  })),
});
```

解析规则与现场约束：

- 遵循 RFC4180 的引号、转义引号与**引号内换行**；不是 `split(',')`；
- 自动剥离 UTF-8 BOM；检测到替换字符（`\uFFFD`）时直接报错，提示另存为 UTF-8——GBK 导出的文件解析结果不可信；
- 列数与表头不一致的行进入 `rejected`（带物理行号与原因），不会静默错位；
- `guessCsvPointColumns` 只匹配 `longitude` / `lon` / `lng` / `经度` 这类明确列名，**不会**把 `x` / `y` 当经纬度：投影坐标请先用 `transformGeoPath` 转成 WGS84 再导入；
- 坐标只接受严格十进制数，`001` 这类带前导零的编号、科学计数法都判为非法，避免把对象编号当成坐标；
- 上限：10MB 文本、5 万数据行、64 列、单字段 16KB，都可在调用时覆盖。

## 错误码

| 错误码                    | 场景                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `INVALID_LAYER_CONFIG`    | 经纬度越界、`pixelSize`/`outlineWidth` 超范围、点数超过上限 |
| `INVALID_LAYER_COLOR`     | `color` / `outlineColor` 无法解析                           |
| `LAYER_BUSY`              | `setData()` 正在替换                                        |
| `LAYER_OPERATION_ABORTED` | 取消替换、移除图层或地图销毁                                |
| `INVALID_CSV_INPUT`       | CSV 非文本、疑似非 UTF-8、引号未闭合、超限、缺少指定列      |

## 当前边界

- **不提供聚合与标签**：Plugin-web 的实体后端支持内置聚合与标签，但那条路径依赖 `viewer.entities`；本图层只用图元后端，聚合与标签需要时由业务自行实现。
- **不提供逐点拾取事件**：命中判断需要射线拾取，落在交互能力范围内（尚未发布）；临时需求用 `map.raw.viewer.scene.pick()`，注意不要移除 SDK 拥有的图元。
- **构建过程同步执行**：20 万点会在主线程一次性建完，构建期间会占用若干百毫秒；需要完全无卡顿时等 Worker 执行接口（后续阶段）。
- **不读文件、不做 CRS 转换**：CSV 解析只处理文本；文件读取由业务负责（`File.text()`），投影坐标先转 WGS84。

把 CSV 交给业务确认前（列名可能靠猜、坐标可能要换算）先用[点位导入计划](./point-import.md)生成预览与拒绝样本。
