# Domain Docs(领域文档)

工程 skill 在探索代码库时,如何消费本仓库的领域文档。

## 探索前先读这些

- **`CONTEXT-MAP.md`** 在仓库根目录 — 指向每个 context 一个 `CONTEXT.md`。根据主题读相关的那些。
- **`CONTEXT.md`** 在仓库根目录,用于系统范围的词汇和决策。
- **`docs/adr/`** — 读与你即将工作的区域相关的 ADR。在 multi-context 仓库里,还要看 `src/<context>/docs/adr/` 看 context 内的决策。

如果这些文件不存在,**默默继续**。不要提示缺失;不要主动建议<redacted>。`/domain-modeling` skill(经由 `/grill-with-docs` 和 `/improve-codebase-architecture`)会在术语或决策真正落地时 lazy <redacted>。

## 文件结构

本仓库是 **multi-context**(pnpm workspace,含 `packages/*` + `src-tauri/`):

```
/
├── CONTEXT-MAP.md                         ← 系统级 map → 各 context 的 CONTEXT.md
├── docs/adr/                              ← 系统级决策
├── packages/
│   ├── frontend/
│   │   ├── CONTEXT.md                     ← React + Zustand + UI 渲染
│   │   └── docs/adr/                      ← frontend 特定的决策
│   └── shared/
│       ├── CONTEXT.md                     ← 跨 package 类型 + Zod schema
│       └── docs/adr/                      ← shared 特定的决策
└── src-tauri/
    ├── CONTEXT.md                         ← Rust + Tauri commands + parsers
    └── docs/adr/                          ← 后端特定的决策
```

## 使用 glossary 的词汇

当你的输出命名一个领域概念(issue 标题、重构提案、假设、测试名)时,用相关 `CONTEXT.md` 里的术语。不要漂移到 glossary 明确避免的同义词。

如果你需要的概念 glossary 里还没有,这是个信号 — 要么你在发明项目不用的语言(重新考虑),要么真有个缺口(记录给 `/domain-modeling`)。

## 标出 ADR 冲突

如果你的输出跟现有 ADR 矛盾,显式指出而不是默默覆盖:

> _与 ADR-0007(event-sourced orders)矛盾 — 但值得重开,因为…_
