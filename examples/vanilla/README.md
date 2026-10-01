# Vanilla package consumer

该示例用于验证发布包，而不是直接引用仓库 `src`。从仓库根目录执行：

```bash
pnpm example:prepare
npm --prefix .tmp/vanilla-consumer run dev -- --host 127.0.0.1 --port 4175
```

`example:prepare` 会构建 SDK、生成 `.tgz`、在隔离目录安装该压缩包，并复制 Cesium 静态资源。页面内置本地 WMS fixture，不依赖外部地图服务。

重新运行 `example:prepare` 之前请先停掉正在运行的 dev server：压缩包会在原地替换，仍在运行的 Vite 依赖预构建缓存可能把新旧产物混在一起，表现为页面卡在创建中。必要时删掉 `.tmp/vanilla-consumer/node_modules/.vite` 再启动。

首次加载若一直停在"创建中"，刷新一次即可：Vite 的依赖预构建在首次请求时会边优化边服务，页面可能拿到未完成的依赖图。

面板里的 WMS 图层带了一个自定义鉴权头（`X-Example-Auth`），本地 fixture 会把它记进 `/__test/wms-state`；访问该地址能看到 `lastAuthHeader`，用来验证"请求头真的发到了服务端"。改 fixture 或鉴权逻辑后可以据此回归。

"创建期声明地形"按钮用 `createMap({ terrain })` 重建地图，指向本地地形 fixture `/__test/terrain/`：该 fixture 只提供 `layer.json` 元数据，访问 `/__test/terrain-state` 能看到 `layerJsonRequests`，用来验证创建期声明的地址真的被请求。瓦片数据不在 fixture 范围内，所以验收流程在 `map.terrain.ready` 兑现、记录读数之后会立刻切回椭球地形，面板上的"创建期地形"一行会写出 `类型 / 加载中 pending / 兑现后 pending` 三个读数。

"时钟探针"按钮加载一条带点图形的 CZML 轨迹，用 `SimulationClock` 经 `map.clock.bind()` 驱动地图时钟并播放，等待若干真实渲染帧后**断言**地图时间确实推进、推进量与源时钟一致、播放期间 `animating` 为真；任何一条不成立都把错误写进操作提示，而不是记一个看起来正常的读数。

"实体拾取探针"按钮加载一个静态 CZML 实体并把相机对准它，然后把点击坐标报给验收脚本（写进读数行的 `data-screen`）。探针**不自己合成点击**：Cesium 的输入层会调用 `setPointerCapture`，合成的事件会被拦下，所以必须在画布上真实点一次——点完读数会变成 `命中图层 <图层 id> / 实体 <实体 id>`。

"性能矩阵"按钮跑一遍 12 个场景的渲染读数：固定机位、关闭自动降档（否则测到的是降档之后的开销）、每个场景先等瓦片收敛再等满一个 60 帧采样窗口，然后读 `map.quality.snapshot`。摘要写在面板上，原始矩阵 JSON 在该行的 `data-matrix` 属性里。两处要点：**测量期间标签页必须保持可见**（隐藏时浏览器会暂停渲染、采样窗口被重置，探针等帧带 5 秒超时，切到后台会明确报错而不是一直停在"进行中"，并按正常错误路径清理它加过的图层与订阅）；矩阵里有两行对照（`仅分辨率 0.75` 与 `默认档·复测`），用来把"切档变快/变慢"与顺序、预热、漂移区分开——本机实测发现降分辨率反而更慢，结论与口径见[性能基准](../../docs/guide/performance.md#渲染层浏览器端矩阵)。

SDK 上报的致命错误（例如渲染循环已停止的 `RENDER_LOOP_FAILED`）显示在面板顶部的独立一行，与操作结果分开、不被后续操作覆盖——这类失败不会让任何一次调用失败，只有 `map:error` 事件会告诉业务。

验收面板覆盖：图层增删与数据替换、WMS 透明度与 CQL 过滤、环境效果（晴 / 雾 / 霾 / 雨 / 雪）、两点通视分析、相机位姿读取、点位图层与标签（含 `labelCount` 读数与开关）、按 `metersPerPixel` 驱动的点聚合、CZML 轨迹图层、地图时钟播放与实体级拾取探针、20 点的批量坡度坡向分析、创建期地形声明与 `ready` 语义，以及浏览器端性能矩阵。`vite.config.ts` 里把 `cesium` 指向 Cesium 自带的构建产物，原因见[依赖与打包](../../docs/guide/getting-started.md#依赖与打包)。
