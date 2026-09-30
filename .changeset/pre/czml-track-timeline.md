---
'@yanbobo/gis-sdk': minor
---

增加轨迹回放桥接：`createTrackTimeline(track, options?)` 把 `tracksFromCzml()` 读出的轨迹装成 `ReplayTimeline`——位置按最短弧插值经度（跨 180° 不绕圈）、姿态用四元数球面线性插值，只有一端有姿态时取更近那一端的姿态（保证采样时刻恰好返回该采样自身的姿态），默认不外推；配合 `sampleTrackPose(timeline, trackId, seconds)` 与 `SimulationClock` 即可把 CZML 轨迹驱动到模型图层或相机。
