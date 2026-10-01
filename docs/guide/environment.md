# 环境效果

`map.environment` 提供三类**轻量**环境效果：深度雾、基础雾（官方 Fog）与降水（雨 / 雪）。它们是 SDK 自己创建并释放的后处理阶段或场景字段，业务不需要碰 `map.raw.viewer`。

```ts
// 深度雾：按相机距离与椭球高双重衰减，天空单独处理
map.environment.set('depthFog', { density: 0.4, color: '#9fb6c8' });

// 基础雾：只写声明的字段，未声明项保持场景当前值
map.environment.set('haze', { density: 0.001, maxHeight: 800_000 });

// 降水：一次只生效一种，应用雪会替换雨
map.environment.set('rain', { intensity: 'heavy', windDirection: 90, windStrength: 0.5 });

map.environment.setEnabled('rain', false); // 暂停而保留参数
map.environment.clear('rain'); // 释放效果
map.environment.clearAll(); // 全部释放
map.environment.active; // 当前生效的效果状态
```

`set()` 返回生效后的状态，包含补齐了默认值的 `options` 与可选的 `degraded` 说明（例如二维模式下的深度雾）：

```ts
const state = map.environment.set('depthFog', { density: 0.4 });
state.degraded; // '二维模式不应用深度雾（深度编码不适用）' | undefined
```

## 效果与资源归属

| 效果          | 实现                                          | 清除时                                         |
| ------------- | --------------------------------------------- | ---------------------------------------------- |
| `depthFog`    | SDK 创建的后处理阶段（深度反投影 + 高度衰减） | 从 `postProcessStages` 移除并销毁阶段          |
| `rain`/`snow` | SDK 创建的后处理阶段（程序化屏幕空间粒子）    | 两者共用一个阶段；都清除时移除并销毁           |
| `haze`        | 接管官方 `scene.fog` 的字段                   | 恢复接管前的值（期间被业务改过的字段保持不动） |

`haze` 恢复只覆盖"当前值仍等于 SDK 最后写入值"的字段：业务在 SDK 生效期间通过 `scene.fog` 写入的新值不会被覆盖。

## 参数

### 深度雾 `depthFog`

| 参数                  | 范围           | 默认值    | 说明                     |
| --------------------- | -------------- | --------- | ------------------------ |
| `density`             | 0 到 1         | `0.35`    | 密度倍率                 |
| `startDistanceMeters` | ≥ 0            | `1000`    | 起雾的相机距离           |
| `endDistanceMeters`   | > 起始距离     | `120000`  | 完全不透明的距离         |
| `color`               | CSS 颜色字符串 | `#9fb6c8` | 雾色                     |
| `heightFalloffMeters` | 1 到 1e7       | `4000`    | 高度衰减尺度             |
| `topHeightMeters`     | 1 到 1e7       | `3000`    | 雾柱顶高度               |
| `brightness`          | 0.3 到 1.4     | `1`       | 画面亮度倍率（雾色同步） |

### 基础雾 `haze`

| 参数                     | 范围      | 说明                             |
| ------------------------ | --------- | -------------------------------- |
| `density`                | 0 到 0.02 | 雾密度                           |
| `heightFalloff`          | 0.1 到 3  | 高度衰减指数                     |
| `maxHeight`              | ≥ 0       | 生效的最大椭球高（米），0 不限制 |
| `brightnessFloor`        | 0 到 1    | 最低亮度                         |
| `screenSpaceErrorFactor` | 0 到 10   | 全局屏幕空间误差系数             |

未声明的字段不会被写入，因此不会把场景里已有的雾参数重置成 SDK 默认值。

### 降水 `rain` / `snow`

| 参数            | 范围          | 默认值     | 说明                           |
| --------------- | ------------- | ---------- | ------------------------------ |
| `intensity`     | 三档          | `moderate` | `light` / `moderate` / `heavy` |
| `density`       | 0.3 到 2.5    | `1`        | 粒子密度倍率                   |
| `speed`         | 0.5 到 8      | `1`        | 下落速度倍率                   |
| `windDirection` | -360 到 360   | `0`        | 风向方位角（度），0 北 90 东   |
| `windStrength`  | 0 到 1        | `0.25`     | 风强度                         |
| `streakLength`  | 0.1 到 1      | `0.5`      | 雨丝长度，数值越大雨丝越短     |
| `flakeSize`     | 0.005 到 0.04 | `0.02`     | 雪花大小                       |
| `brightness`    | 0.3 到 1.6    | `1`        | 整体亮度                       |

参数越界不会被静默夹取，而是抛出 `INVALID_ENVIRONMENT_CONFIG`；颜色无法解析时同样抛错，并保留已生效的旧参数。终端不支持某个效果（例如场景没有 Fog 对象）时抛出 `ENVIRONMENT_UNSUPPORTED`。

## 行为与边界

- **降水是屏幕气氛，不是空间降水体积**：粒子在屏幕空间下落，风向通过相机基向量投影到屏幕，因此转动相机会改变雨丝的倾斜方向。它表达"此刻在下雨"，不代表任何气象量。
- **降水会持续请求渲染**：雨雪启用时每帧请求一次渲染，因此即使业务开启了按需渲染（`requestRenderMode`）动画也会继续。
- **动画时间与地图时钟无关**：按真实时间推进，单帧增量上限 0.1 秒，页面切回前台不会让粒子瞬移；暂停地图时钟不会让降水停住。
- **二维模式不应用深度雾**：二维模式的深度编码不适用，SDK 会把强度置 0 并在状态里给出 `degraded` 说明；降水与基础雾在二维下仍可用。
- **不做重效果**：体积云、热力图、三维风场、闪电、水面需要体积纹理或数据集，SDK 不附带纹理资产，当前**不封装**；这类效果由业务在 `map.raw.viewer` 上自行实现并管理资源。
- **自定义材质不封装**：注册自定义 GLSL 材质要走 Cesium 的私有材质缓存，SDK 不使用私有字段。
- **不随质量档降层**：降水固定三层粒子；需要更省时降低 `density` 或直接关闭该效果。

## 其它终端

参数校验、默认值与动画时间线都在 `@yanbobo/gis-sdk/core`，零 Cesium 依赖，可复用到其它渲染终端：

```ts
import {
  resolveEnvironmentOptions,
  EnvironmentTimeline,
  PRECIPITATION_INTENSITY_DENSITY,
} from '@yanbobo/gis-sdk/core';

const options = resolveEnvironmentOptions('rain', { intensity: 'heavy' });
const timeline = new EnvironmentTimeline(); // 每次采样传入单调时间（毫秒）
timeline.advance(performance.now());
```

`FieldGuard`（`@yanbobo/gis-sdk/core`）也可以用来接管其它共享对象的字段：写入时记录原值，恢复时只覆盖自己最后写入的字段。
