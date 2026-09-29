---
'@yanbobo/gis-sdk': minor
---

增加轨道几何：`orbitalElementsFromAnchor()`（由地表锚点推导过该点的标准圆轨道，赤道锚点给出赤道轨道、极点锚点给出极轨）与 `sampleOrbitPositions()`（输出可渲染的经纬高采样点，首尾重合，可直接交给折线图层）；越界取值校验抛错而不静默收敛。
