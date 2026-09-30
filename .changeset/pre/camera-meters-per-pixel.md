---
'@yanbobo/gis-sdk': minor
---

增加相机分辨率读数 `map.camera.metersPerPixel`：以屏幕中心与椭球的交点为深度锚点交给 `camera.getPixelSize()`，因此透视与正交视锥（三维 / 二维）都由 Cesium 计算；中心射线打不到椭球（指向天空）时返回 `undefined` 而不是近似值。配合 `clusterPoints()` 即可按屏幕像素驱动聚合网格（`cellSizeMeters: metersPerPixel * 48`），"缩放时簇自动合并/展开"的策略由业务决定阈值与重算时机。
