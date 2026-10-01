# 空间闪电 map.lightning

程序化生成的空间闪电：触发一次，形状按种子随机生成一次，之后逐帧只改材质参数推进亮度包络，结束时释放几何。**只使用 Cesium 公开 API**（`PolylineCollection`、内置 `Material` 的 `PolylineGlow` 类型、`PostProcessStage`），不注册自定义材质、不碰私有字段。

```ts
const id = map.lightning.strike({
  origin: { longitude: 116.391, latitude: 39.907, height: 1_500 }, // 云底
  target: { longitude: 116.4, latitude: 39.91, height: 0 }, // 落点；省略时按长度与方位角推算
  branches: 'normal',
  seed: 42, // 同种子同形状，便于复现
});

map.lightning.activeCount; // 1
map.lightning.flashLevel; // 屏幕闪光亮度 0 到 1，随衰减回零

map.lightning.cancel(id); // 撤掉单次闪击
map.lightning.cancelAll(); // 撤掉全部并清零闪光
```

## 成员

| 成员                | 参数                                       | 行为                                                            |
| ------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `strike(options)`   | 见下表                                     | 触发一次闪击，返回 id；同 id 再次触发**替换**上一次，不并列两条 |
| `cancel(id)`        | `string`                                   | 撤掉指定闪击；不存在时返回 `false`                              |
| `cancelAll()`       | 无                                         | 撤掉全部闪击并清零屏幕闪光                                      |
| `setStyle(options)` | `{ coreColor?, thickness?, screenFlash? }` | 更新外观；对**正在演**的闪击也立即生效                          |
| `activeCount`       | 无                                         | 当前在演的闪击数量                                              |
| `flashLevel`        | 无                                         | 当前屏幕闪光亮度，0 到 1                                        |
| `maxActive`         | 无                                         | 并发上限，固定 8；超出时**淘汰最早触发的闪击**，不抛错          |

`strike()` 的参数（几何部分与 `/core` 的 `generateLightningBolt()` 相同）：

| 参数             | 默认值      | 说明                                                    |
| ---------------- | ----------- | ------------------------------------------------------- |
| `origin`         | 必填        | 起点（云底）经纬高                                      |
| `target`         | 按下面推算  | 落点经纬高                                              |
| `waypoints`      | 无          | 途经点，按顺序插在起点与终点之间                        |
| `lengthMeters`   | `3000`      | 未给 `target` 时的主干长度                              |
| `bearingDegrees` | `0`（正北） | 未给 `target` 时的主干方位角                            |
| `branches`       | `'normal'`  | 分支密度：`sparse`（2 条）/ `normal`（4）/ `dense`（6） |
| `seed`           | `1`         | 随机种子；同种子生成同一条形状                          |
| `trunkVertices`  | `24`        | 主干顶点预算（含端点），按途经点段数分摊                |
| `branchVertices` | `8`         | 每条分支的顶点预算                                      |
| `id`             | 自动编号    | 闪击标识；同 id 替换                                    |
| `durationMs`     | `900`       | 闪击时长                                                |
| `pulses`         | `2`         | 主峰之后的脉冲次数，0 到 3                              |
| `intensity`      | `1`         | 亮度系数，0 到 1                                        |

## 亮度包络

一次闪击的亮度不是简单淡入淡出，而是"预闪 → 主峰 → 脉冲 → 余辉"：

```ts
import { lightningEnvelope } from '@yanbobo/gis-sdk/core';

lightningEnvelope(0.14, 2); // 主峰，接近 1
lightningEnvelope(0.51, 3); // 第三次脉冲的相位
lightningEnvelope(1, 2); // 余辉，低于 0.25
```

折线辉光与屏幕闪光共用同一条包络；屏幕闪光是附加反馈（权重 0.28），不是主光效，`setStyle({ screenFlash: false })` 可关掉。每次闪击共用一份材质：`PolylineCollection` 按材质分组命令，共享材质既少一次 draw，也让主干与分支走同一条亮度曲线。亮度通道 `LightningFlashChannel` 单独导出：写入、读取、按真实秒数衰减——暂停推进就不再衰减，因此回放暂停时闪击会冻结。

## 几何与精度

形状在**起点建立的局部 ENU 坐标系**里生成（`createLocalFrame()`），因此"向东 300 米、向北 200 米"这类形状与纬度无关；段内抖动幅度随段长自适应并夹在 40 到 320 米，段与段的连接点抖动量恒为 0。输出是经纬高序列，需要自己渲染时可以直接用：

```ts
import { generateLightningBolt } from '@yanbobo/gis-sdk/core';

const shape = generateLightningBolt({ origin, lengthMeters: 4000, seed: 7 });
await map.layers.add({
  id: 'bolt',
  type: 'polyline',
  lines: shape.paths.map((path) => ({ points: path.points })),
});
```

局部 ENU 是切平面近似：100 km 量级与真实地面距离差异小于 0.1%，程序化几何足够，精确量算请用 `measureDistance()`。

## 边界

- **不做真实雷电物理**：没有回击序列、电磁效应与声光传播，形状是程序化生成；
- **不做雷击预报**：什么时候触发、触发在哪里由业务决定（实时告警、回放时间轴都可以驱动）；
- **不支持回放拖拽重建**：闪击按真实经过时间推进，`seek` 语义留给业务——需要"拖到某时刻看到那一刻的闪电"时应由数据驱动触发，而不是重建效果状态；
- **不做音频**：声效属于业务。
