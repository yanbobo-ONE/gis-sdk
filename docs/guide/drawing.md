# 绘制

`map.drawing` 提供点、折线、面的交互绘制：左键落点、移动预览、右键或双击确认、Esc 取消。绘制流程与几何累积在一层**纯状态机**（`DrawingStateMachine`）里，Cesium 侧只负责输入拾取与预览图元，因此同一套流程也能被其它终端复用。

```ts
map.drawing.on('complete', (geometry) => {
  // geometry = { mode: 'polygon', positions: [{ longitude, latitude, height? }, ...] }
  // 业务可以把它落成自己的图层、提交到后端，或保持 SDK 的默认呈现
  map.layers.add({
    id: `area-${Date.now()}`,
    type: 'polyline',
    polylines: [{ positions: geometry.positions }],
  });
});

map.drawing.on('cancel', () => console.log('已取消'));

map.drawing.start('polygon'); // 'point' | 'polyline' | 'polygon'
map.drawing.mode; // 'polygon'
map.drawing.vertexCount; // 已确定的顶点数（不含预览用的光标位置）
```

## 交互与完成条件

| 动作     | 行为                                              |
| -------- | ------------------------------------------------- |
| 左键     | 追加顶点；**点模式落第一个点即完成**              |
| 鼠标移动 | 渲染预览（已确定顶点 + 光标位置）；点模式没有预览 |
| 右键     | 结束绘制，并把右键位置并入几何                    |
| 左键双击 | 结束绘制（不含新顶点）                            |
| Esc      | 取消当前绘制                                      |

顶点数不足时确认不会结束绘制：折线至少 2 个顶点、面至少 3 个顶点。非法坐标（非有限值或超出经纬范围）会被忽略，不会中断绘制。

## 程序化绘制

交互只是状态机的一种驱动方式，脚本也可以直接驱动：

```ts
map.drawing.start('polyline');
map.drawing.finish(); // 顶点不足时返回 undefined
```

需要完全程序化时，可直接使用纯状态机 `DrawingStateMachine`，把渲染端口换成自己的实现（例如画到 Canvas 或另一个引擎）：

```ts
import { DrawingStateMachine } from '@yanbobo/gis-sdk/core';

const machine = new DrawingStateMachine(
  {
    renderPreview: (value) => canvasPreview(value),
    renderCompleted: (value) => canvasFinal(value),
    removePreview: (handle) => handle.dispose(),
    removeCompleted: (handle) => handle.dispose(),
  },
  (geometry) => submit(geometry),
);
```

## 完成后的顶点编辑

完成的几何还可以再进入一次**编辑会话**，拖动顶点或整体移动点：

```ts
// 进入编辑：SDK 复制一份几何，不回写调用方传入的对象
map.drawing.edit({ mode: 'polyline', positions });
map.drawing.editing; // 编辑中的几何（拖动时实时更新）

// 左键按在顶点附近开始拖动，松开左键结束这次拖动，会话仍在
map.drawing.commitEdit(); // 提交，返回最终几何
map.drawing.cancelEdit(); // 放弃，几何回到 edit() 时的快照

map.drawing.on('edit', (geometry) => {}); // 每次拖动更新
map.drawing.on('editCommit', (geometry) => {}); // 提交
map.drawing.on('editCancel', (geometry) => {}); // 取消，参数为还原后的几何
```

| 动作          | 行为                                              |
| ------------- | ------------------------------------------------- |
| 左键按下      | 命中屏幕 12 像素内最近的顶点开始拖动；点几何无需命中 |
| 拖动          | 持续更新几何并抛出 `edit`；非法落点被忽略         |
| 左键松开      | 结束本次拖动，编辑会话保留                        |
| Esc（拖动中） | 只回退本次拖动，会话继续                          |
| Esc（未拖动） | 取消整个编辑会话，几何还原并抛出 `editCancel`     |

编辑与绘制互斥：`edit()` 会取消进行中的绘制，`start()` 会结束编辑会话。编辑中的几何用**品红实线**渲染，与黄色虚线预览、青色完成图形区分。

需要把编辑接到自己的数据上时，用纯状态机 `DrawingEditMachine` 传入 `DrawingEditPort`（`get`/`update`）即可，不依赖 Cesium：

```ts
import { DrawingEditMachine, isEditableGeometry } from '@yanbobo/gis-sdk/core';

const machine = new DrawingEditMachine(
  { get: (id) => store.get(id), update: (geometry) => store.set(geometry) },
  (geometry) => rerender(geometry),
);
if (isEditableGeometry(candidate)) machine.begin({ id: 'shape-1', vertexIndex: 2 });
```

## 已完成图形的管理

完成的图形由控制器持有（默认样式：青色实线 + 顶点，预览为黄色虚线）：

```ts
map.drawing.removeLatestCompleted(); // 撤销最近一次
map.drawing.clearCompleted(); // 全部清除
```

业务要自定义样式时，监听 `complete` 后用[折线图层](./polyline-layer.md) / [点位图层](./points-layer.md) 重新渲染同一份几何，再调用 `clearCompleted()` 清掉 SDK 的默认呈现。

## 当前边界

- **不做顶点增删**：编辑会话只能拖动已有顶点、整体移动点；插入与删除顶点仍需删除后重画。
- **不做吸附与捕捉**：拖动与绘制都不吸附到已有图形顶点、边或地形表面。
- **不做贴地绘制**：预览与结果都用椭球高（`height` 默认 0）；需要贴地时先把几何交给地形采样（`map.terrain.sample()`）再渲染。
- **不拦截相机操作**：绘制与编辑期间相机仍可拖动缩放；如需锁定，用 `map.raw.viewer.scene.screenSpaceCameraController.enableInputs = false`。
