---
'@yanbobo/gis-sdk': minor
---

扩展 CZML 覆盖到姿态与模型报文：`czmlFromPositions()` / `czmlFromSamples()` 新增 `model` 选项（写入 `gltf` + `minimumPixelSize`，默认 24，与参照实现一致）；新增 `tracksFromCzml()` 读取 `orientation.unitQuaternion`（静态 4 值或 `[时间, x, y, z, w]` 采样，模长归一化、近零抛错）与 `model.gltf`，姿态按时间精确匹配位置采样，匹配不上时为 `undefined` 而不伪造单位四元数；`velocityReference` 等最小集之外的姿态形式忽略而不拒收整份文档；`positionsFromCzml()` 输出保持原样。
