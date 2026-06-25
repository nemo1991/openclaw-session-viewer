# 发布指南

维护者发版的标准流程。

## Pre-release checklist

发版前确认:

- [ ] 所有合并的 PR 都已写进 `CHANGELOG.md` 的 `## [Unreleased]` 段
- [ ] 本地完整验证通过:

  ```bash
  pnpm install
  pnpm -r test
  pnpm typecheck
  (cd src-tauri && cargo test --lib && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings)
  pnpm --filter @ocsv/frontend build
  ```

- [ ] CI 在 `main` 上全绿
- [ ] release commit **不带** `[skip ci]` 标记(否则 tag 触发的 Release workflow 也会被跳过)
- [ ] docs-only 改动用 paths-ignore(`.github/workflows/ci.yml` 已配置 `*.md` 和 `docs/**`),**不要**用 `[skip ci]` commit message

## 发版步骤

### 1. 改 CHANGELOG.md

把 `## [Unreleased]` 改名为 `## [X.Y.Z] - YYYY-MM-DD`,并新开一个空 `## [Unreleased]`。

例如:

```diff
- ## [Unreleased]
-
- ### 计划
- - ...
+ ## [Unreleased]
+
+ ## [0.2.0] - 2026-06-23
+
+ ### 新增
+ - ...
```

### 2. 提交并打 tag

```bash
git add CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

> **不要** 手动改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`
> 中的 `version` 字段。Release workflow 会在 CI 容器内临时注入版本,避免
> `main` 分支与 tag 分支之间漂移。

### 3. 等 CI

在 GitHub **Actions** 页面看 `Release` workflow。三平台并行构建,大约 10–20 分钟。

构建产物:

| 平台    | 资产                                                         |
| ------- | ------------------------------------------------------------ |
| macOS   | `OpenClaw Session Viewer_X.Y.Z_aarch64.dmg`                  |
| Linux   | `OpenClaw Session Viewer_X.Y.Z_amd64.AppImage` / `.deb`      |
| Windows | `OpenClaw Session Viewer_X.Y.Z_x64_en-US.msi` / `-setup.exe` |
| 校验    | `SHA256SUMS.txt`                                             |

> **为什么不是中文名?**: Tauri bundler 在 Windows MSI 阶段用 WiX 3.x 的 `light.exe`,
> 它对非 ASCII 文件名支持差([issue #8363](https://github.com/tauri-apps/tauri/issues/8363))。
> 解决方案是 `productName` 用 ASCII。**窗口标题仍然是中文**(`app.windows[].title`),
> 仅 bundler 输出的文件名是英文。

### 4. Review draft release

CI 完成后,GitHub **Releases** 页面会多出一个 **draft**(未公开)。
Release body 自动从 `CHANGELOG.md` 的 `## [X.Y.Z]` 段抓取。

确认:

- [ ] 状态是 **Draft**
- [ ] 6 个资产齐全(`.dmg` / `.AppImage` / `.deb` / `.msi` / `-setup.exe` / `SHA256SUMS.txt`)
- [ ] **没有** `.app` 目录作为资产(它只上传作 workflow artifact,本地调试用)
- [ ] Bundle 文件名包含新版本号(证明版本注入生效)
- [ ] `SHA256SUMS.txt` 与下载的 5 个二进制对应

### 5. Publish

在 Releases 页面 review 通过后,点 **"Publish release"**。

发布后再做:

- [ ] 下载任一资产 + `sha256sum -c SHA256SUMS.txt` 验证校验和
- [ ] 删掉 workflow artifact(只保留 release 资产)

## 故障恢复

| 状况                                            | 恢复                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| CI 失败但 tag 已推                              | `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`,修复后重打                  |
| Draft 已创建但不想要                            | Releases 页面 → 该 release → **Delete**                                              |
| Draft 没附上正确 body                           | Releases 页面 → **Edit** → 手动粘 CHANGELOG 段                                       |
| 想重跑同 tag release                            | Actions 页面 → Release workflow → **Run workflow**(填同样的 tag)                     |
| Windows runner 缺 Python 3                      | 理论上预装,缺失时改 PowerShell `ConvertFrom-Json` 注入                               |
| **release commit 带 `[skip ci]` 跳过 workflow** | 改用 `gh workflow run Release --ref vX.Y.Z` 手动触发;或 `--amend` 改 commit message  |
| **hotfix 流程**                                 | 从 `vX.Y.Z` tag 拉 `hotfix/vX.Y.Z+1` 分支 → 修复 → PR → 合并后打 `vX.Y.Z+1` tag → CI |
| **CI workflow 文件改动导致 release 失败**       | 本地 lint: `brew install actionlint && actionlint .github/workflows/`                |

### Hotfix 示例

```bash
# 当前 v0.3.1 有个严重 bug,需要立即发 v0.3.2
git fetch --tags
git checkout -b hotfix/v0.3.2 v0.3.1
# 改代码
git commit -am "fix(parser): ..."
git push origin hotfix/v0.3.2
# 提 PR → 合 main → 打 tag
git checkout main
git tag v0.3.2
git push origin main --tags
```

## 版本号约定

遵循 [Semantic Versioning](https://semver.org/):

- **MAJOR**:不兼容的 API 变更
- **MINOR**:向后兼容的新功能
- **PATCH**:向后兼容的 bug 修复

预发布版本用 `-rc.N` / `-beta.N` 后缀(如 `v0.2.0-rc.1`),GitHub
会标记为 **Pre-release**,不会出现在 Latest 频道。
