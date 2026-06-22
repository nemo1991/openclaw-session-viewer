//! 大模型分析命令 — 调用 Anthropic 兼容 API

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::llm::anthropic::{stream_anthropic, AnthropicRequest};
use crate::llm::context::build_context;
use crate::parser::claude::normalize;
use crate::parser::jsonl;
use crate::parser::openclaw::normalize_entry;
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeArgs {
    pub path: String,
    pub template: String,
    pub custom_prompt: Option<String>,
    pub range: AnalyzeRange,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRange {
    pub from_index: Option<u32>,
    pub to_index: Option<u32>,
    pub only_user: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AnalyzeEvent {
    Delta {
        text: String,
    },
    Done {
        total_input_tokens: Option<u32>,
        total_output_tokens: Option<u32>,
    },
    Error {
        message: String,
    },
}

/// 开始分析
#[tauri::command]
pub async fn analyze_session(args: AnalyzeArgs, app: AppHandle) -> AppResult<()> {
    if args.api_key.is_empty() {
        return Err(AppError::Config("请先在设置页填入 API Key".into()));
    }
    let path = Path::new(&args.path);
    if !path.exists() {
        return Err(AppError::NotFound(args.path));
    }
    let is_openclaw = args.path.contains(".openclaw");

    // 1) 解析整个文件
    let mut entries = Vec::new();
    jsonl::for_each_line(path, |idx, _, v| {
        let norm = if is_openclaw {
            normalize_entry(v, idx)
        } else {
            normalize(v, idx)
        };
        if let Some(n) = norm {
            entries.push(n);
        }
    })?;

    // 2) 构造上下文
    let context = build_context(&entries, &args.range);

    // 3) 拼装 system prompt
    let system = match args.template.as_str() {
        "summary" => ANALYSIS_PROMPTS[0],
        "code-changes" => ANALYSIS_PROMPTS[1],
        "errors" => ANALYSIS_PROMPTS[2],
        "custom" => args
            .custom_prompt
            .as_deref()
            .ok_or_else(|| AppError::Invalid("自定义模板需提供 customPrompt".into()))?,
        _ => return Err(AppError::Invalid(format!("未知模板: {}", args.template))),
    };
    let user_msg = system.replace("{{context}}", &context);

    // 4) 流式调用
    let (tx, mut rx) = mpsc::channel::<AnalyzeEvent>(64);
    let app_clone = app.clone();

    let req = AnthropicRequest {
        base_url: args.base_url.clone(),
        api_key: args.api_key.clone(),
        model: args.model.clone(),
        max_tokens: args.max_tokens,
        messages: vec![serde_json::json!({ "role": "user", "content": user_msg })],
    };

    tauri::async_runtime::spawn(async move {
        let mut stream = stream_anthropic(&req);
        while let Some(chunk) = stream.recv().await {
            let evt = match chunk {
                Ok((text, _usage)) => {
                    if !text.is_empty() {
                        AnalyzeEvent::Delta { text }
                    } else {
                        continue;
                    }
                }
                Err(e) => AnalyzeEvent::Error {
                    message: e.to_string(),
                },
            };
            if tx.send(evt).await.is_err() {
                break;
            }
        }
        let _ = tx
            .send(AnalyzeEvent::Done {
                total_input_tokens: None,
                total_output_tokens: None,
            })
            .await;
    });

    tauri::async_runtime::spawn(async move {
        while let Some(evt) = rx.recv().await {
            let _ = app_clone.emit("analyze-event", &evt);
        }
        let _ = app_clone.emit("analyze-done", &serde_json::json!({}));
    });

    Ok(())
}

/// 取消当前分析(简化版:通过事件通知前端停止消费)
#[tauri::command]
pub async fn cancel_analyze(_state: State<'_, Arc<AppState>>, app: AppHandle) -> AppResult<()> {
    // 占位:前端应停止监听 analyze-event
    let _ = app.emit("analyze-cancelled", &serde_json::json!({}));
    Ok(())
}

const ANALYSIS_PROMPTS: [&str; 3] = [
    // summary
    r#"你是一个资深的会议记录员。请阅读以下 Claude Code / OpenClaw 会话转录,输出结构化总结(用中文):

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
{{context}}"#,
    // code-changes
    r#"请从以下 Claude Code / OpenClaw 会话中提取所有文件级别的修改,按表格输出(中文):

| 文件路径 | 修改类型 | 目的 | 关键 diff 摘要 |
|---|---|---|---|

规则:
- 只列实际修改(Edit/Write/NotebookEdit 工具调用),忽略 Read/Bash/Grep/Glob
- 修改类型: 新增 / 修改 / 删除
- "目的" 是用户为什么改这个文件(1 句话)
- "关键 diff 摘要" 列出 1–3 个核心变更点
- 如果没有修改任何文件,明确说"无文件修改"
- 按时间顺序排序

以下是会话转录:
---
{{context}}"#,
    // errors
    r#"请审查以下 Claude Code / OpenClaw 会话中的错误和潜在陷阱(用中文输出):

## 1. 工具调用失败
(退出码 ≠ 0、或 is_error=true 的工具调用)

## 2. 重复尝试
(同类操作重复 ≥ 2 次仍失败的情况)

## 3. 隐含假设错误
(Agent 做了错误假设但被用户纠正的地方)

## 4. 资源浪费
(读了整个大文件、跑了无意义的命令等)

## 5. 下次改进建议
(3–5 条具体可操作的建议)

要求: 引用具体工具名和报错片段,总结 ≤ 500 字

以下是会话转录:
---
{{context}}"#,
];

// 占位,实际不直接用
#[allow(dead_code)]
fn _ensure_value(_v: &Value) {}
