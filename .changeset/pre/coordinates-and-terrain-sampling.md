---
'@yanbobo/gis-sdk': minor
---

增加类型化坐标转换 `map.coordinates`（经纬高、世界坐标与窗口像素互转，未命中返回 `undefined`）与地形高度采样 `map.terrain.sample()`（分批并发、服务级缓存、无数据不伪造 0、取消与稳定错误码）。
