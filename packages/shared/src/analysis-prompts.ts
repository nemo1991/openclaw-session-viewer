/**
 * 4 个预置的大模型分析模板
 *
 * 占位符:
 *   {{context}} — 归一化后的会话转录(由 Rust 端 context.rs 生成)
 */

export interface AnalysisPromptTemplate {
  key: "summary" | "code-changes" | "errors" | "custom";
  label: string;
  description: string;
  /** 若非 custom,则提供默认 prompt */
  defaultPrompt?: string;
  /** 是否需要流式响应(所有都流式) */
  streamable: true;
}

export const ANALYSIS_TEMPLATES: AnalysisPromptTemplate[] = [
  {
    key: "summary",
    label: "会话摘要",
    description: "提取任务目标、关键决策、完成情况、遗留问题",
    defaultPrompt: `你是一个资深的会议记录员。请阅读以下 Claude Code / OpenClaw 会话转录,输出结构化总结(用中文):

## 任务目标
(1–2 句话概述用户想做什么)

## 关键决策
(列出 Agent 做出的重要技术选择,引用具体的工具调用作为证据)

## 完成情况
- ✅ 已完成: ...
- ⏳ 进行中: ...
- ❌ 未完成: ...

## 遗留问题
(任何没解决的事情、用户没确认的假设、潜在风险)

要求:
- 客观、简练,不超过 600 字
- 引用具体工具名 (Read/Edit/Bash 等) 和文件路径
- 如果会话不完整,指出"中途结束"

以下是会话转录:
---
{{context}}`,
    streamable: true,
  },
  {
    key: "code-changes",
    label: "提取代码修改",
    description: "列出所有修改/新增/删除的文件,带目的说明",
    defaultPrompt: `请从以下 Claude Code / OpenClaw 会话中提取所有文件级别的修改,按以下结构输出(中文):

| 文件路径 | 修改类型 | 目的 | 关键 diff 摘要 |
|---|---|---|---|

规则:
- 只列实际修改(Edit/Write/NotebookEdit 工具调用),忽略 Read/Bash/Grep/Glob
- 修改类型: 新增 / 修改 / 删除
- "目的" 是用户为什么改这个文件(1 句话)
- "关键 diff 摘要" 列出 1–3 个核心变更点(用 \`-\` / \`+\` 形式)
- 如果没有修改任何文件,明确说"无文件修改"
- 按时间顺序排序

以下是会话转录:
---
{{context}}`,
    streamable: true,
  },
  {
    key: "errors",
    label: "错误与陷阱分析",
    description: "分析工具失败、重复尝试、隐含假设错误",
    defaultPrompt: `请审查以下 Claude Code / OpenClaw 会话中的错误和潜在陷阱(用中文输出):

## 1. 工具调用失败
(退出码 ≠ 0、或 is_error=true 的工具调用,引用具体工具名和报错片段)

## 2. 重复尝试
(同类操作重复 ≥ 2 次仍失败的情况,分析为什么没换策略)

## 3. 隐含假设错误
(Agent 做了错误假设但被用户纠正的地方,或者用户主动指出"不是这样")

## 4. 资源浪费
(读了整个大文件、跑了无意义的命令、做了不必要的搜索等)

## 5. 下次改进建议
(3–5 条具体可操作的建议,例如"先 Read 文件再 Edit"、"用 Glob 替代多轮 find")

要求:
- 引用具体的工具名称和报错片段
- 区分"Agent 的问题"和"用户输入不清导致的问题"
- 总结 ≤ 500 字

以下是会话转录:
---
{{context}}`,
    streamable: true,
  },
  {
    key: "custom",
    label: "自定义 Prompt",
    description: "输入你自己的 prompt,作用于选定的会话范围",
    streamable: true,
  },
];

export function getTemplateByKey(key: string): AnalysisPromptTemplate | undefined {
  return ANALYSIS_TEMPLATES.find((t) => t.key === key);
}
