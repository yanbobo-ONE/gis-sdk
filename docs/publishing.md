# npm 发布流程

## 当前状态

- npm registry：`https://registry.npmjs.org/`
- npm 登录账号：`yanbobo`
- 包名：`@yanbobo/gis-sdk`
- 当前版本：`0.1.0-alpha.0`
- 未限定 scope 的 `gis-sdk` 已由 npm 账号 `njueyupeng` 持有，不属于本项目。
- `@yanbobo/gis-sdk` 截至 2026-08-18 尚未发布。

项目 `.npmrc` 只包含非敏感行为配置。不得提交 `_authToken`、密码、OTP 或用户级 npm 配置。

## 发布前检查

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm access list packages
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm docs:build
pnpm pack:check
```

`npm whoami` 必须返回 `yanbobo`。首次发布前应再次确认包不存在，且 dry-run 包名为 `@yanbobo/gis-sdk@0.1.0-alpha.0`。

## 首次发布

发布是人工操作，不在 GitHub Actions 中自动执行：

```bash
npm publish --access public --tag alpha
```

npm 若要求浏览器确认、双因素认证或 OTP，必须由账号持有人本人完成。发布后验证：

```bash
npm view @yanbobo/gis-sdk name version dist-tags --json
```

## 后续版本

alpha 阶段使用 Changesets prerelease 模式。`pre enter alpha` 只在进入该阶段时执行一次；已经存在 `.changeset/pre.json` 时不要重复执行：

```bash
pnpm changeset pre enter alpha
pnpm changeset
pnpm version-packages
pnpm release
npm view @yanbobo/gis-sdk dist-tags --json
```

pre 模式下不要向 `changeset publish` 额外传 `--tag`；`pnpm release` 会读取 `pre.json` 中的 `alpha` tag。

结束 alpha 阶段并发布稳定版时，必须先退出 pre 模式并生成稳定版本：

```bash
pnpm changeset pre exit
pnpm version-packages
git diff
# 审核并提交 package.json、CHANGELOG 和 Changesets 生成的版本变更
pnpm release
```

稳定版发布后再检查 `dist-tags`，确认 `latest` 指向预期版本。任何破坏性公共接口修改必须在 Changelog 中给出迁移说明，不得只修改代码不更新版本记录。
