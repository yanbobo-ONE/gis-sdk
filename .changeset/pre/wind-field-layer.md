---
'@yanbobo/gis-sdk': minor
---

增加三维风场图层 `type: 'wind-field'`：业务提供 U/V/W 采样网格（`axes` 三轴定义 + `u` / `v` / `w` 三个分量，长度等于 `lon.count × lat.count × height.count`，索引顺序 `(z × lat.count + y) × lon.count + x`），SDK 负责采样与粒子平流渲染。**采样是三线性的，超出网格范围返回 `undefined` 并且不外推**（这类粒子按"跑出范围"重掷，不拿边缘值硬撑）；每颗粒子每帧按当前位置采样风场、用一阶欧拉法推进（米→度按粒子纬度换算），用两点折线画拖尾（两点 `Cartesian3` 复用 `fromDegrees` 的 result 参数，逐帧不分配对象），颜色按风速分档（默认三档蓝，`colors` 可配 2 到 6 档）；粒子到期或出界在范围内重掷，**重掷那一帧不画线**（避免瞬移长线），初始年龄随机分布避免同生同死；样式可传 `seed`（默认 1），同种子得到同一批初始位置，重掷按"种子 + 帧序号"推进，问题可复现。`setData()` / `setStyle()` 原子替换（期间以可重试的 `LAYER_BUSY` 拒绝），隐藏时不再推进（不空转），句柄给出 `particleCount` / `averageSpeed` 读数。`/core` 同时导出零 Cesium 的纯计算 `buildWindField()` / `sampleWind()` / `createWindParticles()` / `advectWindParticles()`（同一状态与种子得到同一结果，便于单测与复现）。只用公开 API（`PolylineCollection` + 内置 `PolylineGlow` 材质 + `Cartesian3.fromDegrees` 的 result 参数），不做真实流体求解、不做时序混合。规模上限 20000 粒子，默认 1500。
