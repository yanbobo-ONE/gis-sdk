# 发版清单

面向维护者：从"代码就绪"到"npm 上可安装"的完整步骤，以及每一步的验证方式。发版流程里的坑都来自实测，不是猜的。

## 0. 前提

- 发布账号需对 `@yanbobo` 有写权限，且 **2FA 已开启**（账号 `yanbobo` 用安全密钥 + "write actions 要求 2FA"）。
- 因此命令行写操作有两条路：
  - **Granular Access Token 勾 Bypass 2FA**（scope 需选中 `@yanbobo` 或具体包，权限 Read and write (publish and stage)）——可非交互执行；
  - 或在本机跑交互式命令，用安全密钥确认（`npm publish` 会自动拉起浏览器）。

## 1. 准备版本与 CHANGELOG（手动）

本仓库处于 changeset pre 模式，`changeset version` **不会**改版本号，必须手改：

1. `package.json` 的 `version` 提升一位（例如 `0.1.0-alpha.10` → `0.1.0-alpha.11`）；
2. `CHANGELOG.md` 顶部新开一段 `## x.y.z-alpha.N`，把本次的 Minor/Patch 条目写进去（已经发过的段落不要再改，否则会声称线上包里有它其实没有的东西）；
3. `.changeset/pre/` 里为本次变更各留一条 changeset（历史条目**不要删除**）。

## 2. 门禁（六项全跑）

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm pack:check && pnpm docs:build
```

`pack:check` 包含 `publint` 与 `arethetypeswrong`，能挡住入口/类型导出错误；`docs:build` 里的 TypeDoc 会检查公开 API 的注释完整性——**六项要成套跑**，只跑 `build`/`test` 会漏掉类型与文档问题。

## 3. 发布

```bash
pnpm release   # = changeset publish，预发布模式下带 alpha dist-tag，并打 git tag
```

## 4. 发布后必须做的两件收尾

1. **核对 dist-tag**：`npm publish` 默认把新版本挂到 `latest`，`alpha` 会**留在旧版本**——消费方 `pnpm add @yanbobo/gis-sdk@alpha` 会装到旧包。

   ```bash
   npm dist-tag ls @yanbobo/gis-sdk
   npm dist-tag add @yanbobo/gis-sdk@<version> alpha   # 需要 Bypass token 或 --otp
   npm view @yanbobo/gis-sdk@alpha version             # 期望解析到新版本
   ```

2. **推 git tag**：`changeset publish` 只打本地 tag。

   ```bash
   git push origin "@yanbobo/gis-sdk@<version>"
   ```

## 5. 验证发布（不需要写权限）

```bash
# ① 内容比对：线上 tarball vs 本地构建
mkdir -p /tmp/verify && cd /tmp/verify && npm pack @yanbobo/gis-sdk@<version> && tar -xzf *.tgz
cd <repo> && npm pack --pack-destination /tmp/verify && tar -xzf /tmp/verify/yanbobo-gis-sdk-*.tgz -C /tmp/verify/local
diff -rq /tmp/verify/package /tmp/verify/local/package      # 期望只有 package.json 不同

# ② 干净消费者冒烟
mkdir -p /tmp/smoke && cd /tmp/smoke && npm init -y
npm i @yanbobo/gis-sdk@<version> cesium@1.144.0 @cesium/engine@26.2.0
node -e "import('@yanbobo/gis-sdk/core').then((m) => console.log(Object.keys(m).length))"
```

**Cesium 版本提醒**：`cesium@1.144.0` 若配到新装的 `@cesium/engine@26.3`，`/cesium` 入口在 Node 与打包器里都会因缺 `_shaders*` 导出直接报错，必须钉 `@cesium/engine@26.2.0`（或让打包器走 Cesium 的 Build 产物）。这条已写进 `docs/guide/getting-started.md` 的「依赖与打包」。

## 6. 端到端验收

```bash
pnpm example:prepare
npm --prefix .tmp/vanilla-consumer run dev -- --host 127.0.0.1 --port 4175
```

浏览器打开 `http://127.0.0.1:4175/`，把面板上的按钮过一遍：图层增删与数据替换、WMS 透明度与过滤、环境效果（晴 / 雾 / 霾 / 雨 / 雪）、两点通视、相机读数、点位与标签（`labelCount`）、按像素聚合、CZML 轨迹、批量分析。

两个已知的本地陷阱：

- **重新 `example:prepare` 之前先停掉 dev server**：压缩包会被就地替换，仍在运行的 Vite 依赖预构建缓存可能把新旧产物混在一起，表现为页面卡在"创建中"；
- **首次加载若停在"创建中"，刷新一次**：Vite 在首次请求时边优化依赖边服务，页面可能拿到未完成的依赖图。

## 7. 事后

- 发布用的临时凭据文件（如 `~/.npm-publish-token`）用完立即删除；
- 若 token 曾在聊天记录、截图或日志里出现过，发完就撤销它，下次需要时重新生成；
- 把本版的关键结论（版本号、dist-tag 状态、验证结果）记进项目记忆或发版说明，供下次对照。
