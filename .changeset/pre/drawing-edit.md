---
'@yanbobo/gis-sdk': minor
---

增加绘制编辑 `map.drawing.edit()` / `commitEdit()` / `cancelEdit()`：对几何副本做顶点拖动（左键命中屏幕 12 像素内最近顶点、点几何整体移动），拖动与提交 / 回退分别抛出 `edit`、`editCommit`、`editCancel` 事件，编辑中的几何用独立样式渲染；同时导出框架无关的 `DrawingEditMachine`（`get`/`update` 端口）与几何校验 `isEditableGeometry()`、`isValidDrawPosition()`。
