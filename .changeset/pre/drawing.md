---
'@yanbobo/gis-sdk': minor
---

增加交互绘制 `map.drawing`：点 / 折线 / 面三种模式，左键落点、移动预览、右键与双击确认、Esc 取消；绘制流程由框架无关的 `DrawingStateMachine`（含可替换 `DrawRendererPort`）承担，Cesium 侧负责拾取与预览图元，完成图形可撤销或整组清除。
