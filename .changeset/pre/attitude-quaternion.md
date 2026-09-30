---
'@yanbobo/gis-sdk': minor
---

姿态数学补完：新增 `quaternionFromHeadingPitchRollDegrees()` / `headingPitchRollDegreesFromQuaternion()`（与 Cesium 的 `HeadingPitchRoll` 逐位一致：航向绕 -Z、俯仰绕 -Y、翻滚绕 +X，组合顺序 heading · pitch · roll，因此同一组角度既能直接喂给模型图层也能与 CZML 的 `unitQuaternion` 对照）、`slerp()`（最短弧球面插值，夹角极小时退化为归一化线性插值）与 `normalizeQuaternion()`。换算与插值都在 `tests/attitude-quaternion.test.ts` 里用真实 Cesium 的 `Quaternion.fromHeadingPitchRoll` 与 `Quaternion.slerp` 作为第二实现逐位比对。
