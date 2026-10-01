# 点位导入计划 planPointImport

把一份 CSV 变成"可以确认导入的点位表"，中间要回答三个问题：哪几列是经纬度、坐标是什么坐标系、哪些行不能用。`planPointImport()` 一次把这三件事做完，给出**预览 + 全量点位 + 拒绝样本**，但**不碰图层**——落图层仍然由业务决定。

```ts
import { planPointImport } from '@yanbobo/gis-sdk/core';

const plan = planPointImport({ text: csvText });

plan.preview.totalRows; // 数据行数
plan.preview.acceptedCount; // 可用点数
plan.preview.rejectedCount; // 被拒绝的行数
plan.preview.points; // 前 50 条（previewLimit），够画表格预览
plan.preview.issues; // 给人看的提示：映射来自猜测 / 做过换算 / 有行被拒
plan.preview.rejected; // 拒绝样本：{ line, reason }

// 确认后落图层
await map.layers.add({ id: 'imported', type: 'points', points: plan.points });
```

"取消导入"就是丢弃这份计划——它是纯数据，没有资源需要释放。

## 列映射：显式优先，其余靠猜并标记

`columns` 只给一部分时，缺的按列名猜测（`longitude` / `lon` / `lng` / `经度`、`latitude` / `lat` / `纬度`），只要有一列是猜的，`preview.guessed` 就是 `true`，`issues` 里也会写清最终用的是哪几列：

```ts
const plan = planPointImport({
  text: csvText,
  columns: { label: 'name', id: 'code' }, // 经纬度交给猜测
});
plan.preview.columns; // { longitude: 'lon', latitude: 'lat', label: 'name', id: 'code' }
plan.preview.guessed; // true
```

**显式给出的列名不存在时直接抛 `INVALID_CSV_INPUT`**，不退回猜测：映射写错却静默换成别的列，比直接失败更难排查。经纬度两列都定不下来时同样抛错，错误信息里会列出表头里实际有哪些列。

## 坐标系：默认 WGS84，投影坐标先注册再换算

`crs` 省略时按 `'WGS84'`（等价 `'EPSG:4326'`）处理，不做任何换算。其它坐标系走 `transformGeoPoint` 换算到 WGS84，因此需要先注册（proj4 内置定义如 `'EPSG:3857'` 可直接用）：

```ts
planPointImport({ text: csvText, crs: 'EPSG:3857' });
```

- 坐标系标识**是否支持**在计划阶段一次判定：不支持时整单抛 `UNSUPPORTED_CRS`，而不是逐行拒绝——这是配置问题，不是数据问题；
- 换算结果落在 WGS84 范围（经度 ±180、纬度 ±90）之外时**逐行拒绝**，理由写明是换算越界，这类问题通常是坐标系或单位配错；
- **高程不参与投影换算**，按原值保留；需要高程基准转换时在业务侧处理后再导入。

## 预览、拒绝与行号

| 字段                    | 含义                                                 |
| ----------------------- | ---------------------------------------------------- |
| `preview.totalRows`     | 数据行数（不含表头）                                 |
| `preview.acceptedCount` | 换算成功且落在 WGS84 范围内的点数                    |
| `preview.rejectedCount` | 被拒绝的行数，含 CSV 结构性问题（列数与表头不符等）  |
| `preview.points`        | 前 `previewLimit`（默认 50）条，顺序与文件一致       |
| `preview.rejected`      | 拒绝样本 `{ line, reason }`，上限沿用 CSV 解析的上限 |
| `preview.issues`        | 提示：映射来自猜测、做过坐标换算、有行被拒等         |
| `points`                | **全量**可用点位，`previewLimit` 不影响它            |

每个点位都带 `line`（含表头的原始行号）与可选的 `id` / `label` / `height`，便于业务回查原始文件、把标签直接交给点位图层：

```ts
await map.layers.add({
  id: 'imported',
  type: 'points',
  points: plan.points,
  labels: { enabled: true, maxLabels: 200 },
});
```

坐标解析沿用 CSV 的严格十进制口径：`1e8`、`05`、全角数字这类写法按脏数据拒绝，不做隐式转换。

## 与 `readPointCsv()` 的分工

| 函数                | 场景                                                     |
| ------------------- | -------------------------------------------------------- |
| `readPointCsv()`    | 列映射已经确定、只要坐标与拒绝样本的最小读取             |
| `planPointImport()` | 面向导入流程：列名可能靠猜、坐标可能要换算、要预览与提示 |

两者都只产出数据、不依赖 Cesium；`planPointImport()` 不负责把点位画出来。

## 相关页面

- [点位图层与 CSV 导入](./points-layer.md)：点位渲染、逐点样式、标签与容量上限
- [空间计算与坐标转换](./spatial-analysis.md)：`registerCrs()` / `registerChinaCrs()` 与 `transformGeoPoint()`
