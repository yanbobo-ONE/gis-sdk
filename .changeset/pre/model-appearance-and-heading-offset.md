---
'@yanbobo/gis-sdk': minor
---

模型图层补完：增加模型资源朝向补偿 `headingOffset`（与业务姿态相加后进入矩阵，`setTransform()` 时保持）与外观策略 `appearance` / `setAppearance()`（提亮、无光照；恢复时只写回本图层接管前的值，同一策略在同一地图内共享实例）。
