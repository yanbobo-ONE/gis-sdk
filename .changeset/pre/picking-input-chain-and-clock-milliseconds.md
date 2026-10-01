---
'@yanbobo/gis-sdk': patch
---

修复拾取在真实地图上完全不生效：`map.picking` 注册的 `LEFT_CLICK` / `MOUSE_MOVE` 会被随后构造的绘制控制器覆盖（Cesium 的 `setInputAction` 是覆盖语义），因此 `map.picking.on('click' | 'hover')` 与 `lastHit` 在装了 Viewer 的地图上收不到任何事件——只造单个控制器的单测看不出这个问题。现在 SDK 内部按动作类型把回调串成一条链再装给 Cesium：拾取与绘制同时收到事件，最后一个订阅者退出时才移除动作，也不会误删业务覆盖上去的回调。

修复地图时钟读数丢 1 毫秒：`JulianDate.toDate()` 会把小数毫秒交给 `Date` 的 setter 而被截断（`375.999999996` 变 `375`），整秒时间戳最容易踩到，表现为 `map.clock.time` 与 `clock.bind()` 的源时钟时间戳差 1 毫秒、相等判断随机失败。现在按整秒基准加四舍五入后的小数毫秒读取，毫秒时间戳写入后原样读回。
