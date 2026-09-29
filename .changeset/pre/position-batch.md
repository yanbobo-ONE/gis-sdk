---
'@yanbobo/gis-sdk': minor
---

增加位置批量归一化 `normalizePositions()`：校验坐标与越界过滤、按 id 保留最新（可切换历史模式）、输出可跨线程转移的 `Float64Array` 与丢弃统计，用于高频位置进入渲染层之前的纯数据层处理。
