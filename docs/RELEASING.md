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

| 平台    | 资产                                                     |
| ------- | -------------------------------------------------------- |
| macOS   | `OpenClaw 会话查看器_X.Y.Z_aarch64.dmg`                  |
| Linux   | `OpenClaw 会话查看器_X.Y.Z_amd64.AppImage` / `.deb`      |
| Windows | `OpenClaw 会话查看器_X.Y.Z_x64_en-US.msi` / `-setup.exe` |
| 校验    | `SHA256SUMS.txt`                                         |

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

| 状况                       | 恢复                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| CI 失败但 tag 已推         | `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`,修复后重打 |
| Draft 已创建但不想要       | Releases 页面 → 该 release → **Delete**                             |
| Draft 没附上正确 body      | Releases 页面 → **Edit** → 手动粘 CHANGELOG 段                      |
| 想重跑同 tag release       | Actions 页面 → Release workflow → **Run workflow**(填同样的 tag)    |
| Windows runner 缺 Python 3 | 理论上预装,缺失时改 PowerShell `ConvertFrom-Json` 注入              |

## 版本号约定

遵循 [Semantic Versioning](https://semver.org/):

- **MAJOR**:不兼容的 API 变更
- **MINOR**:向后兼容的新功能
- **PATCH**:向后兼容的 bug 修复

预发布版本用 `-rc.N` / `-beta.N` 后缀(如 `v0.2.0-rc.1`),GitHub
会标记为 **Pre-release**,不会出现在 Latest 频道。
