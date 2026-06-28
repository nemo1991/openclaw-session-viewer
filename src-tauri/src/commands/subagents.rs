//! 子代理命令

use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::error::AppResult;
use crate::fs::walker;
use crate::model::SubagentMeta;

/// 列出某个会话下的所有子代理
///
/// v0.5.0:除基础信息外,还从 .meta.json 提取 agentType/description/toolUseId,
/// 并扫描子 jsonl 头部 200 行提取 message_count / first_timestamp / last_timestamp。
#[tauri::command]
pub async fn list_subagents(session_dir: String) -> AppResult<Vec<SubagentMeta>> {
    let dir = Path::new(&session_dir);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let subagent_dir = dir.join("subagents");
    if !subagent_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = walker::list_jsonl_files(&subagent_dir).unwrap_or_default();
    for jsonl_path in entries {
        let stem = jsonl_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // 文件名形如 agent-<id>
        let agent_id = stem.strip_prefix("agent-").unwrap_or(&stem).to_string();
        let meta_path = subagent_dir.join(format!("{}.meta.json", stem));
        let meta = if meta_path.exists() {
            std::fs::read_to_string(&meta_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        } else {
            None
        };

        // 从 .meta.json 提取标准化字段
        let (agent_type, description) = match &meta {
            Some(m) => (
                m.get("agentType")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                m.get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            ),
            None => (None, None),
        };

        // 扫描 jsonl 头部 200 行,提取 message_count + 时间戳
        // (200 行 ≈ 几 ms,只在用户点开 SubagentPanel 时触发)
        let (message_count, first_timestamp, last_timestamp) = scan_jsonl_header(&jsonl_path, 200);

        out.push(SubagentMeta {
            agent_id,
            jsonl_path: jsonl_path.to_string_lossy().to_string(),
            meta_path: meta_path.to_string_lossy().to_string(),
            meta,
            agent_type,
            description,
            message_count,
            first_timestamp,
            last_timestamp,
        });
    }
    Ok(out)
}

/// 扫描 jsonl 文件前 N 行,提取消息数和首末 timestamp
///
/// 不做完整 normalize — 只浅扫 envelope.timestamp + envelope.message.id。
/// 返回 (message_count, first_timestamp, last_timestamp)。
fn scan_jsonl_header(
    path: &Path,
    max_lines: usize,
) -> (Option<u32>, Option<String>, Option<String>) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None, None),
    };
    let reader = BufReader::new(file);
    let mut count: u32 = 0;
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    for line in reader.lines().take(max_lines).flatten() {
        let val: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Claude envelope: type/message/timestamp 在顶层;OpenClaw 也类似
        let ts = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from);
        if first.is_none() {
            first = ts.clone();
        }
        if ts.is_some() {
            last = ts;
        }
        // 排除 meta 行(mode/permission/title/last-prompt 等),只数消息
        let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty == "message" || ty == "user" || ty == "assistant" {
            count += 1;
        }
    }
    (if count > 0 { Some(count) } else { None }, first, last)
}
