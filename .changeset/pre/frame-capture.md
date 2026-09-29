---
'@yanbobo/gis-sdk': minor
---

增加画布快照 `map.capture()`：在 `postRender` 同一帧拷贝绘图缓冲区（因此无需开启 `preserveDrawingBuffer`），带降采样判空、重试与超时，失败时返回 `undefined` 而不是抛错。
