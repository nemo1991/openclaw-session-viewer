# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.9.30] - 2026-08-21

- 隐私: `fixtures/` 目录(含真实会话样本)从 git 历史彻底清除,`.gitignore` 整目录忽略。
- CI: 修 10 个 clippy lint denials(clippy 1.97 收紧默认),Lint & Format job 转绿。

## [0.9.29] - 2026-08-20

- M11.1 补丁: `first_prompt` 持久化、`tool_use_count` 改走 aggregator、启动 sync 显式触发。
- M11.2-5 dsh 修复: optimistic pill、banner 聚合、noise filter、sandbox/approval 路由。
- 隐私: 移除 fixture 驱动的测试、用户路径脱敏为占位符、文档路径清理。

## [0.9.28] - 2026-08-19

- **M11 — DeepSeek Harness (dsh) 第 4 种 wire-format source**: 接入 `~/.dsh/sessions/`。
- `.jsonl.zstd` 透明 reader(`jsonl_zst.rs` + 按扩展名派发的 `*_auto` 包装)。
- `--…--` bracket 包裹解码:project_key 以 `dsh:<dir-name>` 不透明存储。
- `SessionSource` 扩为 4 元 union,DB CHECK 加 `'dsh'`;per-event envelope normalize(无 state machine)。
- UI: filter chip / source badge "DeepSeek Harness" / graph label。

## 0.9.0 → 0.9.27(逐版压缩)

- **0.9.27** — M10: meta 聚合 Pass 2→Pass 1 single-pass cutover。
- **0.9.26** — M9: Pass 1↔Pass 2 并行跑验证 3 个 kimi 字段。
- **0.9.25** — snake/camel 兼容第二阶段撤除。
- **0.9.24** — 从 SessionDetailRoute 抽 SessionHeader + SessionNotesPanel + useSessionActions。
- **0.9.23** — 6 个 chart blocks 抽到独立 ChartsRegion + 后端 StreamBatch 加 `charts` 字段。
- **0.9.22** — 抽 L1 SessionOverview + SessionSummaryStrip 空数据 3 重 guard。
- **0.9.21** — 集中 meta 工具、MetaBlock→MetaBlockRouter 改名、ADR 落地。
- **0.9.20** — MetaBlock 拆 4-way router + AttachmentBlock + EventMetaBlock。
- **0.9.19** — 抽 6 个 chart 子组件 + ChartBlock dispatcher。
- **0.9.18** — 13 种 attachment kind 统一 slate + accent 配色集中化。
- **0.9.17** — claude: ai-title / custom-title 聚合 chart。
- **0.9.16** — kimi: tools.update_store → todo chart(57 events 聚合为 1 chart)。
- **0.9.15** — kimi: llm.request 上下文 headroom + config drift chart。
- **0.9.14** — kimi: usage.record per-turn token chart。
- **0.9.13** — kimi: llm.tools_snapshot 会话工具配置。
- **0.9.12** — kimi: context.apply_compaction 摘要 + 压缩统计。
- **0.9.11** — kimi: plan_mode.exit 视为用户可观测的 plan 退出。
- **0.9.10** — kimi: subagent 发现 + 4 个缺失 event type。
- **0.9.9** — kimi: unwrap context.append_loop_event envelope + content.part thinking parser 修复。
- **0.9.8** — kimi: 真实样本驱动 3 聚合(todo/token/banner)+ transcript collapse。
- **0.9.7** — kimi: 真实样本回归 4 闭合 + 2 bug fix。
- **0.9.6** — thinking_count 跨 source 全填。
- **0.9.5** — kimi MetaExtras 5 字段跨 source 对齐。
- **0.9.4** — kimi 跨 session 工具聚合。
- **0.9.3** — kimi 聚合 usage.record → SessionMeta.total_tokens。
- **0.9.2** — e2e 改 HashRouter + `?path=` 修复 18 个历史 spec。
- **0.9.1** — kimi 默认 home 改 `~/.kimi-code`。
- **0.9.0** — **Kimi Code 第 3 种 source**: wire.jsonl 解析 + 状态机 + 子代理。

## 0.8.0 → 0.8.15(逐版压缩)

- **0.8.15** — keymap 跨平台化 + 撤 6 个 band-aid。
- **0.8.14** — 后端安全收紧 + 流式契约修复(9 项)。
- **0.8.13** — Data integrity 收口。
- **0.8.12** — Critical bug 收口(4 真 bug + 2 test gap + 1 UX)。
- **0.8.11** — 详情页 reload 按钮 + Cmd+R/Ctrl+R。
- **0.8.10** — Defense in depth(2 真 bug + 3 hardening + 2 test gap)。
- **0.8.9** — 收口 db/sync + analytics test gap + add_session_link ON CONFLICT 修复。
- **0.8.8** — 修 v0.8.5 起的 3 个 graph bug。
- **0.8.7** — GraphView CrossSession + ParentUuid edges + 读写连接分离。
- **0.8.6** — GraphView edges + export 隐私 + sync_state last_error。
- **0.8.5** — per-tool 失败维度 + 跨 session 工具聚合 + /tools 路由 + G1/G2 切 DB。
- **0.8.4** — session_meta 扩 19 列 + HomeStatusBar + 6 meta handler + Transcript 性能。
- **0.8.3** — refresh storm 修复 + String(e) + LEFT JOIN NULL。
- **0.8.2** — 3 个 hotfix(NOT NULL / orphan sweep failsafe / unused import)。
- **0.8.1** — 5 个 review 后修(排序 / rename / 孤儿清理 / tx / apply_bool mode)。
- **0.8.0** — **嵌入式 SQLite session DB**:rename/hide/pin/archive/notes/tags/links 覆盖 + 搜索历史。

## 早期版本(< 0.8,按阶段压缩)

- **v0.7.x** — 会话详情内容维度筛选(role/属性)+ 聚合去噪 + React 18→19 升级 + vitest 覆盖率 + Playwright E2E;修复 transcript 虚拟化性能回归。
- **v0.6.x** — Claude 会话关联信息优雅展示:subagentId 归一、Agent 卡片内嵌子代理摘要、文件路径点击 reveal、meta 块显示优化。
- **v0.5.x** — 主-子 agent 关联:SubagentPanel、tool_use 卡片、子会话跳转。
- **v0.4.x** — app icon + 平台尺寸;timezone 设置;会话内搜索 + diff 高亮;OpenClaw trajectory view;3 个新 meta handler。
- **v0.3.x** — parser 重构为 BlockRegistry + handler 拆分,消灭未知 block 崩溃;排序切换。
- **v0.2.x** — 自定义数据源 roots + hot reload;multi-agent UI 分组;Windows `[object Object]` 安全加固;CI 跨平台产物 + SHA256SUMS。
- **v0.1.0** — 初始版:Tauri 2 + React + Rust 桌面应用,浏览本地 Claude Code / OpenClaw 会话 JSONL。
