# 纯计算性能基准

SDK 的计算层（空间量算、几何构造、地形剖面判据、姿态、回放、CZML 解析、位置归一化）不依赖渲染引擎，因此可以在 Node 里稳定复现。仓库自带基准脚本：

```bash
pnpm build   # 脚本从 dist 导入，测的是发布产物
pnpm bench   # 可用 BENCH_MS=1000 加长每项测量时间
```

脚本对每项做 120 ms 预热，然后连续跑满 400 ms，输出**每次调用耗时**与**吞吐量**（吞吐量的单位写在名称里：调用 / 点 / 顶点 / 采样点）。

## 实测参考值

以下是一次实测输出（Apple M5 Pro、Node 22、darwin arm64）：

| 项目                                     | 每次调用        | 吞吐量           |
| ---------------------------------------- | --------------- | ---------------- |
| `measureDistance()`（跨城两点）          | 0.08 µs         | 12.6 M 次/秒     |
| `measureArea()`（四边形）                | 0.13 µs         | 7.7 M 次/秒      |
| `filterPointsInPolygon()`（1 万点）      | 713 µs          | 14.0 M 点/秒     |
| `convexHull()`（2 千点）                 | 305 µs          | 6.6 M 点/秒      |
| `simplifyPath()`（5 千顶点，10 米容差）  | 145 ms          | 34.4 k 顶点/秒   |
| `evaluateLineOfSight()`（64 个剖面点）   | 0.11 µs         | 9.0 M 次/秒      |
| `evaluateHorizon()`（32 个剖面点）       | 0.04 µs         | 27.8 M 次/秒     |
| `slerp()`（两姿态之间）                  | 0.10 µs         | 9.6 M 次/秒      |
| `headingPitchRollDegreesFromQuaternion()` | 0.06 µs        | 17.5 M 次/秒     |
| `AttitudeDynamics.advance()`（10 ms 步长） | 0.05 µs       | 20.0 M 次/秒     |
| `ReplayTimeline.sampleAt()`（600 样本，二分） | 0.02 µs    | 60.4 M 次/秒     |
| `SimulationClock.advance()`              | < 0.01 µs       | 257 M 次/秒      |
| `normalizePositions()`（1 万条）         | 47 µs           | 214 M 条/秒      |
| `czmlFromPositions()`（600 个采样点）    | 15 µs           | 40.0 M 采样点/秒 |
| `positionsFromCzml()`（600 个采样点）    | 19 µs           | 31.8 M 采样点/秒 |
| `tracksFromCzml()`（600 个采样点）       | 16 µs           | 38.1 M 采样点/秒 |
| `createTrackTimeline()`（600 个采样点）  | 1.35 ms         | 443 k 采样点/秒  |

## 怎么读这些数字

- **每帧只需要微秒级的**：`evaluateLineOfSight()`、`evaluateHorizon()`、`slerp()`、`sampleAt()`、`SimulationClock.advance()` 都在 0.1 µs 量级——按 60 fps 算，一帧的预算里它们连零头都用不到，可以放心放在渲染循环里。
- **单次调用在百微秒级的**：`filterPointsInPolygon()`、`convexHull()`。适合"数据变化时算一次"，不适合每帧算。
- **`simplifyPath()` 是本表最慢的一项**，145 ms/5 千顶点：RDP 在"容差小、几乎每个点都要保留"时接近最坏情况。轨迹抽稀建议放进 Worker（见[Worker 执行接口](./analysis-worker.md)），或先降采样再抽稀。
- **`createTrackTimeline()` 是"一次性建索引"的成本**（1.35 ms/600 采样点）：建好之后按 `sampleAt()` 查询只要 0.02 µs。
- **`normalizePositions()` 输出可转移的 `Float64Array`**，吞吐量高到可以在数据到达的瞬间跑一遍。

## 口径与限制

- 本表只覆盖**纯计算**，不含 WebGL 渲染、网络、地形采样与 Cesium 对象创建；这些受设备、驱动与场景复杂度影响，无法用单一数字表达。
- 数字来自一台开发机（Apple M5 Pro），不同 CPU 会成比例变化；**关注数量级与相对关系，不要当绝对承诺**。
- 每项测量的"每次调用耗时"包含调用本身的开销；参数规模写在名称里（点数、顶点数），换规模请按算法的复杂度外推。
- 基准跑的是 `dist` 产物（构建后的代码），与业务实际引入的形态一致；Node 与浏览器引擎不同，浏览器里的绝对值会有差异。
- 这项基准是**开发工具**，没有纳入 CI 门禁——不同负载的机器上做阈值断言只会得到 flaky 测试。

## 当前边界

- **没有 WebGL 端到端矩阵**：多浏览器（Chrome / Firefox / Safari、不同 GPU）的渲染帧率与内存还没有自动化验证，需要时按业务目标机型手工跑验收台（`examples/vanilla`）。
- **没有数据规模承诺**：点位图层的单层上限（20 万点）是渲染路径的实测边界，CPU 侧的吞吐请以上表为准自行折算。
