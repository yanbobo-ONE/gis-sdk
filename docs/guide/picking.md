# 拾取交互

`map.picking` 提供类型化的点击与悬停拾取：把屏幕坐标、命中的 SDK 图层对象、以及该位置的地表经纬高拼成一个事件，业务据此做选中、弹窗、光标与告警。

```ts
const offClick = map.picking.on('click', ({ hit, position, raw }) => {
  if (hit?.kind === 'layer') {
    console.log('命中图层', hit.layerId, '对象', hit.objectId);
  } else if (hit?.kind === 'globe') {
    console.log('点在地球上', position);
  }
});

map.picking.on('hover', ({ hit }) => {
  // 悬停已按帧合并，可以安全地做高亮或光标切换
});

offClick(); // 取消订阅
map.picking.setEnabled(false); // 整层关闭拾取
```

## 事件载荷

| 字段       | 类型                       | 说明                                                 |
| ---------- | -------------------------- | ---------------------------------------------------- |
| `screen`   | `{ x, y }`                 | 画布内屏幕坐标（像素）                               |
| `hit`      | `PickingHit \| undefined`  | 命中信息；什么都没命中时为 `undefined`               |
| `position` | `GeoPosition \| undefined` | 屏幕位置对应的地表经纬高；未命中地球时为 `undefined` |
| `raw`      | `unknown`                  | 原生拾取结果，用于识别 SDK 未标记的对象              |

`PickingHit.kind` 有三种：

- `'layer'`：命中的是 SDK 图层拥有的对象，`layerId` 一定有值，`objectId` 视图层而定；
- `'globe'`：命中的是地球表面；
- `'unknown'`：命中的是其它 Cesium 对象（业务自己加的实体、DataSource 等），用 `raw` 自行识别；如果该对象的 `id` 是字符串，会一并放进 `objectId`。

## 拾取标记

SDK 拥有单个可拾取对象的图层会把标记写进 Cesium 图元的 `id` 字段（`id` 在 Cesium 里本就是给拾取用的语义）：

| 图层     | 标记内容                                                            |
| -------- | ------------------------------------------------------------------- |
| 点位图层 | 每个点写入 `{ layerId, objectId? }`；`objectId` 取自 `PointSpec.id` |
| 静态模型 | 模型写入 `{ layerId }`（`Model.id` 会被覆盖为该标记）               |
| 其它图层 | 不写标记：影像、3D Tiles 命中后按 `'unknown'` 返回原生对象          |

```ts
await map.layers.add({
  id: 'targets',
  type: 'points',
  points: [{ id: 'sat-1', longitude: 116.39, latitude: 39.9 }],
});
// 点击该点时：hit = { layerId: 'targets', objectId: 'sat-1', kind: 'layer' }
```

## 悬停为什么不会拖慢渲染

逐帧 `scene.pick` 是交互卡顿的常见来源（一次拾取要读回一个像素并解析深度）。SDK 采用两条 Plugin-web 已验证的做法：

1. **按帧合并**：一帧内的多次 `MOUSE_MOVE` 只做一次拾取，且只对最后一次位置生效；
2. **相机变化期间暂停**：`camera.changed` 触发后暂停悬停拾取，相机停止变化 140ms 后恢复。拖动地图时不再逐帧拾取。

点击事件不受影响，并且会**向下钻取**最多 8 层，命中被遮挡的 SDK 对象（悬停只信任最上层结果，避免每帧多花开销）。

## 边界

- **只注册 `LEFT_CLICK` 与 `MOUSE_MOVE` 两个输入动作**，不覆盖相机拖拽、滚轮、右键；业务若需要在同一 Viewer 上另加输入动作，注意 Cesium 的 `setInputAction` 是覆盖语义。
- **不提供光标样式、右键菜单、拖拽编辑、框选**：这些属于应用层交互；拖拽与框选需要接管相机输入，SDK 不做。
- **不提供逐点命中回调之外的选择状态**：`map.picking` 只回答"命中了什么"，选中集合、高亮样式由业务维护（可用 `PointSpec` 的颜色覆盖或 `setStyle()` 表现）。
- `lastHit` 是最近一次拾取的命中信息，适合光标与状态栏显示；它不随场景变化自动失效。
