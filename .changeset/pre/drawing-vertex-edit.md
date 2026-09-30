---
'@yanbobo/gis-sdk': minor
---

绘制编辑支持顶点增删：`map.drawing.insertVertex(position, index?)` 在编辑会话中插点（省略下标追加到末尾，点几何拒绝），`map.drawing.removeVertex(index?)` 删点（省略下标删除当前编辑的顶点，折线最少 2 点、面最少 3 点、点最少 1 点，低于下限拒绝），删除后编辑目标自动顺延，`cancelEdit()` 会把插删一起还原。同时导出零依赖纯函数 `insertVertexAt()` / `removeVertexAt()` / `nearestSegmentIndex()`（按米制距离选最近的线段，便于业务算出插入下标）；SDK 不绑定具体手势。
