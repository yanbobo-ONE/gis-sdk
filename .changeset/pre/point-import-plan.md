---
'@yanbobo/gis-sdk': minor
---

增加点位导入计划 `planPointImport()`（`/core`）：解析 CSV、确定列映射（显式优先，缺的按 `lon` / `纬度` 等关键字猜测并在 `preview.guessed` 与 `issues` 里标记；显式列名不存在直接抛 `INVALID_CSV_INPUT`，不退回猜测）、按需把投影坐标换算到 WGS84，并给出**预览 + 全量点位 + 拒绝样本**。坐标系标识是否支持在计划阶段一次判定（不支持整单抛 `UNSUPPORTED_CRS`），换算结果超出 WGS84 范围的行逐行拒绝并写明原因，高程不参与投影换算；`previewLimit`（默认 50）只影响预览，`points` 始终是全量，每个点位带来源行号与可选 `id` / `label` / `height`。计划是纯数据：取消导入即丢弃，落图层仍由业务决定（`map.layers.add({ type: 'points', points })`）。与 `readPointCsv()` 的分工是"列映射已定、只要坐标"对照"面向导入流程的猜测、换算与预览"。
