//! 大模型分析命令 — 调用 Anthropic 兼容 API

use std::collections::HashMap;
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
pub async fn analyze_session(
    args: AnalyzeArgs,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> AppResult<()> {
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

    // v0.8.14 item C: 注册 abort handle — cancel_analyze 翻 true 后,
    // 后端 stream task 立刻 bail,不再发后续 delta 也不再发 Done,
    // 避免空烧 API quota 和 CPU。
    let job_id = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id()
    );
    let abort_flag = Arc::new(parking_lot::Mutex::new(false));
    {
        let mut map = state.analyze_aborts.write();
        map.insert(job_id.clone(), abort_flag.clone());
    }

    // 4) 流式调用
    let (tx, mut rx) = mpsc::channel::<AnalyzeEvent>(64);
    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);
    let job_id_for_task = job_id.clone();

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
            // v0.8.14 item C: cancel 检查 — abort=true 立刻跳出
            if *abort_flag.lock() {
                break;
            }
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
        // v0.8.14 item C: 区分 done vs cancelled — cancelled 时不发 Done
        // 事件(前端 store 已在 cancel handler reset state),避免误把
        // cancel 触发成 "分析完成"。
        let aborted = *abort_flag.lock();
        if !aborted {
            let _ = tx
                .send(AnalyzeEvent::Done {
                    total_input_tokens: None,
                    total_output_tokens: None,
                })
                .await;
        }
        // 任务结束 — 清理 abort handle (done/cancelled/error 都清)
        state_clone.analyze_aborts.write().remove(&job_id_for_task);
    });

    tauri::async_runtime::spawn(async move {
        while let Some(evt) = rx.recv().await {
            let _ = app_clone.emit("analyze-event", &evt);
        }
        let _ = app_clone.emit("analyze-done", &serde_json::json!({}));
    });

    Ok(())
}

/// 取消当前分析(v0.8.14 item C: 真停后端)
#[tauri::command]
pub async fn cancel_analyze(state: State<'_, Arc<AppState>>, app: AppHandle) -> AppResult<()> {
    flip_all_abort_flags(&state.analyze_aborts);
    let _ = app.emit("analyze-cancelled", &serde_json::json!({}));
    Ok(())
}

/// v0.8.14 item C: 把所有活跃 abort flag 翻 true。
/// stream task 下次 while 循环开头检查 *abort_flag.lock() 就会 break,
/// 不再发后续 delta 也不再发 Done — 避免空烧 API quota 和 CPU。
///
/// 单独抽出来便于测试 — 不需要构造完整 AppState 就能验证 flag flip。
pub(crate) fn flip_all_abort_flags(
    aborts: &parking_lot::RwLock<HashMap<String, Arc<parking_lot::Mutex<bool>>>>,
) {
    let map = aborts.read();
    for flag in map.values() {
        *flag.lock() = true;
    }
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

#[cfg(test)]
mod tests {
    //! v0.8.14 item C: cancel_analyze 真停后端 — 测试 abort flag
    //! 翻转契约。完整 stream task 行为需要 mock HTTP server,这里
    //! 只锁住"flag 翻 true 后下游 stream task 能检测到"这个核心
    //! 机制 — 跟生产代码里的 abort_flag.lock() 检查一致。

    use super::*;
    use parking_lot::RwLock;
    use std::collections::HashMap;

    fn empty_aborts() -> parking_lot::RwLock<HashMap<String, Arc<parking_lot::Mutex<bool>>>> {
        RwLock::new(HashMap::new())
    }

    #[test]
    fn flip_all_abort_flags_marks_every_active_job() {
        let aborts = empty_aborts();
        let flag1 = Arc::new(parking_lot::Mutex::new(false));
        let flag2 = Arc::new(parking_lot::Mutex::new(false));
        aborts.write().insert("job-1".to_string(), flag1.clone());
        aborts.write().insert("job-2".to_string(), flag2.clone());

        flip_all_abort_flags(&aborts);

        assert!(*flag1.lock(), "job-1 abort flag 应该被翻 true");
        assert!(*flag2.lock(), "job-2 abort flag 应该被翻 true");
    }

    #[test]
    fn flip_all_abort_flags_empty_map_is_noop() {
        let aborts = empty_aborts();
        // 不 panic 即过
        flip_all_abort_flags(&aborts);
        assert!(aborts.read().is_empty());
    }

    #[test]
    fn abort_flag_pattern_matches_stream_loop_check() {
        // 锁住"stream task 检查 abort 的语义":一旦 flag = true,
        // 下次 while 循环开头的 *abort_flag.lock() == true 就 break。
        // 模拟:跑 3 次后 cancel,验证第 4 次循环开头能 break。
        let flag = Arc::new(parking_lot::Mutex::new(false));
        let mut iterations = 0;
        loop {
            if *flag.lock() {
                break;
            }
            iterations += 1;
            if iterations == 3 {
                // 第 3 次迭代后 flip — 模拟 cancel_analyze 被调用
                *flag.lock() = true;
            }
            if iterations > 5 {
                panic!("loop 没按预期 break — abort flag 没生效");
            }
        }
        // iterations=3 时翻 true;循环回到顶部 → 检查 → break。
        // iterations 此时停在 3(break 前没有 +=1)。
        assert_eq!(iterations, 3, "iter 3 flip → 下次循环 check 应该 break");
    }
}
