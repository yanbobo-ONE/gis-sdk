---
'@yanbobo/gis-sdk': minor
---

增加环境效果 `map.environment`：`set(kind, options)` / `setEnabled()` / `clear()` / `clearAll()` 覆盖深度雾（距离与高度双衰减、天空单独分支）、基础雾（接管官方 `scene.fog` 字段，清除时按"只覆盖自己最后写入的值"恢复）与雨 / 雪（程序化屏幕空间粒子、风向与强度，两者共用一个后处理阶段）。参数越界抛 `INVALID_ENVIRONMENT_CONFIG`，终端不支持抛 `ENVIRONMENT_UNSUPPORTED`，二维模式下深度雾给出降级说明；参数校验、默认值与按真实时间有界推进的 `EnvironmentTimeline`、可复用的 `FieldGuard` 都在 `/core`，零 Cesium 依赖，着色器内联不引用外部纹理资产。
