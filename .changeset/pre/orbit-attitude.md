---
'@yanbobo/gis-sdk': minor
---

增加轨道与姿态数学（`/core`，零 Cesium）：`calculateOrbitalElements`（惯性系状态 → 开普勒六根数，圆轨道与赤道退化情形不产生 NaN）、`propagateTwoBody`（二分法解开普勒方程的二体传播，适合回放补帧）与 `AttitudeDynamics`（四元数姿态积分，每步归一化）。
