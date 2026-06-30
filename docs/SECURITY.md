# 安全策略 (v0.6.x)

> **v0.6.0 引入**:文件路径 `reveal_in_finder` 工作流的安全模型。
>
> **v0.6.1 扩展**:完整 UX 闭环 — 失败行内三按钮 + 一键开启 (`allowRelaxed`) + 设置页锁。

---

## TL;DR

| 问题                                                  | 答案                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 谁能调 `reveal_in_finder`?                            | 所有 `Read` / `Edit` / `Write` 工具结果 / `.plan` 文件 / tracked file snapshot 的 `reveal` 按钮;用户**主动**点 "打开" 目录按钮 |
| 默认安全模型?                                         | **Lock-down**:目标路径必须严格在 `workspaceRoot` (本次会话 `workspaceGuess`) 子树内,**词法**检查                               |
| 我可以放开吗?                                         | `Settings → 文件路径安全 → 允许 reveal 到任一已知会话主目录` (默认关闭) — 仍受 `assert_within_any_root` 兜底                   |
| 失败怎么办?                                           | 行内 `⚠ 路径不在 workspace 内` + 「复制路径」/ 「去设置」/ 「一键开启允许越界」三按钮                                          |
| 我想 reveal `~/.claude/plans/...md` 又不想放开全局锁? | Settings 页面有「选择 `~/.claude` 作为默认导出目录」按钮 — 不放松安全,但放宽 root 到 `~/.claude/` 整目录                       |

---

## 威胁模型

### 攻击面

```
用户输入 → 不可信
   ├─ search 框输入 (字符串)
   ├─ JSONL 文件名 (本地 read)
   └─ 工具结果 filePath (来自大模型产出,可被 prompt injection)
```

**关注**:JSONL 文件名是本地可控的,真正不可信的是工具结果中的 `filePath` 字段 — 大模型可能产生指向 `~/.ssh/id_rsa` 的路径,UI 点击后调 `reveal_in_finder` 把敏感目录"暴露"在 Finder/Explorer 中(对其他应用可见)。

### 我们防什么 / 不防什么

| 攻击                                   |      防?       | 怎么防                                                                                                          |
| -------------------------------------- | :------------: | --------------------------------------------------------------------------------------------------------------- |
| 工具结果 filePath 指向 `~/.ssh/id_rsa` |       ✅       | `assert_within_any_root` 兜底 → 返回 `Err PathSecurity`                                                         |
| 词法 bypass `path/../etc/passwd`       |       ⚠️       | 已知限制;lock-down 模式下 `workspaceRoot` 通常在 `/Users/.../<project>`,`..` 倒回父目录会落在 workspace 外 → 拒 |
| Tauri shell 命令注入                   |       ✅       | 路径直接走 `args([..])`,不拼字符串;跨平台 spawn,不走 `/bin/sh -c`                                               |
| 用户主动改设置打开 relaxed             | ✅(白名单方式) | 显式用户操作 + 文档化 + 仍受 `assert_within_any_root` 兜底                                                      |
| 浏览器跨域脚本调 reveal                |       ✅       | Tauri IPC 边界隔离,JS 沙箱不可触达                                                                              |
| 文件被改 / 删 / 写                     |    ✅(无关)    | 无任何 fs 写命令,只能 read metadata + shell reveal                                                              |

---

## 三种调用场景

| 场景                                         | 调用方                                                            | `allowRelaxed` | 行为                                                              |
| -------------------------------------------- | ----------------------------------------------------------------- | :------------: | ----------------------------------------------------------------- |
| **自动触发** (Read/Edit/Write 工具结果)      | `ToolResultCard` / `EditToolBody` / `ReadToolBody`                | `false` (默认) | 严格 `path_within(p, root)`                                       |
| **meta 块文件** (`.plan` / tracked snapshot) | `MetaBlock` :: `FilePathClickable` / `PlanFilePath`               | `false` (默认) | 同上;透传 `parentJsonlPath` 让 `useFileReveal` 推 `workspaceRoot` |
| **用户主动 export 目录**                     | `SettingsRoute` 「打开」按钮 / `SessionDetailRoute` 导出后 reveal |     `true`     | `assert_within_any_root` 兜底                                     |

### Workspace Root 推导优先级

`useFileReveal` 内部:

```
opts.workspaceRoot           (显式)
  > settings.defaultExportDir (用户设置)
  > deriveWorkspaceRootFromSession(sessionJsonlPath)
      = parent dir of jsonl
      例如 /Users/foo/.claude/projects/<encoded>/<uuid>.jsonl
        → /Users/foo/.claude/projects/<encoded>/
  > null → 锁死失败
```

---

## Lock-down 模式 (默认)

```
allowRelaxed = false
  ↓
需要 workspaceRoot (上面优先级链)
  ↓
path_within(target, root) 词法检查
  ↓
  true  → shell reveal
  false → Err "PathSecurity: 路径不在 workspace 内"
  null  → Err "PathSecurity: 需提供 workspace_root (lock-down 模式)"
```

**保护范围**:目标路径必须严格在 `workspaceRoot` 子树内(词法,不解析 `..` 实际路径)。

**已知限制**:词法检查不解析 `..`,`/a/b/../c` 会被词法误判为 inside `/a/b`。实际防越界靠 Rust `assert_within_any_root` 走 canonicalize 兜底(仅 `allowRelaxed=true` 时触发)。

### 已知 Edge Case: `~/.claude/plans/*.md`

`.plan` 文件 (计划模式产物 / 用户自定义 prompts) 在 `~/.claude/plans/`,但 `workspaceRoot` 默认推导自 `~/.claude/projects/<encoded-cwd>/`,所以默认 lock-down **会拒**。

**两种解决方案** (都不破坏安全):

1. **放宽 defaultExportDir** (推荐):Settings → 默认导出目录 → 选 `~/.claude/`,使 `path_within` 在 `~/.claude/` 子树下全 accept
2. **临时开关** relaxed (一次性):meta 块「一键开启允许越界」按钮(确认弹窗后生效)

设置页还有第三选项:**「选择 `~/.claude` 作为默认导出目录」按钮** — 跟方案 1 相同操作但 UX 更直接。

---

## Relaxed 模式

```
allowRelaxed = true
  ↓
仍执行 assert_within_any_root(state.paths.read(), p)
  ↓
  路径在任一已知 root 下 (default + customRoots)
  → shell reveal
  不在任何 root 下
  → Err "PathSecurity: 路径不在任一已知 root 下"
```

**保护范围**:仍兜底防 `~/.ssh/id_rsa` 等敏感路径 — 这些不在 `~/.claude` / `~/.openclaw` / 任何 custom root 下。

**已知 root 列表**:

- `~/.claude/` (默认)
- `~/.openclaw/` (默认)
- `settings.customRoots[]` (用户加)

### 一键开启 UX 流程 (MetaBlock::RevealErrorActions)

```
行内三按钮 (用户报 'reveal 无效')
  ├─ [复制路径]           → navigator.clipboard.writeText(path)
  ├─ [去设置]             → navigate('/settings')
  └─ [一键开启允许越界]   → confirm()
        弹窗告诉用户「会让任意已知 root 下文件 reveal, 仍防 ~/.ssh」
        用户确认 →
          updateSettings({ pathSecurity: { allowRelaxed: true },
                           defaultExportDir: <推断的 ~/.claude>/path.to.claude })
          saveSettings(...)
          revealAndNotify(path) 重试
```

推断逻辑:

```ts
const claudeMatch = path.match(/^(.*?\.claude)(\/|$)/);
if (claudeMatch) inferredExportDir = claudeMatch[1];
// 例如 '/Users/x/.claude/plans/y.md' → '/Users/x/.claude'
```

---

## 跨平台 Shell 命令

| 平台    | 命令                      | 备注                                 |
| ------- | ------------------------- | ------------------------------------ |
| macOS   | `open -R <path>`          | `R` flag 是在 Finder reveal 而非打开 |
| Windows | `explorer /select,<path>` | 反斜杠变 `,`                         |
| Linux   | `xdg-open <dir>`          | 仅打开目录,非文件(无 `reveal` 概念)  |

路径直接走 `Command::new(...).args([..])`,Tauri shell plugin 内部转义,**不走 shell**。

---

## 升级到 DB 时需重审

引入 redb/rusqlite 后:

- workspace 边界检查应改读 DB 中 `path_security_rules` 表
- 用户可设 per-workspace 规则(例如 "Work 项目: 严格 / Personal: 放松")
- 跨 session 路径聚合查询(找出所有访问过 `~/.ssh` 的 session)

---

## 报告安全问题

发邮件给仓库的 SECURITY 邮箱(看 GitHub 仓库设置)。
**不要** 在公开 issue 报告安全问题。
