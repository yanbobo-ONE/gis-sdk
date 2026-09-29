# 2D / 3D 场景切换

`createMap({ scene: { mode } })` 决定初始模式；运行时切换用 `map.scene`。

```ts
await map.scene.setMode('2d', 1.5); // 传入形变时长（秒）；省略由 Cesium 决定
map.scene.mode; // '2d'
map.scene.morphing; // 形变在途时为 true

// 需要"无闪烁"过渡时，先抓一张当前画面做过渡图
const before = await map.capture();
const morphing = map.scene.setMode('3d');
```

## 语义

| 成员                  | 说明                                               |
| --------------------- | -------------------------------------------------- |
| `mode`                | 当前模式；**形变过程中返回目标模式**，而不是中间态 |
| `morphing`            | 是否有形变在途；只反映 SDK 发起的切换              |
| `setMode(mode, sec?)` | 目标 `'2d'` 或 `'3d'`；形变完成时结算 Promise      |

- 已经处于目标模式且没有形变在途时立即结算，不会触发一次多余形变；
- 连续调用时，**被取代的那次以 `SCENE_MORPH_SUPERSEDED`（可重试）拒绝**，后一次照常执行；
- 时长必须是有限的非负秒数，非法取值以 `INVALID_SCENE_CONFIG` 拒绝；模式只支持 `'2d'` 与 `'3d'`（哥伦布视图未封装）；
- 地图销毁时，仍在等待的形变以 `MAP_DISPOSED` 拒绝，并解绑形变完成监听。

## 边界

- **不做双视图切换**：Plugin-web 用两个 Viewer（2D + 3D）+ 当帧截图做过渡（`RenderModeController` + `MapFragmentTransition`），那是为了规避形变闪烁的页面级方案；SDK 只封装 Cesium 的形变原语，需要过渡动画时用 `map.capture()` 自行组合。
- **不封装哥伦布视图**：`scene.morphToColumbusView` 未暴露，需要时走 `map.raw.viewer.scene`。
- 形变过程中的相机行为由 Cesium 决定；SDK 不介入。
