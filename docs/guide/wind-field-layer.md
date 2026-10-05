# 三维风场图层 type: 'wind-field'

业务提供 U/V/W 采样网格，SDK 负责粒子平流与渲染：每颗粒子每帧按当前位置采样风场、用一阶欧拉法推进，用两点折线画拖尾，颜色按风速分档。**只使用公开 API**（`PolylineCollection`、`Cartesian3.fromDegrees` 的 result 参数、内置折线材质），不做真实流体求解、不依赖外部数据集格式。

```ts
const layer = await map.layers.add({
  id: 'wind',
  type: 'wind-field',
  field: {
    axes: {
      lon: { start: 110, step: 0.25, count: 33 },
      lat: { start: 30, step: 0.25, count: 25 },
      height: { start: 0, step: 500, count: 2 },
    },
    u: uValues, // 向东分量，米/秒，长度 = 33 × 25 × 2
    v: vValues, // 向北分量
    w: wValues, // 向上分量；省略表示只做水平风
  },
  particles: 3000,
  speedScale: 1,
  lifetimeSeconds: 12,
  colors: ['#38bdf8', '#7dd3fc', '#e0f2fe'],
});

await layer.setData(nextField); // 原子替换风场并重新播撒
await layer.setStyle({ particles: 5000, speedScale: 2 });
```

## 数据契约

| 字段            | 说明                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `axes.lon`      | 经度轴：`{ start, step, count }`，单位为度                                         |
| `axes.lat`      | 纬度轴，单位为度                                                                   |
| `axes.height`   | 高度轴，单位为米                                                                   |
| `u` / `v` / `w` | 向东 / 向北 / 向上分量，米/秒；长度必须等于 `lon.count × lat.count × height.count` |

索引顺序与参照实现一致：`(z × lat.count + y) × lon.count + x`——先经度、再纬度、最后高度（高度为主序）。

**插值是三线性的**，超出网格范围（经度、纬度或高度任一维）采样返回 `undefined`，**不做外推**：这类粒子按"跑出范围"重掷，而不是拿边缘值硬撑出一个看起来还在吹的假象。时序多切片、坐标系换算、缺测填补都在业务侧——SDK 只吃一份静止的网格。

## 参数

| 参数              | 默认值                      | 说明                                                                     |
| ----------------- | --------------------------- | ------------------------------------------------------------------------ |
| `particles`       | `1500`                      | 粒子数（每颗粒子一条折线），上限 20000                                   |
| `speedScale`      | `1`                         | 时间缩放；大于 1 让粒子跑得更快，便于观察                                |
| `lifetimeSeconds` | `12`                        | 生命时长；到期或出界的粒子在范围内重掷（初始年龄随机分布，避免同生同死） |
| `heightMeters`    | 高度轴中点                  | 粒子所在高度                                                             |
| `stepSeconds`     | 取真实帧间隔（上限 0.2 秒） | 固定每帧推进的时间；标签页切回前台不会用巨大 delta 甩飞粒子              |
| `width`           | `2`                         | 拖尾线宽（像素）                                                         |
| `colors`          | 三档蓝色                    | 按风速从低到高 2 到 6 个 CSS 颜色，档位按网格最大风速均分                |
| `opacity`         | `1`                         | 整体透明度（写进折线颜色 alpha）                                         |
| `seed`            | `1`                         | 初始播撒与重掷的随机种子；同种子得到同一批初始位置，便于复现             |

句柄：`particleCount`、`averageSpeed`（当前帧平均风速，米/秒）、`setData()`、`setStyle()`、`setVisible()`、`dispose()`。隐藏时**不再推进**（不空转），重新显示后继续。

## 语义与边界

- **一阶欧拉平流**：`位移 = 风速 × speedScale × Δt`，米→度按粒子纬度换算（与 `clusterPoints()`、热力图同一套球面基准）。不做 RK 高阶积分、不做湍流扩散。
- **拖尾不画瞬移**：粒子重掷的那一帧不画线，避免出现一条横跨视野的长线。
- **每帧一次 `positions` 赋值**：折线集合靠这个 setter 标脏重写顶点缓冲；两点的 `Cartesian3` 复用（`fromDegrees` 的 result 参数），逐帧不分配对象。
- **规模**：`1500` 粒子约合每帧 3000 个顶点，是留有余量的默认值；上万粒子会明显吃 CPU（每颗粒子每帧一次采样 + 一次拖尾更新），请按机型调。
- **不做时序混合、不做剖面/等值线**：那是数据可视化层的事；需要流线图请用 `sampleWind()` 自己算，或把网格降采样后再交给本图层。

## 相关页面

- [环境效果](./environment.md)：雾、霾、雨、雪这类屏幕空间效果
- [密度热力图](./heatmap-layer.md)：同样是"业务数据 → 程序化图形"，但走影像通道
- [纯计算性能基准](./performance.md)：粒子与网格规模对帧预算的影响
