---
'@yanbobo/gis-sdk': minor
---

增加相机只读快照 `map.camera.view` 与 `map.camera.viewRectangle`：前者给出当前经纬高与航向 / 俯仰 / 翻滚（角度为度，字段一定存在，可直接传回 `setView()`），位姿退化时抛 `CAMERA_VIEW_UNAVAILABLE`；后者给出视口在地表覆盖的经纬四至，相机看不到椭球或视野覆盖全球时返回 `undefined`，不再用全球范围的假四至。
