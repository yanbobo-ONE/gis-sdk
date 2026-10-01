# 错误处理与 Cesium 原生出口

SDK 的稳定错误由 `GisError` 表示。业务应按 `code` 分支，不要按错误消息文本分支。

## 处理错误：GisError

```ts
import { GisError } from '@yanbobo/gis-sdk/core';

try {
  await map.layers.remove('roads');
} catch (error) {
  if (error instanceof GisError) {
    console.error(error.code, error.module, error.operation, error.retryable);
    if (error.retryable) {
      // 根据业务策略重试。
    }
  }
}
```

| 字段        | 类型           | 用途                          |
| ----------- | -------------- | ----------------------------- |
| `code`      | `GisErrorCode` | 稳定业务分支判断值            |
| `module`    | `string`       | 失败模块，例如 `layer`、`map` |
| `operation` | `string`       | 操作，例如 `add`、`destroy`   |
| `retryable` | `boolean`      | 是否适合由业务重试            |
| `cause`     | `unknown`      | 原始异常，用于日志诊断        |

常见的可恢复错误包括 `LAYER_LOAD_FAILED`、`TERRAIN_LOAD_FAILED`、`CAMERA_VIEW_UNAVAILABLE` 与 `MAP_DESTROY_FAILED`；是否自动重试取决于业务的网络、鉴权和路由策略。参数类错误（如 `INVALID_ENVIRONMENT_CONFIG`、`INVALID_ANALYSIS_INPUT`、`INVALID_REALTIME_SOCKET_CONFIG`）与能力类错误（如 `ENVIRONMENT_UNSUPPORTED`、`UNKNOWN_ANALYSIS_TOOL`）不适合重试，应修正调用方式或换用其它效果。

### 渲染循环停止：RENDER_LOOP_FAILED

引擎在渲染循环里抛出致命错误后**会停掉渲染**（Cesium 会在画布上弹自己的错误面板）。这类失败不会让任何一次 SDK 调用失败，也不会改变 `map.state` 与图层状态——如果不上报，业务只看到"画面不动了"，很容易当成卡顿去查。SDK 把它转成一次 `map:error`：

```ts
map.events.on('map:error', ({ error }) => {
  if (error.code === 'RENDER_LOOP_FAILED') {
    // 渲染已停止，业务侧唯一可靠的动作是重建地图。
    void map.destroy().then(() => recreateMap());
  }
});
```

- `module` 为 `'scene'`，`cause` 是引擎原始错误（例如 WebGL 上下文丢失）。
- **只上报一次**：Cesium 触发该事件后即停止渲染，重复上报只会刷屏。
- **不可重试**：渲染循环不会自己恢复，`retryable` 为 `false`；需要继续用图就重建地图（先 `destroy()` 再 `createMap()`）。
- 常见的触发条件是页面长时间处于后台后 WebGL 上下文失效，或 GPU 驱动异常；SDK 无法预防这类引擎级故障，只能保证它被报出来。

## 使用原生 Cesium：map.raw.viewer

SDK 尚未覆盖的高级能力可以从 `raw.viewer` 使用 Cesium 公共 API。

```ts
map.raw.viewer.camera.flyHome(0.8);
map.raw.viewer.scene.requestRender();
```

### 资源所有权规则

| 对象由谁创建                         | 由谁释放                                       |
| ------------------------------------ | ---------------------------------------------- |
| `map.layers.add()` 创建的图层        | SDK，通过 `remove`、`clear` 或 `map.destroy()` |
| `map.basemap` 创建的 XYZ 底图        | SDK，通过 `clear` 或 `map.destroy()`           |
| 业务通过 `map.raw.viewer` 创建的对象 | 业务自行释放                                   |

不要自行移除 SDK 拥有的 `viewer.dataSources`、`viewer.imageryLayers` 或 `viewer.scene.primitives` 项目，否则 SDK 无法保证状态与资源清理。`_layers`、`_root`、`_materialCache` 等 Cesium 私有字段不属于 SDK 兼容承诺。

## 未发布方法

当前没有 `map.materials`、`map.diagnostics`、体积类环境效果或动态数据图层类型。需要临时使用 Cesium 原生能力时，请把创建与释放放在同一个业务模块中，并在页面销毁时一并清理。
