---
'@yanbobo/gis-sdk': minor
---

增加点位图层（`type: 'points'`，PointPrimitive 批量渲染、单层 20 万点、逐点样式覆盖、`setData()` 原子替换与 `setStyle()` 整层调整）与 CSV 点位导入（`parseCsv`、`readPointCsv`、`guessCsvPointColumns`、`describeCsvColumn`，含 BOM/编码校验、列数不一致拒绝与严格十进制坐标解析）。
