---
'@yanbobo/gis-sdk': minor
---

点位图层支持标签：`points[].label`（最长 64 字符，空白按无标签处理）配合 `labels: { enabled, font?, color?, outlineColor?, outlineWidth?, offsetPixels?, maxLabels? }` 用 Cesium 的 `LabelCollection` 批量绘制文字，不创建 Entity / DataSource；默认上限 2000 条（超出只画点不画字），新增 `handle.labelCount` 读数；`setData()` 把点和标签一起原子替换，`setStyle({ labels })` 可随时开关或改外观，文字本身也带拾取标记。
