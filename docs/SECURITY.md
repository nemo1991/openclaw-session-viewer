# 安全策略 (v0.6.0)

## 文件路径 reveal 安全模型

`apiRevealInFinder(path, workspaceRoot, allowRelaxed)` 调 Tauri shell 在 Finder/Explorer 中显示文件/目录。这是个**对外可触发的 IO 操作**,需要安全沙箱。

### 三种调用场景

| 场景                                    | 调用方                                             |   allowRelaxed | 行为                            |
| --------------------------------------- | -------------------------------------------------- | -------------: | ------------------------------- |
| **自动触发** (Read/Edit/Write 工具结果) | `ToolResultCard` / `EditToolBody` / `ReadToolBody` | `false` (默认) | 严格检查 `path_within(p, root)` |
| **用户主动 export 目录**                | `SettingsRoute` (打开默认 export 目录)             |         `true` | `assert_within_any_root` 兜底   |
| **导出后 reveal**                       | `SessionDetailRoute` (导出 md/html 后)             |         `true` | `assert_within_any_root` 兜底   |

### Lock-down 模式 (默认)

```
allowRelaxed = false
  ↓
需要 workspaceRoot (调用方 session 的 workspaceGuess)
  ↓
path_within(target, root) 词法检查
  ↓
  true  → shell reveal
  false → Err "PathSecurity: 路径不在 workspace 内"
```

**保护范围**:目标路径必须严格在 `workspaceRoot` 子树内(词法,不解析 `..` 实际路径)。

**已知限制**:词法检查不解析 `..`,`/a/b/../c` 会被词法误判为 inside `/a/b`。实际防越界靠 Rust `assert_within_any_root` 兜底(走 canonicalize)。

### Relaxed 模式

```
allowRelaxed = true
  ↓
仍执行 assert_within_any_root(state.paths.read(), p)
  ↓
  路径在任一已知 root 下 (default claude/openclaw + custom roots)
  → shell reveal
  不在任何 root 下
  → Err "PathSecurity: 路径不在任一已知 root 下"
```

**保护范围**:仍兜底防 `~/.ssh/id_rsa` 等敏感路径(这些不在 `~/.claude` / `~/.openclaw` / 任何 custom root 下)。

### 用户设置开关

`Settings → 文件路径安全 → 允许 reveal 到任一已知会话主目录`

控制 `AppSettings.pathSecurity.allowRelaxed` 字段:

- `false` (默认) → lock-down
- `true` → relaxed(仍兜底,只是放宽到已知 root)

### 已知攻击面

| 攻击                                   | 现状                                 | 缓解                                                                                          |
| -------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| 工具结果 filePath 注入 `~/.ssh/id_rsa` | 后端 lock-down 检查会拒              | 词法检查 + assert_within_any_root 兜底                                                        |
| `path/../etc/passwd` 词法 bypass       | 已知限制                             | lock-down 模式下,`workspaceRoot` 通常在 `/Users/.../<project>`,外层目录不在 workspace 内 → 拒 |
| 用户主动改设置打开 relaxed             | 显式用户操作                         | 文档化 + 仍受 assert_within_any_root 兜底                                                     |
| Tauri shell 命令注入                   | 路径直接走 `args([..])`,不拼字符串   | 跨平台 spawn 接口,不走 `/bin/sh -c`                                                           |
| F5 后 subagentContext 丢失             | back-to-parent 走 sessionsStore 反查 | `?path=` URL 持久化(无 path 信息泄露,只是 SessionMeta)                                        |

### 升级到 DB 时需重审

引入 redb/rusqlite 后:

- workspace 边界检查应改读 DB 中 `path_security_rules` 表
- 用户可设 per-workspace 规则(例如 "Work 项目: 严格 / Personal: 放松")
- 跨 session 路径聚合查询(找出所有访问过 `~/.ssh` 的 session)

### 报告安全问题

发邮件给 `[SECURITY]`(在 GitHub repo 的 SECURITY.md 联系信息)。
**不要** 在公开 issue 报告安全问题。
