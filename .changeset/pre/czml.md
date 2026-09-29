---
'@yanbobo/gis-sdk': minor
---

增加 CZML 位置采样的生成与解析：`czmlFromSamples()` / `czmlFromPositions()` 输出最小可用文档（document 包 + 位置的 `cartographicDegrees` 与 `availability`），`positionsFromCzml()` 支持秒数与 ISO 时间戳、包级 epoch 覆盖与可用区间，往返一致；数据源加载与时钟联动仍走原生出口。
