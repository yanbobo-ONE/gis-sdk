# Vanilla package consumer

该示例用于验证发布包，而不是直接引用仓库 `src`。从仓库根目录执行：

```bash
pnpm example:prepare
npm --prefix .tmp/vanilla-consumer run dev -- --host 127.0.0.1 --port 4175
```

`example:prepare` 会构建 SDK、生成 `.tgz`、在隔离目录安装该压缩包，并复制 Cesium 静态资源。页面内置本地 WMS fixture，不依赖外部地图服务。
