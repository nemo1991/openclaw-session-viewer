//! 子代理命令

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::error::AppResult;
use crate::fs::walker;
use crate::model::{SubagentMeta, SubagentSummary};

/// 列出某个会话下的所有子代理
///
/// v0.5.0:除基础信息外,还从 .meta.json 提取 agentType/description/toolUseId,
/// 并扫描子 jsonl 头部 200 行提取 message_count / first_timestamp / last_timestamp。
///
/// v0.6.0:同时从 .meta.json 提取 spawnDepth(递归子代理层级)。
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
        let (agent_type, description, spawn_depth) = match &meta {
            Some(m) => (
                m.get("agentType")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                m.get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                m.get("spawnDepth")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32),
            ),
            None => (None, None, None),
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
            spawn_depth,
            message_count,
            first_timestamp,
            last_timestamp,
        });
    }
    Ok(out)
}

/// v0.6.0: 获取单个子代理的摘要(消息数 + 工具分布 + 时间)
/// 在 Agent 卡片内嵌展开时调用,避免前端 navigate 跳走。
#[tauri::command]
pub async fn get_subagent_summary(
    session_dir: String,
    agent_id: String,
) -> AppResult<Option<SubagentSummary>> {
    let dir = Path::new(&session_dir);
    let subagent_dir = dir.join("subagents");
    if !subagent_dir.exists() {
        return Ok(None);
    }
    // agent_id 形如 "a1d924c..." → 文件名 "agent-a1d924c...jsonl"
    let jsonl_path = subagent_dir.join(format!("agent-{}.jsonl", agent_id));
    if !jsonl_path.exists() {
        return Ok(None);
    }
    let meta_path = subagent_dir.join(format!("agent-{}.meta.json", agent_id));
    let meta = if meta_path.exists() {
        std::fs::read_to_string(&meta_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    } else {
        None
    };
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

    // 扫头部 500 行拿摘要(子 session 单个文件通常 < 2000 行,500 够覆盖 80% case)
    let (message_count, tool_distribution, first_timestamp, last_timestamp) =
        scan_jsonl_summary(&jsonl_path, 500);

    let duration_seconds = match (&first_timestamp, &last_timestamp) {
        (Some(f), Some(l)) => {
            // ISO 8601 简单差值,失败返回 None
            chrono::DateTime::parse_from_rfc3339(l)
                .ok()
                .zip(chrono::DateTime::parse_from_rfc3339(f).ok())
                .and_then(|(l_dt, f_dt)| (l_dt - f_dt).to_std().ok())
                .map(|d| d.as_secs())
        }
        _ => None,
    };

    Ok(Some(SubagentSummary {
        agent_id,
        description,
        agent_type,
        message_count: if message_count > 0 {
            Some(message_count)
        } else {
            None
        },
        tool_distribution,
        first_timestamp,
        last_timestamp,
        duration_seconds,
    }))
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

/// v0.6.0: 扫描 jsonl 前 N 行,统计消息数 + tool_use.name 分布
///
/// 返回 (message_count, Vec<(name, count)>, first_timestamp, last_timestamp)
type ScanSummary = (u32, Vec<(String, u32)>, Option<String>, Option<String>);

fn scan_jsonl_summary(path: &Path, max_lines: usize) -> ScanSummary {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, vec![], None, None),
    };
    let reader = BufReader::new(file);
    let mut count: u32 = 0;
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    let mut tool_counts: HashMap<String, u32> = HashMap::new();

    for line in reader.lines().take(max_lines).flatten() {
        let val: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // timestamp
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

        // type
        let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if ty == "user" || ty == "assistant" || ty == "message" {
            count += 1;
        }

        // tool_use.name 分布: 扫 content 块
        if let Some(content) = val
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            for block in content {
                if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                    if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                        *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    // 按 count desc, name asc 排序
    let mut tool_pairs: Vec<(String, u32)> = tool_counts.into_iter().collect();
    tool_pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    (count, tool_pairs, first, last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("create tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f
    }

    #[test]
    fn scan_jsonl_summary_empty_file() {
        let f = write_temp("");
        let (count, tools, _, _) = scan_jsonl_summary(f.path(), 500);
        assert_eq!(count, 0);
        assert!(tools.is_empty());
    }

    #[test]
    fn scan_jsonl_summary_counts_single_tool() {
        // 1 assistant message with 1 tool_use
        let jsonl = r#"{"type":"assistant","timestamp":"2026-06-29T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","id":"call_1","input":{"file_path":"/tmp/x"}}]}}"#;
        let f = write_temp(jsonl);
        let (count, tools, first, last) = scan_jsonl_summary(f.path(), 500);
        assert_eq!(count, 1);
        assert_eq!(tools, vec![("Read".to_string(), 1)]);
        assert_eq!(first.as_deref(), Some("2026-06-29T10:00:00Z"));
        assert_eq!(last.as_deref(), Some("2026-06-29T10:00:00Z"));
    }

    #[test]
    fn scan_jsonl_summary_mixed_tools_sorted() {
        // 1 user + 1 assistant with 2 Bash + 1 Read
        let jsonl = r#"{"type":"user","timestamp":"2026-06-29T10:00:00Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","timestamp":"2026-06-29T10:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","id":"c1","input":{}},{"type":"tool_use","name":"Read","id":"c2","input":{}},{"type":"tool_use","name":"Bash","id":"c3","input":{}}]}}"#;
        let f = write_temp(jsonl);
        let (count, tools, first, last) = scan_jsonl_summary(f.path(), 500);
        assert_eq!(count, 2);
        // 排序: Bash 2 次 > Read 1 次
        assert_eq!(
            tools,
            vec![("Bash".to_string(), 2), ("Read".to_string(), 1)]
        );
        assert_eq!(first.as_deref(), Some("2026-06-29T10:00:00Z"));
        assert_eq!(last.as_deref(), Some("2026-06-29T10:00:05Z"));
    }
}
