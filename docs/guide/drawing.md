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

## 程序化构造图形

圆、椭圆与直线箭头不用逐点拖，直接由控制点算出来（`/core`，零 Cesium）：

```ts
import { buildCircle, buildEllipse, buildStraightArrow } from '@yanbobo/gis-sdk/core';

const circle = buildCircle({ center: { longitude: 116.39, latitude: 39.9 }, radiusMeters: 50_000 });
const ellipse = buildEllipse({
  center: { longitude: 116.39, latitude: 39.9 },
  semiMajorMeters: 80_000,
  semiMinorMeters: 30_000,
  rotationDegrees: 90, // 长轴指向正东
});
const arrow = buildStraightArrow({
  from: { longitude: 116.39, latitude: 39.9 },
  to: { longitude: 116.9, latitude: 39.9 },
});

// 结果是顶点环（首尾不重复）；多边形渲染时自己补上闭合点即可
await map.layers.add({
  id: 'coverage',
  type: 'polyline',
  polylines: [{ id: 'circle', positions: [...circle, circle[0]] }],
});
```

| 函数                   | 控制点                       | 说明                                                                    |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `buildCircle()`        | 圆心 + 半径                  | 顶点按**大圆距离**落在半径上，靠近两极也不会被经度压扁                  |
| `buildEllipse()`       | 圆心 + 长短半轴 + 长轴方位角 | 在圆心的局部东-北平面上构造，`rotationDegrees` 是长轴方位角（0 为正北） |
| `buildStraightArrow()` | 起点 + 终点                  | 箭杆 + 双翼箭头，终点是唯一箭尖；尾宽与头宽省略时按全长推导             |

三个函数都返回**顶点环**（首尾不重复），可以直接喂给点位 / 折线 / 绘制（多边形补一个闭合点）。

圆弧类形状按**弦高容差**采样：`toleranceMeters`（默认 10 米）越小越接近真圆，半径越大自动加密，但不会超过 `maxSamples`（默认 512）——所以可以放心用大半径，顶点数不会随半径线性膨胀。

参数非法时抛 `INVALID_SPATIAL_INPUT`（半径为负、短半轴大于长半轴、起终点重合、采样口径非法），坐标非法时抛 `INVALID_COORDINATES`，不会静默产出退化图形。

**边界**：只提供通用几何（圆 / 椭圆 / 直线箭头）。军标（战术箭头、队形、钳击箭头这类）依赖具体标准与业务语义，SDK 不定义；序列化（存成什么格式、带哪些业务字段）同样留给业务。

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

| 动作          | 行为                                                 |
| ------------- | ---------------------------------------------------- |
| 左键按下      | 命中屏幕 12 像素内最近的顶点开始拖动；点几何无需命中 |
| 拖动          | 持续更新几何并抛出 `edit`；非法落点被忽略            |
| 左键松开      | 结束本次拖动，编辑会话保留                           |
| Esc（拖动中） | 只回退本次拖动，会话继续                             |
| Esc（未拖动） | 取消整个编辑会话，几何还原并抛出 `editCancel`        |

编辑与绘制互斥：`edit()` 会取消进行中的绘制，`start()` 会结束编辑会话。编辑中的几何用**品红实线**渲染，与黄色虚线预览、青色完成图形区分。

### 顶点增删

编辑会话里还可以插点与删点：

```ts
map.drawing.insertVertex({ longitude: 116.4, latitude: 39.9 }, 2); // 插到下标 2 上，后续顶点后移
map.drawing.insertVertex({ longitude: 116.41, latitude: 39.91 }); // 省略下标：追加到末尾
map.drawing.removeVertex(0); // 删除指定顶点
map.drawing.removeVertex(); // 省略下标：删除当前正在编辑的顶点
```

| 行为         | 规则                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| 插入位置     | `index` 省略时追加到末尾；插入点在编辑目标之前时，编辑目标自动后移一位     |
| 插入限制     | 点几何不能插点（插了就不是点）；非法落点与越界下标被忽略，返回 `undefined` |
| 删除限制     | 折线最少 2 个顶点、面最少 3 个顶点、点最少 1 个；低于下限时拒绝删除        |
| 删除后的会话 | 删掉正在编辑的顶点时，编辑目标顺延到后一个顶点（已到末尾则退回最后一个）   |
| 回退         | `cancelEdit()` 会把插删一起还原成进入编辑时的快照                          |

用 `nearestSegmentIndex(geometry, position)`（`/core`）可以判断"点在哪一段上"，据此算出插入下标；它按米制距离判定，高纬度不会选错线段。SDK 不绑定具体手势（右键菜单、工具条按钮、双击线段都可以），交互留给业务。

需要把编辑接到自己的数据上时，用纯状态机 `DrawingEditMachine` 传入 `DrawingEditPort`（`get`/`update`）即可，不依赖 Cesium：

```ts
import { DrawingEditMachine, isEditableGeometry } from '@yanbobo/gis-sdk/core';

const machine = new DrawingEditMachine(
  { get: (id) => store.get(id), update: (geometry) => store.set(geometry) },
  (geometry) => rerender(geometry),
);
if (isEditableGeometry(candidate)) machine.begin({ id: 'shape-1', vertexIndex: 2 });
```

## 吸附

开启吸附后，落点与拖动会吸到**已完成图形**的顶点上（可选线段）：

```ts
map.drawing.setSnap({ enabled: true, pixelTolerance: 12, includeEdges: false });
map.drawing.snap; // { enabled, pixelTolerance, includeEdges }
```

| 参数             | 默认值  | 说明                                                  |
| ---------------- | ------- | ----------------------------------------------------- |
| `enabled`        | 必填    | 是否启用吸附                                          |
| `pixelTolerance` | `12`    | 屏幕像素阈值，1 到 64；按像素判定，缩放级别不影响手感 |
| `includeEdges`   | `false` | 是否同时吸附到线段；默认只吸顶点，行为更可预测        |

判定规则是**顶点优先**：阈值内有顶点就吸顶点，无论线段是否更近——密集折线上靠近交点时不会因为"线段更近"而错过顶点。线段候选的落点按屏幕比例在两端之间插值，经度走最短弧。

吸附目标包括：已完成图形的顶点（与线段）、绘制过程中已确定的顶点、编辑会话中**除当前拖动顶点之外**的同图形顶点。因此拖动一个顶点可以精确对齐到相邻顶点，也能把新画的点吸回已有顶点做闭合。

其它终端可以直接用 `/core` 的纯函数：`findSnapTarget(vertices, segments, cursor, options)` 与 `segmentsOf(vertices)` 只吃屏幕坐标与经纬高，不依赖渲染引擎。

## 已完成图形的管理

完成的图形由控制器持有（默认样式：青色实线 + 顶点，预览为黄色虚线）：

```ts
map.drawing.removeLatestCompleted(); // 撤销最近一次
map.drawing.clearCompleted(); // 全部清除
```

业务要自定义样式时，监听 `complete` 后用[折线图层](./polyline-layer.md) / [点位图层](./points-layer.md) 重新渲染同一份几何，再调用 `clearCompleted()` 清掉 SDK 的默认呈现。

## 当前边界

- **不绑定顶点增删手势**：插点与删点提供的是程序化 API 与纯函数，右键菜单、工具条按钮等交互由业务自己绑定。
- **吸附范围限于 SDK 自己画的图形**：不会吸附到业务图层（GeoJSON / WMS 等）或地形表面；需要跨图层吸附时用 `/core` 的 `findSnapTarget()` 自己拼候选。
- **不做贴地绘制**：预览与结果都用椭球高（`height` 默认 0）；需要贴地时先把几何交给地形采样（`map.terrain.sample()`）再渲染。
- **不拦截相机操作**：绘制与编辑期间相机仍可拖动缩放；如需锁定，用 `map.raw.viewer.scene.screenSpaceCameraController.enableInputs = false`。
- **与拾取共用输入动作**：绘制占用 `LEFT_CLICK` / `MOUSE_MOVE` / `LEFT_DOWN` / `LEFT_UP` / `RIGHT_CLICK` / `LEFT_DOUBLE_CLICK`，与 `map.picking` 的点击、悬停按类型串在同一条链上，两者可以同时收到事件；但业务直接调 Cesium 的 `setInputAction` 会覆盖整条链。
