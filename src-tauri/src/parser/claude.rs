//! Claude 记录归一化
//!
//! 与前端 packages/shared/src/normalize.ts 的 normalizeClaudeRecord 保持同步
//!
//! v0.3.0: block-level normalize 改为走 `blocks::default_registry()`。
//! 本文件保留顶层 type 归一化逻辑(`normalize()`)。
//!
//! v0.9.17: 新增 batch 入口 `normalize_session()`,把 `ai-title` / `custom-title`
//! events 聚合成 1 个 `ai-title.chart` meta, 避免详情页被 1185 个 title block 撑爆。
//! 单条 streaming `normalize()` 保留原 behavior (SubagentMetaBlock 渲染依赖),
//! 双路径分叉: streaming (export/analyze/subagent) vs batch (transcript UI)。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// v0.8.10: Claude JSONL record 里 parent reference 的 JSON key (顶层 const,
/// 跟 `parser/blocks/tool_use.rs::TOOL_USE_ALIASES` 同 pattern,给
/// `parser/meta_extras.rs::build_meta_full` 共享 — 避免硬编码 "parentUuid"
/// 字符串跟其它路径脱节。
pub const CLAUDE_PARENT_KEY: &str = "parentUuid";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedBlock {
    /// "text" | "thinking" | "tool_use" | "tool_result" | "image" | "meta"
    pub kind: String,
    #[serde(flatten)]
    pub data: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    pub id: String,
    /// "user" | "assistant" | "tool" | "system" | "meta"
    pub role: String,
    pub timestamp: Option<String>,
    pub blocks: Vec<NormalizedBlock>,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    #[serde(rename = "tokenUsage")]
    pub token_usage: Option<TokenUsageOut>,
    pub is_sidechain: Option<bool>,
    pub subagent_id: Option<String>,
    pub parent_uuid: Option<String>,
    /// 原始 type 字段
    pub raw_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageOut {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// 归一化 Claude JSON 记录
pub fn normalize(record: &Value, index: usize) -> Option<NormalizedMessage> {
    let obj = record.as_object()?;
    let r#type = obj.get("type")?.as_str()?.to_string();
    let id = obj
        .get("uuid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("idx-{}", index));
    let timestamp = obj
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let parent_uuid = obj
        .get("parentUuid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_sidechain = obj.get("isSidechain").and_then(|v| v.as_bool());

    // v0.6.0: subagentId 归一化
    //
    // 数据源: 子 session (`<main>/subagents/agent-<id>.jsonl`) 的 envelope 顶层有
    //   { "isSidechain": true, "agentId": "a1d924c..." }
    // 主 session envelope 顶层没 agentId 字段,且 isSidechain 始终 false。
    //
    // ⚠️ 关键安全: **只在 isSidechain=true 时信任 agentId**。
    //   主 session 即使 envelope 写了 agentId(实测没有)也不填,避免子代理消息被误标
    //   到主 session timeline 上。
    let subagent_id = if is_sidechain == Some(true) {
        obj.get("agentId")
            .and_then(|v| v.as_str())
            .map(String::from)
    } else {
        None
    };

    let mut msg = NormalizedMessage {
        id,
        role: "meta".to_string(),
        timestamp,
        blocks: vec![],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain,
        subagent_id,
        parent_uuid,
        raw_type: r#type.clone(),
    };

    match r#type.as_str() {
        "user" => {
            msg.role = "user".to_string();
            if let Some(message) = obj.get("message") {
                if let Some(content) = message.get("content") {
                    msg.blocks = normalize_content(content);
                }
            }
        }
        "assistant" => {
            msg.role = "assistant".to_string();
            if let Some(message) = obj.get("message") {
                msg.model = message
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                msg.stop_reason = message
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(content) = message.get("content") {
                    msg.blocks = normalize_content(content);
                }
                if let Some(usage) = message.get("usage") {
                    msg.token_usage = Some(TokenUsageOut {
                        input: usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        output: usage
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_read: usage
                            .get("cache_read_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_write: usage
                            .get("cache_creation_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                    });
                }
            }
        }
        "system" => {
            msg.role = "system".to_string();
            let content = obj
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            msg.blocks.push(NormalizedBlock {
                kind: "text".to_string(),
                data: serde_json::Map::from_iter([("text".to_string(), Value::String(content))]),
            });
        }
        "attachment" => {
            if let Some(att) = obj.get("attachment") {
                let label = att
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("attachment")
                    .to_string();
                let mut data = serde_json::Map::new();
                data.insert("label".to_string(), Value::String(label));
                data.insert("payload".to_string(), att.clone());
                msg.blocks.push(NormalizedBlock {
                    kind: "meta".to_string(),
                    data,
                });
            }
        }
        "mode" => {
            let mode = obj
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String(format!("mode: {}", mode)),
            );
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "permission-mode" => {
            let mode = obj
                .get("permissionMode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String(format!("permission: {}", mode)),
            );
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "ai-title" | "custom-title" => {
            let title = obj
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut data = serde_json::Map::new();
            data.insert("label".to_string(), Value::String("title".to_string()));
            data.insert("payload".to_string(), Value::String(title));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "last-prompt" => {
            // v0.6.0: 真实数据字段是 `lastPrompt` (camelCase), 兼容老版本 `prompt`
            let prompt = obj
                .get("lastPrompt")
                .or_else(|| obj.get("prompt"))
                .cloned()
                .unwrap_or(Value::Null);
            let leaf_uuid = obj
                .get("leafUuid")
                .and_then(|v| v.as_str())
                .map(String::from);
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("last-prompt".to_string()),
            );
            // v0.6.0: payload 结构改成 { prompt, leafUuid? } 跟前端 normalize.ts 对齐
            // (之前是裸 string, UI 拿不到 leafUuid 无法跳转)
            let mut payload = serde_json::Map::new();
            if !prompt.is_null() {
                payload.insert("prompt".to_string(), prompt);
            }
            if let Some(lu) = leaf_uuid {
                payload.insert("leafUuid".to_string(), Value::String(lu));
            }
            data.insert("payload".to_string(), Value::Object(payload));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "file-history-snapshot" => {
            let snapshot = obj.get("snapshot").cloned().unwrap_or(Value::Null);
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("file-history-snapshot".to_string()),
            );
            data.insert("payload".to_string(), snapshot);
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "task_reminder" => {
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("task-reminder".to_string()),
            );
            data.insert("payload".to_string(), Value::Object(obj.clone()));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "queue-operation" => {
            // v0.8.4 item 4: 独立 dispatch (top-level envelope, 不在 attachment 里)
            if let Some(block) =
                crate::parser::blocks::build_queue_operation_block(&Value::Object(obj.clone()))
            {
                msg.blocks.push(block);
            }
        }
        _ => {
            // 未知 type,原样塞到 meta
            let mut data = serde_json::Map::new();
            data.insert("label".to_string(), Value::String(r#type.clone()));
            data.insert("payload".to_string(), Value::Object(obj.clone()));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
    }

    Some(msg)
}

/// 归一化 content(字符串或数组)。公开给 openclaw.rs 直接调用。
pub(crate) fn normalize_content(content: &Value) -> Vec<NormalizedBlock> {
    let mut out = Vec::new();
    match content {
        Value::String(s) => {
            log::trace!("normalize_content: string len={}", s.len());
            let mut data = serde_json::Map::new();
            data.insert("text".to_string(), Value::String(s.clone()));
            out.push(NormalizedBlock {
                kind: "text".to_string(),
                data,
            });
        }
        Value::Array(arr) => {
            log::trace!("normalize_content: array len={}", arr.len());
            for item in arr {
                if let Some(b) = normalize_content_block(item) {
                    out.push(b);
                }
            }
        }
        other => {
            // v0.2.6 调查:Windows 上 liushuyou/91d1796e 报 [object Object],
            // 可能是 content 是单个对象(不是数组)且类型不在已知列表里。
            log::warn!(
                "normalize_content: 未知 content 形态 {:?} - {:#?}",
                match other {
                    Value::Null => "null",
                    Value::Bool(_) => "bool",
                    Value::Number(_) => "number",
                    Value::Object(_) => "object",
                    Value::String(_) => "string",
                    Value::Array(_) => "array",
                },
                other
            );
        }
    }
    out
}

/// v0.3.0: block 归一化委托给 BlockRegistry
///
/// 行为应当与之前的 inline match 等价(53 个测试全过)。
/// 真正的 handler 实现拆到 `parser/blocks/` 目录。
fn normalize_content_block(item: &Value) -> Option<NormalizedBlock> {
    crate::parser::blocks::default_registry()
        .normalize(item)
        .ok()
}

// =====================================================================
// v0.9.17: Claude batch normalize 路径 + ai-title / custom-title 聚合
// =====================================================================

/// v0.9.17: 单条 ai-title / custom-title event 的归一化结构
#[derive(Debug, Clone)]
struct AiTitleRecord {
    /// "ai-title" | "custom-title" (保留优先级 metadata — 跟 build_claude_session_meta
    /// precedence `custom > ai > first_user` 一致)
    raw_type: String,
    /// title 文本 (slug-form English 或 Chinese)
    title: String,
    /// event timestamp (ms, optional — 当前 fixture 多数 ai-title 没带 timestamp)
    time: u64,
}

/// v0.9.17: batch 归一化 Claude session (mirrors kimi normalize_session)
///
/// 区别: Claude 当前只有 streaming `normalize()`, 详情页被 1185 个 ai-title
/// meta block 撑爆。本函数批量处理: 大多数 event 走原 `normalize()` 单条 emit,
/// `ai-title` / `custom-title` 不 inline emit → 推入 `ai_title_records` collector,
/// 末尾聚合 emit 1 个 `ai-title.chart` meta。
///
/// 调用点: `commands/transcript.rs` claude 分支 (类似 kimi:61-96 batch 路由)。
/// export / analyze 仍走 streaming `normalize()` (scope 不同, 留 v0.9.18+)。
pub fn normalize_session(
    records: impl IntoIterator<Item = serde_json::Value>,
) -> Vec<NormalizedMessage> {
    let mut out: Vec<NormalizedMessage> = Vec::new();
    let mut ai_title_records: Vec<AiTitleRecord> = Vec::new();

    for (idx, rec) in records.into_iter().enumerate() {
        let obj = match rec.as_object() {
            Some(o) => o,
            None => continue,
        };
        let r#type = match obj.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => continue,
        };

        // v0.9.17: ai-title / custom-title 不 inline emit → 推入 collector
        if r#type == "ai-title" || r#type == "custom-title" {
            if let Some(r) = parse_ai_title_record(obj, r#type) {
                ai_title_records.push(r);
            }
            continue; // skip inline emit
        }

        // 其它 event 走原 normalize() (保留所有现有行为: user / assistant /
        // system / mode / permission-mode / attachment / last-prompt / file-history-snapshot /
        // task_reminder / queue-operation / unknown fallback)
        if let Some(msg) = normalize(&rec, idx) {
            out.push(msg);
        }
    }

    // 末尾 emit 1 个聚合 ai-title.chart meta
    if !ai_title_records.is_empty() {
        let chart_idx = out.len();
        if let Some(chart_msg) = build_ai_title_chart_meta(&ai_title_records, chart_idx) {
            out.push(chart_msg);
        }
    }

    out
}

/// v0.9.17: 从 raw event 提取关键字段 (跟 kimi parse_todo_record 同 pattern)
///
/// 字段名差异:
/// - `ai-title` → `aiTitle` (camelCase)
/// - `custom-title` → `title`
fn parse_ai_title_record(
    obj: &serde_json::Map<String, Value>,
    raw_type: &str,
) -> Option<AiTitleRecord> {
    let title = match raw_type {
        "ai-title" => obj
            .get("aiTitle")
            .and_then(|v| v.as_str())
            .map(String::from),
        "custom-title" => obj.get("title").and_then(|v| v.as_str()).map(String::from),
        _ => None,
    }?;
    if title.is_empty() {
        return None;
    }
    let time = obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(AiTitleRecord {
        raw_type: raw_type.to_string(),
        title,
        time,
    })
}

/// v0.9.17: N 个 ai-title / custom-title events → 1 个聚合 ai-title.chart meta
///
/// 跟 v0.9.16 todos.chart 区别:
/// - todos.chart: 状态机信号 (pending/in_progress/done 生命周期 + churn)
/// - ai-title.chart: identity 信号 (session 标题变更轨迹 + 优先级)
///
/// 设计动机:
/// - 详情页被 1185 个 title meta block 撑爆 (跟 v0.9.16 bpm-large 57 todo 同)
/// - <redacted-session-id> 实测: 1185 ai-title events / 18 unique / top-1 占 267 events
/// - 用户角度: "Claude 怎么 rename session 标题" / "哪些 title 被重用最多"
///
/// 顶层 stats:
/// - event_count, unique_title_count, custom_title_count, ai_title_count
/// - current_title (highest-precedence 末次 title, custom>ai)
/// - first_seen_title (第一次出现的 title)
/// - title_changes_count (新 title 第一次出现次数 = unique - 1)
/// - first_event_at, last_event_at, duration_ms
///
/// buckets[] (60 时间窗口):
/// - bucket_start / bucket_end (event index 范围)
/// - event_count, ai_count, custom_count (前端 inline SVG 渲染)
///
/// title_timeline[]:
/// - 每个 unique title → 第一次 seen 时的 index + time + raw_type
/// - 按 first-seen 升序排序
///
/// top_titles[]:
/// - top 10 unique titles by event count
/// - 含 raw_type (priority hint)
///
/// payload.raw_events: 前 5 + 后 5 raw event (drill-down)
#[allow(clippy::too_many_lines)]
fn build_ai_title_chart_meta(records: &[AiTitleRecord], index: usize) -> Option<NormalizedMessage> {
    if records.is_empty() {
        return None;
    }

    let total = records.len();

    // 1. custom vs ai 拆分
    let custom_count = records
        .iter()
        .filter(|r| r.raw_type == "custom-title")
        .count() as u32;
    let ai_count = total as u32 - custom_count;

    // 2. unique title tracking + first-seen index + per-title event count
    let mut seen_titles: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unique_titles: std::collections::BTreeMap<String, (u64, u32, String)> =
        std::collections::BTreeMap::new(); // title → (first_seen_time, first_seen_index, raw_type)
    let mut title_event_counts: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    for (i, r) in records.iter().enumerate() {
        *title_event_counts.entry(r.title.clone()).or_insert(0) += 1;
        seen_titles.insert(r.title.clone());
        unique_titles
            .entry(r.title.clone())
            .or_insert((r.time, i as u32, r.raw_type.clone()));
    }

    let unique_title_count = unique_titles.len() as u32;
    let title_changes_count = unique_title_count.saturating_sub(1);

    // 3. current_title: highest-precedence 末次 (custom>ai), 跟 build_claude_session_meta
    //    lines 436-473 同 precedence logic
    let current_title = records
        .iter()
        .rev()
        .find(|r| r.raw_type == "custom-title")
        .or_else(|| records.iter().rev().find(|r| r.raw_type == "ai-title"))
        .map(|r| r.title.clone())
        .unwrap_or_default();

    let first_seen_title = records.first().map(|r| r.title.clone()).unwrap_or_default();

    // 4. time stats (records 多数没带 timestamp → fallback 0)
    let first_event_at = records
        .iter()
        .map(|r| r.time)
        .filter(|t| *t > 0)
        .min()
        .unwrap_or(0);
    let last_event_at = records
        .iter()
        .map(|r| r.time)
        .filter(|t| *t > 0)
        .max()
        .unwrap_or(0);
    let duration_ms = last_event_at.saturating_sub(first_event_at);

    // 5. 60 buckets (跟 v0.9.14/15/16 同 BUCKET_TARGET)
    const BUCKET_TARGET: usize = 60;
    let bucket_count = records.len().clamp(1, BUCKET_TARGET);
    let mut buckets: Vec<serde_json::Value> = Vec::with_capacity(bucket_count);
    let n = records.len();
    let base_size = n / bucket_count;
    let extra_count = n % bucket_count;
    let mut start = 0usize;
    for i in 0..bucket_count {
        let size = base_size + if i < extra_count { 1 } else { 0 };
        let end = (start + size).min(n);
        if start >= n || size == 0 {
            break;
        }
        let slice = &records[start..end];
        let b_event_count = slice.len() as u32;
        let b_custom = slice
            .iter()
            .filter(|r| r.raw_type == "custom-title")
            .count() as u32;
        let b_ai = b_event_count - b_custom;
        // bucket_start / bucket_end 用 event index 范围 (records 多数没统一 time 时按 index)
        buckets.push(json!({
            "bucket_start": start as u64,
            "bucket_end": end as u64,
            "event_count": b_event_count,
            "custom_count": b_custom,
            "ai_count": b_ai,
        }));
        start = end;
    }

    // 6. title_timeline (按 first-seen index 升序)
    let mut title_timeline: Vec<(String, u64, u32, String, u32)> = unique_titles
        .into_iter()
        .map(|(title, (time, idx, raw_type))| {
            let count = title_event_counts.get(&title).copied().unwrap_or(0);
            (title, time, idx, raw_type, count)
        })
        .collect();
    title_timeline.sort_by_key(|(_, _, idx, _, _)| *idx);

    // 7. top_titles (top 10 by event count)
    let mut top_titles_vec: Vec<(String, u32, String)> = title_event_counts
        .into_iter()
        .map(|(title, count)| {
            // 从 records 找 raw_type (第一个出现)
            let raw_type = records
                .iter()
                .find(|r| r.title == title)
                .map(|r| r.raw_type.clone())
                .unwrap_or_else(|| "ai-title".to_string());
            (title, count, raw_type)
        })
        .collect();
    top_titles_vec.sort_by_key(|b| std::cmp::Reverse(b.1));
    top_titles_vec.truncate(10);

    // 8. raw_events drill-down (前 5 + 后 5, 跟 v0.9.16 todos.chart 同 pattern)
    let raw_events: Vec<serde_json::Value> = if records.len() <= 10 {
        records.iter().map(raw_ai_title_event_value).collect()
    } else {
        let head: Vec<serde_json::Value> =
            records[..5].iter().map(raw_ai_title_event_value).collect();
        let tail: Vec<serde_json::Value> = records[records.len() - 5..]
            .iter()
            .map(raw_ai_title_event_value)
            .collect();
        head.into_iter().chain(tail).collect()
    };

    // 9. 顶层 data 字段 (snake_case, 跟 v0.9.14/15/16 kimi chart 同 convention)
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("ai-title.chart".to_string()),
    );
    data.insert("event_count".to_string(), Value::from(total as u64));
    data.insert(
        "unique_title_count".to_string(),
        Value::from(unique_title_count as u64),
    );
    data.insert(
        "custom_title_count".to_string(),
        Value::from(custom_count as u64),
    );
    data.insert("ai_title_count".to_string(), Value::from(ai_count as u64));
    data.insert(
        "title_changes_count".to_string(),
        Value::from(title_changes_count as u64),
    );
    data.insert("current_title".to_string(), Value::String(current_title));
    data.insert(
        "first_seen_title".to_string(),
        Value::String(first_seen_title),
    );
    data.insert("first_event_at".to_string(), Value::from(first_event_at));
    data.insert("last_event_at".to_string(), Value::from(last_event_at));
    data.insert("duration_ms".to_string(), Value::from(duration_ms));
    data.insert("buckets".to_string(), Value::Array(buckets));
    data.insert(
        "title_timeline".to_string(),
        Value::Array(
            title_timeline
                .into_iter()
                .map(|(title, time, idx, raw_type, count)| {
                    json!({
                        "title": title,
                        "first_seen_time": time,
                        "first_seen_index": idx,
                        "raw_type": raw_type,
                        "event_count": count,
                    })
                })
                .collect(),
        ),
    );
    data.insert(
        "top_titles".to_string(),
        Value::Array(
            top_titles_vec
                .into_iter()
                .map(|(title, count, raw_type)| {
                    json!({
                        "title": title,
                        "event_count": count,
                        "raw_type": raw_type,
                    })
                })
                .collect(),
        ),
    );
    data.insert(
        "payload".to_string(),
        json!({
            "raw_events": raw_events,
            "raw_count": records.len(),
        }),
    );

    Some(NormalizedMessage {
        id: format!("claude-ai-title-chart-{index}"),
        role: "meta".to_string(),
        timestamp: None,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "ai-title".to_string(),
    })
}

/// v0.9.17: 把 AiTitleRecord 渲染回 wire 原始 JSON shape (drill-down sample 用)
fn raw_ai_title_event_value(r: &AiTitleRecord) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".to_string(), Value::String(r.raw_type.clone()));
    if r.raw_type == "ai-title" {
        obj.insert("aiTitle".to_string(), Value::String(r.title.clone()));
    } else {
        obj.insert("title".to_string(), Value::String(r.title.clone()));
    }
    if r.time > 0 {
        obj.insert("time".to_string(), Value::from(r.time));
    }
    Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_normalize_user_text() {
        let v = json!({
            "type": "user",
            "uuid": "u1",
            "timestamp": "2026-06-20T00:00:00Z",
            "message": { "role": "user", "content": "Hello" }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "user");
        assert_eq!(n.id, "u1");
        assert_eq!(n.timestamp.as_deref(), Some("2026-06-20T00:00:00Z"));
        assert_eq!(n.blocks.len(), 1);
        assert_eq!(n.blocks[0].kind, "text");
    }

    #[test]
    fn test_normalize_user_blocks() {
        let v = json!({
            "type": "user",
            "uuid": "u2",
            "message": {
                "role": "user",
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "text", "text": "second" }
                ]
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks.len(), 2);
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(n.blocks[1].kind, "text");
    }

    #[test]
    fn test_normalize_assistant_with_tool_use() {
        let v = json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "Let me check." },
                    {
                        "type": "tool_use",
                        "id": "tu1",
                        "name": "Read",
                        "input": { "file_path": "/tmp/a.ts" }
                    }
                ],
                "model": "claude-sonnet-4-6",
                "stop_reason": "tool_use",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_read_input_tokens": 20
                }
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "assistant");
        assert_eq!(n.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(n.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(n.token_usage.as_ref().unwrap().input, 100);
        assert_eq!(n.token_usage.as_ref().unwrap().cache_read, 20);
        assert_eq!(n.blocks.len(), 2);
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(n.blocks[1].kind, "tool_use");
    }

    #[test]
    fn test_normalize_assistant_thinking() {
        let v = json!({
            "type": "assistant",
            "uuid": "a2",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "Let me think...", "signature": "sig1" },
                    { "type": "text", "text": "Answer" }
                ],
                "model": "claude-opus-4-8",
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 1, "output_tokens": 1 }
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks[0].kind, "thinking");
        assert_eq!(n.blocks[1].kind, "text");
    }

    #[test]
    fn test_normalize_meta_records() {
        let cases = [
            ("mode", json!({ "type": "mode", "mode": "plan" })),
            (
                "permission-mode",
                json!({ "type": "permission-mode", "permissionMode": "acceptEdits" }),
            ),
            (
                "custom-title",
                json!({ "type": "custom-title", "title": "My session" }),
            ),
            (
                "ai-title",
                json!({ "type": "ai-title", "title": "AI title" }),
            ),
            (
                "task_reminder",
                json!({ "type": "task_reminder", "itemCount": 3 }),
            ),
            (
                "file-history-snapshot",
                json!({
                    "type": "file-history-snapshot",
                    "messageId": "m1",
                    "snapshot": { "trackedFileBackups": {} }
                }),
            ),
        ];
        for (label, v) in cases {
            let n = normalize(&v, 0).unwrap_or_else(|| panic!("{label}"));
            assert_eq!(n.role, "meta", "role mismatch for {label}");
            assert_eq!(n.blocks[0].kind, "meta");
            assert!(!n.blocks[0].data.is_empty(), "{label} should have label");
        }
    }

    #[test]
    fn test_normalize_attachment() {
        let v = json!({
            "type": "attachment",
            "attachment": {
                "type": "agent_listing_delta",
                "addedTypes": ["Explore"]
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "meta");
        assert_eq!(n.blocks[0].kind, "meta");
        assert_eq!(
            n.blocks[0].data.get("label").and_then(|v| v.as_str()),
            Some("agent_listing_delta")
        );
    }

    #[test]
    fn test_normalize_tool_result() {
        let v = json!({
            "type": "user",
            "uuid": "u3",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu1",
                        "content": "the result",
                        "is_error": false
                    }
                ]
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks.len(), 1);
        assert_eq!(n.blocks[0].kind, "tool_result");
    }

    #[test]
    fn test_normalize_unknown_type() {
        let v = json!({ "type": "weird-future-type", "data": 42 });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "weird-future-type");
    }

    /// v0.2.6: pi-coding-agent 用 `toolCall` type + `arguments` 字段(不是
    /// Claude 的 `tool_use` + `input`)。归一化后应当映射到 kind=tool_use
    /// 且 `arguments` 重命名为 `input`。
    #[test]
    fn test_normalize_tool_call_alias() {
        let v = json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "call_abc",
                        "name": "read",
                        "arguments": { "path": "/tmp/x.md" }
                    }
                ],
                "model": "claude-sonnet-4-6",
                "stop_reason": "tool_use",
                "usage": { "input_tokens": 1, "output_tokens": 1 }
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks.len(), 1);
        let b = &n.blocks[0];
        assert_eq!(b.kind, "tool_use");
        assert_eq!(b.data.get("id").and_then(|v| v.as_str()), Some("call_abc"));
        assert_eq!(b.data.get("name").and_then(|v| v.as_str()), Some("read"));
        // arguments → input 重命名
        assert_eq!(
            b.data
                .get("input")
                .and_then(|v| v.get("path"))
                .and_then(|v| v.as_str()),
            Some("/tmp/x.md")
        );
        // 原始 arguments 字段已移除
        assert!(b.data.get("arguments").is_none());
    }

    #[test]
    fn test_normalize_missing_uuid_uses_index() {
        let v = json!({ "type": "user", "message": { "role": "user", "content": "x" } });
        let n = normalize(&v, 42).unwrap();
        assert_eq!(n.id, "idx-42");
    }

    // v0.6.0: subagentId 归一化 — 3 case

    #[test]
    fn test_subagent_id_filled_only_when_is_sidechain_true() {
        // isSidechain=true 且 envelope 有 agentId → 填入
        let v = json!({
            "type": "user",
            "isSidechain": true,
            "agentId": "a1d924c184a57a7da",
            "message": { "role": "user", "content": "..." }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.subagent_id.as_deref(), Some("a1d924c184a57a7da"));
        assert_eq!(n.is_sidechain, Some(true));
    }

    #[test]
    fn test_subagent_id_ignored_when_is_sidechain_false() {
        // isSidechain=false (主 session) 即便 envelope 写 agentId 也不填 —
        // 避免子代理消息被误标到主 session timeline。
        let v = json!({
            "type": "user",
            "isSidechain": false,
            "agentId": "should_be_ignored",
            "message": { "role": "user", "content": "..." }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.subagent_id, None);
        assert_eq!(n.is_sidechain, Some(false));
    }

    #[test]
    fn test_subagent_id_none_when_is_sidechain_true_but_no_agent_id() {
        // isSidechain=true 但 envelope 缺 agentId(老 Claude / 边界 case) → None
        let v = json!({
            "type": "user",
            "isSidechain": true,
            "message": { "role": "user", "content": "..." }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.subagent_id, None);
    }

    // ===== v0.9.17: ai-title / custom-title 聚合 (batch normalize_session) =====

    #[test]
    fn parse_ai_title_record_extracts_title_from_ai_title_field() {
        // ai-title 字段名是 `aiTitle` (camelCase)
        let v = json!({
            "type": "ai-title",
            "aiTitle": "<redacted-slug>",
            "sessionId": "<redacted-session-id>"
        });
        let obj = v.as_object().unwrap();
        let rec = parse_ai_title_record(obj, "ai-title").unwrap();
        assert_eq!(rec.raw_type, "ai-title");
        assert_eq!(rec.title, "<redacted-slug>");
        assert_eq!(rec.time, 0); // 没 timestamp
    }

    #[test]
    fn parse_ai_title_record_extracts_title_from_custom_title_field() {
        // custom-title 字段名是 `title`
        let v = json!({
            "type": "custom-title",
            "title": "我的自定义 session 名",
            "sessionId": "<redacted-session-id>"
        });
        let obj = v.as_object().unwrap();
        let rec = parse_ai_title_record(obj, "custom-title").unwrap();
        assert_eq!(rec.raw_type, "custom-title");
        assert_eq!(rec.title, "我的自定义 session 名");
        assert_eq!(rec.time, 0);
    }

    #[test]
    fn parse_ai_title_record_skips_empty_title() {
        // ai-title / custom-title 必须有非空 title 字符串,否则跳过
        let v = json!({ "type": "ai-title", "aiTitle": "" });
        let obj = v.as_object().unwrap();
        assert!(parse_ai_title_record(obj, "ai-title").is_none());
    }

    #[test]
    fn parse_ai_title_record_skips_unknown_raw_type() {
        // 未知 raw_type → None
        let v = json!({ "type": "ai-title", "aiTitle": "foo" });
        let obj = v.as_object().unwrap();
        assert!(parse_ai_title_record(obj, "weird-type").is_none());
    }

    #[test]
    fn build_ai_title_chart_meta_empty_input_returns_none() {
        // 0 records → None (跟 v0.9.14/15/16 kimi chart 同 pattern)
        let recs: Vec<AiTitleRecord> = vec![];
        assert!(build_ai_title_chart_meta(&recs, 0).is_none());
    }

    #[test]
    fn build_ai_title_chart_meta_aggregates_buckets_and_top_titles() {
        // 5 synthetic records:
        //   #0 ai-title "alpha" (first_seen=0)
        //   #1 ai-title "beta" (first_seen=1)
        //   #2 ai-title "alpha" (dup)
        //   #3 custom-title "alpha-override" (优先级最高 — current)
        //   #4 ai-title "alpha" (dup)
        let recs = vec![
            AiTitleRecord {
                raw_type: "ai-title".to_string(),
                title: "alpha".to_string(),
                time: 1000,
            },
            AiTitleRecord {
                raw_type: "ai-title".to_string(),
                title: "beta".to_string(),
                time: 2000,
            },
            AiTitleRecord {
                raw_type: "ai-title".to_string(),
                title: "alpha".to_string(),
                time: 3000,
            },
            AiTitleRecord {
                raw_type: "custom-title".to_string(),
                title: "alpha-override".to_string(),
                time: 4000,
            },
            AiTitleRecord {
                raw_type: "ai-title".to_string(),
                title: "alpha".to_string(),
                time: 5000,
            },
        ];
        let chart = build_ai_title_chart_meta(&recs, 0).unwrap();
        assert_eq!(chart.role, "meta");
        assert_eq!(chart.raw_type, "ai-title");
        assert_eq!(chart.id, "claude-ai-title-chart-0");

        let data = &chart.blocks[0].data;
        assert_eq!(
            data.get("label").unwrap().as_str().unwrap(),
            "ai-title.chart"
        );
        assert_eq!(data.get("event_count").unwrap().as_u64().unwrap(), 5);
        assert_eq!(data.get("unique_title_count").unwrap().as_u64().unwrap(), 3); // alpha / beta / alpha-override
        assert_eq!(data.get("custom_title_count").unwrap().as_u64().unwrap(), 1);
        assert_eq!(data.get("ai_title_count").unwrap().as_u64().unwrap(), 4);
        assert_eq!(
            data.get("title_changes_count").unwrap().as_u64().unwrap(),
            2
        ); // 3 unique - 1 first
           // current_title: highest-precedence 末次 → records.rev().find("custom-title") = "alpha-override"
        assert_eq!(
            data.get("current_title").unwrap().as_str().unwrap(),
            "alpha-override"
        );
        assert_eq!(
            data.get("first_seen_title").unwrap().as_str().unwrap(),
            "alpha"
        );
        // duration_ms = 5000 - 1000 = 4000
        assert_eq!(data.get("duration_ms").unwrap().as_u64().unwrap(), 4000);
        assert_eq!(data.get("first_event_at").unwrap().as_u64().unwrap(), 1000);
        assert_eq!(data.get("last_event_at").unwrap().as_u64().unwrap(), 5000);

        // buckets: 5 records → 5 buckets (clamp(1, 60)=5, base_size=1, extra=0)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 5);

        // title_timeline: 按 first_seen 升序 → alpha (idx=0), beta (idx=1), alpha-override (idx=3)
        let timeline = data.get("title_timeline").unwrap().as_array().unwrap();
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0].get("title").unwrap().as_str().unwrap(), "alpha");
        assert_eq!(
            timeline[0]
                .get("first_seen_index")
                .unwrap()
                .as_u64()
                .unwrap(),
            0
        );
        assert_eq!(
            timeline[2].get("title").unwrap().as_str().unwrap(),
            "alpha-override"
        );
        assert_eq!(
            timeline[2].get("raw_type").unwrap().as_str().unwrap(),
            "custom-title"
        );

        // top_titles: top 10 by event count → alpha (3), beta (1), alpha-override (1)
        let top = data.get("top_titles").unwrap().as_array().unwrap();
        assert_eq!(top.len(), 3);
        assert_eq!(top[0].get("title").unwrap().as_str().unwrap(), "alpha");
        assert_eq!(top[0].get("event_count").unwrap().as_u64().unwrap(), 3);

        // payload.raw_events: 5 records → 全 5 个 (≤ 10 阈值)
        let payload = data.get("payload").unwrap().as_object().unwrap();
        let raw = payload.get("raw_events").unwrap().as_array().unwrap();
        assert_eq!(raw.len(), 5);
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 5);
    }

    #[test]
    fn build_ai_title_chart_meta_top_10_truncation() {
        // 15 unique titles → top_titles 截断到 10
        let mut recs: Vec<AiTitleRecord> = Vec::new();
        for i in 0..15 {
            recs.push(AiTitleRecord {
                raw_type: "ai-title".to_string(),
                title: format!("title-{:02}", i),
                time: (i as u64) * 1000,
            });
        }
        let chart = build_ai_title_chart_meta(&recs, 0).unwrap();
        let data = &chart.blocks[0].data;
        assert_eq!(
            data.get("unique_title_count").unwrap().as_u64().unwrap(),
            15
        );
        let top = data.get("top_titles").unwrap().as_array().unwrap();
        assert_eq!(top.len(), 10); // 截断
        let timeline = data.get("title_timeline").unwrap().as_array().unwrap();
        assert_eq!(timeline.len(), 15); // timeline 不截断
    }

    #[test]
    fn build_ai_title_chart_meta_raw_events_head_and_tail() {
        // 20 records → payload.raw_events 前 5 + 后 5
        let mut recs: Vec<AiTitleRecord> = Vec::new();
        for i in 0..20 {
            recs.push(AiTitleRecord {
                raw_type: "ai-title".to_string(),
                title: format!("t-{:02}", i),
                time: (i as u64) * 1000,
            });
        }
        let chart = build_ai_title_chart_meta(&recs, 0).unwrap();
        let payload = chart.blocks[0]
            .data
            .get("payload")
            .unwrap()
            .as_object()
            .unwrap();
        let raw = payload.get("raw_events").unwrap().as_array().unwrap();
        assert_eq!(raw.len(), 10);
        // head 第一个是 t-00, tail 最后一个是 t-19
        assert_eq!(raw[0].get("aiTitle").unwrap().as_str().unwrap(), "t-00");
        assert_eq!(raw[9].get("aiTitle").unwrap().as_str().unwrap(), "t-19");
    }

    #[test]
    fn normalize_session_aggregates_ai_title_into_chart_meta() {
        // 集成: 走 normalize_session batch 入口,验证 ai-title 不 inline emit
        // + custom-title 也不 inline emit + 末尾 1 个 chart meta
        let records = vec![
            json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
            json!({ "type": "ai-title", "aiTitle": "session-A" }),
            json!({ "type": "assistant", "uuid": "a1", "message": { "role": "assistant", "content": [{ "type": "text", "text": "ok" }] } }),
            json!({ "type": "ai-title", "aiTitle": "session-A" }),
            json!({ "type": "custom-title", "title": "manual-name" }),
            json!({ "type": "ai-title", "aiTitle": "session-B" }),
        ];
        let messages = normalize_session(records);
        // user + assistant + chart meta = 3
        // (4 ai-title/custom-title 都聚合进 chart meta, 不单独 emit)
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[2].role, "meta");
        assert_eq!(
            messages[2].blocks[0]
                .data
                .get("label")
                .unwrap()
                .as_str()
                .unwrap(),
            "ai-title.chart"
        );
        assert_eq!(
            messages[2].blocks[0]
                .data
                .get("event_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            4 // 2× ai-title "session-A" + 1 custom-title + 1× ai-title "session-B"
        );
        assert_eq!(
            messages[2].blocks[0]
                .data
                .get("current_title")
                .unwrap()
                .as_str()
                .unwrap(),
            "manual-name" // custom-title 优先级最高
        );
        assert_eq!(
            messages[2].blocks[0]
                .data
                .get("unique_title_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            3 // session-A, session-B, manual-name
        );
    }

    #[test]
    fn normalize_session_no_ai_title_records_no_chart_meta() {
        // 没 ai-title / custom-title → 不 emit chart meta (跟 v0.9.14/15/16 同 pattern)
        let records = vec![
            json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
            json!({ "type": "assistant", "uuid": "a1", "message": { "role": "assistant", "content": [{ "type": "text", "text": "ok" }] } }),
        ];
        let messages = normalize_session(records);
        assert_eq!(messages.len(), 2);
        // 没有 ai-title.chart
        for m in &messages {
            assert_ne!(
                m.blocks[0]
                    .data
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                "ai-title.chart"
            );
        }
    }

    // v0.9.29 (privacy): fixture-driven test removed — real user session
    // fixture contained sensitive project data. ai-title chart
    // aggregation is covered by `build_ai_title_chart_meta_*` unit
    // tests (inline synthetic data) further above.
}
