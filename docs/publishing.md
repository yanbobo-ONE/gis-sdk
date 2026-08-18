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
npm publish --access public
```

npm 若要求浏览器确认、双因素认证或 OTP，必须由账号持有人本人完成。发布后验证：

```bash
npm view @yanbobo/gis-sdk name version dist-tags --json
```

## 后续版本

使用 Changesets 记录影响范围：

```bash
pnpm changeset
pnpm version-packages
pnpm release
```

pre-alpha 阶段新增能力可继续使用 prerelease 版本。任何破坏性公共接口修改必须在 Changelog 中给出迁移说明，不得只修改代码不更新版本记录。
