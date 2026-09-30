# Vanilla package consumer

该示例用于验证发布包，而不是直接引用仓库 `src`。从仓库根目录执行：

```bash
pnpm example:prepare
npm --prefix .tmp/vanilla-consumer run dev -- --host 127.0.0.1 --port 4175
```

`example:prepare` 会构建 SDK、生成 `.tgz`、在隔离目录安装该压缩包，并复制 Cesium 静态资源。页面内置本地 WMS fixture，不依赖外部地图服务。

重新运行 `example:prepare` 之前请先停掉正在运行的 dev server：压缩包会在原地替换，仍在运行的 Vite 依赖预构建缓存可能把新旧产物混在一起，表现为页面卡在创建中。必要时删掉 `.tmp/vanilla-consumer/node_modules/.vite` 再启动。

验收面板覆盖：图层增删与数据替换、WMS 透明度与 CQL 过滤、环境效果（晴 / 雾 / 霾 / 雨 / 雪）、两点通视分析，以及相机位姿读取。`vite.config.ts` 里把 `cesium` 指向 Cesium 自带的构建产物，原因见[依赖与打包](../../docs/guide/getting-started.md#依赖与打包)。
