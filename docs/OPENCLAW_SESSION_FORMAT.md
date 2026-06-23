# OpenClaw 会话文件格式

OpenClaw 在 `~/.openclaw/agents/<agentId>/sessions/` 下为每个 session 写 **3 个文件**。本文档
描述它们的 schema、字段语义、以及与本应用的解析关系。所有内容都从 openclaw 源码
(`/Users/forcetone/workspace/github/openclaw`,版本 `2026.5.14`) 与官方文档
(`openclaw/docs/tools/trajectory.md`) 摘录并交叉验证。

> 如果你更新了 openclaw 看到字段对不上,请先看 [`trajectory/paths.ts`](https://github.com/openclaw/openclaw)
> 和 [`trajectory/types.ts`](https://github.com/openclaw/openclaw) — schema 改动一定先到那里。

---

## 目录布局

```
~/.openclaw/agents/<agentId>/sessions/
├── sessions.json                          ← per-agent 索引(所有 session 的元数据)
├── <sessionId>.jsonl                      ← 主转录(对话内容)
├── <sessionId>.trajectory.jsonl           ← 观测/trace 副产物
└── <sessionId>.trajectory-path.json       ← 指向 trajectory 的指针
```

证据:
- 文件命名规则:`openclaw/src/trajectory/paths.ts:42-64`
  ```ts
  // resolveTrajectoryFilePath
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
  ```
- 指针文件规则:`openclaw/src/trajectory/paths.ts:66-70`
- 目录惯例(官方文档):`openclaw/docs/cli/sessions.md` 第 14-18 行
  > **Transcripts:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

---

## 1. 主转录: `<sessionId>.jsonl`

**逐行 JSON**(JSONL),**第一行是 header**,其余每行是一条 entry。

### 1.1 Header(`type: "session"`)

```json
{
  "type": "session",
  "version": 3,
  "id": "883031bd-0634-4ce1-9756-bc2d9d9b1b3e",
  "timestamp": "2026-06-23T07:24:38.552Z",
  "cwd": "/Users/forcetone/.openclaw/workspace"
}
```

证据:
- 实际文件首行(`head -1 ~/.openclaw/agents/main/sessions/<id>.jsonl`)
- header 由 `openclaw/src/agents/pi-embedded-runner/compaction-successor-transcript.ts:268-280` 的
  `buildSuccessorSessionHeader` 构造,字段完全对应
- 写入时序见 `openclaw/src/agents/pi-embedded-runner/session-manager-init.ts:32`
  (`header = sm.fileEntries.find((e): e is SessionHeaderEntry => e.type === "session")`)

字段含义:

| 字段 | 类型 | 含义 |
|---|---|---|
| `type` | `"session"` | 必填,header marker |
| `version` | `number` | schema 版本(当前观察到 `3`,由 `CURRENT_SESSION_VERSION` 控制) |
| `id` | `string` | session UUID,等于文件名 `<sessionId>` |
| `timestamp` | `string` | ISO 8601,header 写入时刻 |
| `cwd` | `string` | session 起始工作目录 |

### 1.2 Entry 类型

非 header 行都是 `type: <EntryType>` 的 entry,共享 `id` + `parentId` + `timestamp` 三个字段(树形链表):

| `id` | `string` | 8 字符 hex,全文件唯一 |
|---|---|---|
| `parentId` | `string \| null` | 父 entry 的 `id`;根为 `null` |
| `timestamp` | `string` | ISO 8601 |

(以上由 `openclaw/src/agents/pi-embedded-runner/transcript-file-state.ts` 各 `appendXxx` 方法统一写入,
通过 `generateEntryId` 生成 id。)

#### 类型清单(共 10 种)

| `type` | 关键字段 | 用途 | 证据 |
|---|---|---|---|
| `message` | `message: { role, content }` | user/assistant/tool 消息 | `transcript-file-state.ts:139-147` |
| `model_change` | `provider, modelId` | 切换模型 | `transcript-file-state.ts:159-168` |
| `thinking_level_change` | `thinkingLevel` | 切换思考强度 | `transcript-file-state.ts:149-157` |
| `compaction` | `summary, firstKeptEntryId, tokensBefore, details?, fromHook?` | 上下文压缩 | `transcript-file-state.ts:170-188` |
| `custom` | `customType, data?` | 自定义元数据(非用户可见) | `transcript-file-state.ts:190-199` |
| `custom_message` | `customType, content, display, details?` | 自定义消息(可能 UI 渲染) | `transcript-file-state.ts:211-227` |
| `session_info` | `name` | 用户给 session 起的名字(显示在列表) | `transcript-file-state.ts:201-209` |
| `label` | `targetId, label?` | 给某条 entry 打标签 | `transcript-file-state.ts:229-241` |
| `branch_summary` | `fromId, summary, details?` | 分支摘要(用于回退/branch) | `transcript-file-state.ts:243+` |
| (header) `session` | `version, id, timestamp, cwd` | 文件头 | 见 1.1 |

> **类型由外部依赖定义**:`SessionEntry` 类型从 `@earendil-works/pi-coding-agent` 0.74.0 引入
> (`transcript-file-state.ts:6-13`)。本应用不能假设字段集合固定不变 — 见
> [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) "添加新 entry 类型" 一节。

#### 实际样本(来自 `~/.openclaw/agents/main/sessions/883031bd-…jsonl`)

```json
{"type":"session","version":3,"id":"883031bd-…","timestamp":"2026-06-23T07:24:38.552Z","cwd":"/Users/forcetone/.openclaw/workspace"}
{"type":"model_change","id":"49b68cc7","parentId":null,"timestamp":"…","provider":"minimax","modelId":"MiniMax-M3"}
{"type":"thinking_level_change","id":"b40f24ef","parentId":"49b68cc7","timestamp":"…","thinkingLevel":"high"}
{"type":"custom","customType":"model-snapshot","data":{…},"id":"e920a857","parentId":"b40f24ef","timestamp":"…"}
{"type":"message","id":"30d66bf0","parentId":"e920a857","timestamp":"…","message":{"role":"user","content":"…"}}
```

### 1.3 本应用如何解析

| 步骤 | 位置 |
|---|---|
| 列举 session | `src-tauri/src/fs/walker.rs::list_jsonl_files` — 已过滤 `*.trajectory.jsonl` 和 `*.trajectory-path.json` |
| 元数据(标题/时间/大小) | `src-tauri/src/commands/sessions.rs::build_openclaw_session_meta` |
| 记录归一化 | `src-tauri/src/parser/openclaw.rs::normalize_entry` |

未识别的 `type` 会落到 `else` 分支,以 `meta` 块形式渲染(显示 `type` 字符串作为 label)。
新增 entry 类型不需要改本应用 — 只需在 `openclaw.rs` 的 `normalize_entry` 加 match arm。

---

## 2. 观测/trace 副产物: `<sessionId>.trajectory.jsonl`

**这不是用户对话**,而是 openclaw 写的飞行记录仪(per-session flight recorder)。
**应当从会话列表中排除**(本应用已经在 walker 里过滤)。

证据:
- 官方文档 `openclaw/docs/tools/trajectory.md:103-110` 明确 schema 标记:
  ```json
  {
    "traceSchema": "openclaw-trajectory",
    "schemaVersion": 1
  }
  ```
- 写入位置:`paths.ts:42-64` — 与主 session 同目录,后缀 `.trajectory.jsonl`
- 排除理由(本应用决策):见 commit `1656c0c` — 实际案例中 `883031bd.trajectory.jsonl`
  (624KB) 与 `883031bd.jsonl` (36KB) 同目录存在,前者会冒充成第二个 session

### 2.1 事件通用 envelope

```typescript
// openclaw/src/trajectory/types.ts:9-28
type TrajectoryEvent = {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  traceId: string;          // == sessionId
  source: "runtime" | "transcript" | "export";
  type: string;             // 事件类型(见 2.2)
  ts: string;               // ISO 8601
  seq: number;              // 1-based
  sourceSeq?: number;
  sessionId: string;
  sessionKey?: string;      // e.g. "agent:main:main"
  runId?: string;
  workspaceDir?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  entryId?: string;
  parentEntryId?: string | null;
  data?: Record<string, unknown>;
};
```

实际样本(从 `883031bd-…trajectory.jsonl` 抽取):

```json
{
  "traceSchema": "openclaw-trajectory",
  "schemaVersion": 1,
  "traceId": "883031bd-0634-4ce1-9756-bc2d9d9b1b3e",
  "source": "runtime",
  "type": "session.started",
  "ts": "2026-06-23T07:24:38.563Z",
  "seq": 1,
  "sourceSeq": 1,
  "sessionId": "883031bd-0634-4ce1-9756-bc2d9d9b1b3e",
  "sessionKey": "agent:main:main",
  "runId": "a84c3074-5617-431a-a9ba-94512a27a02e",
  "workspaceDir": "/Users/forcetone/.openclaw/workspace",
  "provider": "minimax",
  "modelId": "MiniMax-M3",
  "modelApi": "anthropic-messages",
  "data": { /* 事件特定 payload */ }
}
```

### 2.2 事件类型(8 种,全部带 `data` 字段)

源码枚举来自 `openclaw/docs/tools/trajectory.md:82-91` 与 `pi-embedded-runner/run/attempt.ts` 各调用点:

| `type` | 何时触发 | `data` 关键字段 | 证据 |
|---|---|---|---|
| `session.started` | agent run 启动 | `trigger, sessionFile, workspaceDir, agentId, messageProvider, messageChannel, toolCount, clientToolCount` | `attempt.ts:2170-2179` |
| `trace.metadata` | 紧跟 `session.started` | 完整运行配置(env, model, provider, timeoutMs, fastMode, thinkLevel, reasoningLevel, toolResultFormat, ...) | `attempt.ts:2180+` |
| `context.compiled` | 每次构造发给模型的 prompt | `systemPrompt, prompt, messages, tools` | `attempt.ts:3430-3465` |
| `prompt.skipped` | 早返回(无 tool/无变化) | (具体字段依触发条件) | `attempt.ts:3465+` |
| `prompt.submitted` | 发给模型之前 | `prompt, systemPrompt, messages, imagesCount` | `attempt.ts:3645+` |
| `model.fallback_step` | fallback chain 切换模型 | `source, target, reason, detail, position, advanced?, succeeded?, exhausted?` | `agent-command.ts:1044` |
| `model.completed` | 模型返回 | `aborted, externalAbort, timedOut, idleTimedOut, promptError?, promptErrorSource, ...` | `attempt.ts:4150+` |
| `trace.artifacts` | session 结束前 | 工具/usage/prompt-cache 元数据 | (官方文档列出) |
| `session.ended` | agent run 收尾 | `status` ∈ `success` / `interrupted` / `error` / `cleanup`,`aborted, externalAbort, timedOut, ...` | `attempt.ts:4193+` |

> 另有一个**非用户产生**的事件 `trace.truncated`,在 runtime 触及 10 MiB 容量上限时自动
> 写入,`data: { reason, droppedEvents, droppedEventBytes, limitBytes }` —
> 见 `runtime.ts:347-353` 和 `paths.ts:6-8` 的 `TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024`。

### 2.3 大小/容量限制

| 限制 | 值 | 证据 |
|---|---|---|
| 单事件 `data` object 最多 key 数 | 64 | `runtime.ts:55` |
| `data` 嵌套最大深度 | 6 | `runtime.ts:56` |
| 单事件序列化后最大字节 | 256 KiB | `paths.ts:8` (`TRAJECTORY_RUNTIME_EVENT_MAX_BYTES`) |
| 单文件总字节上限 | 50 MiB | `paths.ts:7` |
| Live capture 软上限 | 10 MiB(超过则停止 capture 但保留文件) | `paths.ts:6` |
| 单次 export 接受上限 | 50 MiB | 官方文档 `trajectory.md:198` |
| 单 session 文件 export 上限 | 50 MiB | 官方文档 `trajectory.md:199` |

> **环境变量关停**:`export OPENCLAW_TRAJECTORY=0` 完全关闭 capture
> (`trajectory.md:159-169`)。本应用在这种模式下不会找到 `.trajectory.jsonl` — 仅看到主
> `<sessionId>.jsonl`,行为不受影响。

---

## 3. 指针文件: `<sessionId>.trajectory-path.json`

```json
{
  "traceSchema": "openclaw-trajectory-pointer",
  "schemaVersion": 1,
  "sessionId": "883031bd-0634-4ce1-9756-bc2d9d9b1b3e",
  "runtimeFile": "/Users/forcetone/.openclaw/agents/main/sessions/883031bd-0634-4ce1-9756-bc2d9d9b1b3e.trajectory.jsonl"
}
```

证据:
- 实际文件 (`cat ~/.openclaw/agents/main/sessions/<id>.trajectory-path.json`)
- 写入逻辑:`openclaw/src/trajectory/runtime.ts:58-103` 的 `writeTrajectoryPointerBestEffort`
  - 用 `O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW` 打开(防 symlink 攻击)
  - `chmod 0o600` 权限
  - 写入失败仅 best-effort,不影响主功能
- 读取校验:`openclaw/src/trajectory/cleanup.ts:51-76` 的 `readTrajectoryPointerFile`
  - 校验 `traceSchema === "openclaw-trajectory-pointer"` 且 `schemaVersion === 1` 且 `sessionId` 匹配

用途:
- 当 `OPENCLAW_TRAJECTORY_DIR` 指向**非默认目录**时,trajectory 文件被分散到那个目录里;
  此时主 session 旁的 `.trajectory-path.json` 记录了 trajectory 真实路径(可以是绝对路径)
- 路径证据:`paths.ts:48-53` — `dirOverride` 存在时返回 `${dir}/${sessionId}.jsonl`

本应用**不需要**读这个文件 — 我们只关心主 session,trajectory 一律排除。但如果以后要做
"跳转 trajectory" 功能,这是入口。

---

## 4. per-agent 索引: `sessions.json`

不是每个 session 单独一个文件,openclaw 还在同一目录下维护一个聚合索引。

```json
{
  "agent:main:main": {
    "sessionId": "883031bd-…",
    "updatedAt": 1719132878552,
    "sessionStartedAt": 1719132878552,
    "sessionFile": "/Users/forcetone/.openclaw/agents/main/sessions/883031bd-….jsonl",
    "lastInteractionAt": 1719132900000,
    "contextTokens": 12345,
    "modelProvider": "minimax",
    "model": "MiniMax-M3",
    "inputTokens": 1234,
    "outputTokens": 567,
    "cacheRead": 100,
    "cacheWrite": 50,
    "estimatedCostUsd": 0.0023
    // … 20+ 字段
  },
  "agent:main:feishu:direct:ou_xxx": { … }
}
```

证据:
- 实际文件 (`cat ~/.openclaw/agents/main/sessions/sessions.json`)
- 完整 schema:`openclaw/src/config/sessions/types.ts:174-…` 的 `SessionEntry`
  (注意:这个 `SessionEntry` 是**索引**用的,**不是**转录文件里的 entry)
- 文档来源:`openclaw/docs/cli/sessions.md:14-18` 列出顶层 keys

> **本应用目前不读 `sessions.json`**:我们的 `list_jsonl_files` 直接扫描目录。
> 改用 `sessions.json` 可以加速大目录(避免 `stat` 每个 jsonl),但需要解析
> `sessionKey` → `agentId` 的反向映射。当 N > 1000 sessions 时值得优化。

---

## 5. 三类文件决策矩阵(本应用视角)

| 文件 | 列表展示 | 详情页渲染 | 搜索 | 备注 |
|---|---|---|---|---|
| `<id>.jsonl` | ✅ 主 session | ✅ | ✅ | 走 `openclaw.rs::normalize_entry` |
| `<id>.trajectory.jsonl` | ❌ 过滤 | — | — | `walker.rs` 按 `file_stem` 末缀排除 |
| `<id>.trajectory-path.json` | ❌ 过滤 | — | — | `extension == "json"`,本就不进 jsonl 列表 |
| `sessions.json` | (暂未读) | — | — | 优化候选 |

---

## 6. 故障排除

### 6.1 列表里出现"重复"的 session

如果 walker 过滤失效,某个 session 会出现两次(一次 36KB 是主,一次 624KB 是 trajectory)。
检查 `src-tauri/src/fs/walker.rs::list_jsonl_files` 的 `file_stem().ends_with(".trajectory")` 分支。

### 6.2 解析报 `unknown type "session.xxx"`

`openclaw.rs::normalize_entry` 没匹配。参考 `transcript-file-state.ts` 的 `appendXxx` 方法
找新增的 entry 类型,在 `normalize_entry` 加 match arm。

### 6.3 找不到任何 session

- 确认 `~/.openclaw/agents/` 存在且非空
- 确认 `OPENCLAW_TRAJECTORY=0` 没有误设 — 但即使关了 trajectory,主 session 仍可读
- 看应用 `log/info!` 输出 `list_sessions: 返回 N 个会话`

---

## 7. 参考资料

| 文档 | 用途 |
|---|---|
| `openclaw/docs/tools/trajectory.md` | 官方 trajectory 文档(229 行) |
| `openclaw/docs/cli/sessions.md` | CLI sessions 命令 + 路径约定 |
| `openclaw/docs/concepts/session.md` | session 路由/隔离/lifecycle |
| `openclaw/src/trajectory/paths.ts` | 文件名解析(70 行) |
| `openclaw/src/trajectory/types.ts` | `TrajectoryEvent` / `TrajectoryBundleManifest` 类型 |
| `openclaw/src/trajectory/runtime.ts` | 事件 envelope 构造 + 指针文件写入 |
| `openclaw/src/trajectory/cleanup.ts` | 指针文件读取校验 |
| `openclaw/src/agents/pi-embedded-runner/transcript-file-state.ts` | 10 种 entry 的 appendXxx 构造方法 |
| `openclaw/src/agents/pi-embedded-runner/compaction-successor-transcript.ts:268-280` | session header 构造 |
| `openclaw/src/config/sessions/types.ts:174-…` | `sessions.json` 索引 schema |

openclaw 仓库路径(本地):`/Users/forcetone/workspace/github/openclaw` (版本 `2026.5.14`)
外部依赖:`@earendil-works/pi-coding-agent@0.74.0`(`SessionEntry` 类型来源)
