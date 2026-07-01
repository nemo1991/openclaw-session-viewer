//! JSONL → SessionGraph 解析
//!
//! S0 阶段:流式 BufReader 64KB,逐行 `serde_json::from_str` 拿到 `Value`,
//! 然后提取 SessionNode + Edges。
//!
//! 关键设计:
//! - 不依赖 main 内部 crate,独立走 `serde_json::Value` 路径
//! - 字段提取用 `obj.get("...").and_then(|v| v.as_str())` 等
//! - 容错:任何单行 parse 失败时 `continue`,不污染整个 session

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::graph::{Edge, SessionGraph, SessionNode, Source};

/// 解析单个 JSONL 文件为 SessionGraph
pub fn parse_session(jsonl_path: &Path) -> Result<SessionGraph> {
    let file = fs::File::open(jsonl_path)
        .with_context(|| format!("open {}", jsonl_path.display()))?;
    let reader = BufReader::with_capacity(64 * 1024, file);

    let mut state = SessionState::default();
    let mut message_count = 0u64;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        state.observe(&v);
        message_count += 1;
    }

    // S0.5: 找 sibling `<stem>/subagents/agent-*.jsonl`
    //
    // Claude 实际布局:
    //   projects/<encoded-cwd>/<uuid>.jsonl          (parent session, file)
    //   projects/<encoded-cwd>/<uuid>/subagents/      (sibling dir!)
    //   projects/<encoded-cwd>/<uuid>/subagents/agent-<id>.jsonl
    //
    // 所以要从 jsonl_path 推:
    //   parent.jsonl_path = `projects/<encoded-cwd>/<uuid>.jsonl`
    //   sibling_dir       = `projects/<encoded-cwd>/<uuid>`
    // 实现:用 stem 当作 dir 名拼 sibling
    if let Some(stem) = jsonl_path.file_stem().and_then(|s| s.to_str()) {
        if let Some(grand_parent) = jsonl_path.parent() {
            let sibling_dir = grand_parent.join(stem).join("subagents");
            if sibling_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&sibling_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                        if name.starts_with("agent-") && p.extension().map(|e| e == "jsonl").unwrap_or(false) {
                            let id = name.trim_end_matches(".jsonl").to_string();
                            if !state.subagent_ids.contains(&id) {
                                state.subagent_ids.push(id);
                            }
                        }
                    }
                }
            }
        }
    }

    let metadata = fs::metadata(jsonl_path)?;
    let source = Source::from_path(jsonl_path).unwrap_or(Source::Claude);

    let node_id = stable_node_id(jsonl_path);

    let node = SessionNode {
        node_id,
        source,
        session_id: state.session_id.clone().unwrap_or_else(|| {
            jsonl_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string()
        }),
        workspace: state.workspace,
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        mtime_ms: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        first_prompt: state.first_prompt.map(|s| truncate(&s, 200)),
        first_timestamp_ms: state.first_timestamp_ms,
        last_timestamp_ms: state.last_timestamp_ms,
        token_total: state.token_total,
        subagent_count: state.subagent_ids.len() as u32,
        subagent_ids: state.subagent_ids.clone(),
        is_subagent_root: state.is_sidechain_seen.unwrap_or(false),
        parent_session_id: state.parent_session_id,
        message_count,
    };

    let mut edges: Vec<Edge> = vec![];

    // Spawned 边:对每个 subagent_id
    for sa_id in &state.subagent_ids {
        edges.push(Edge::Spawned {
            from_session: node.node_id.clone(),
            to_subagent_id: sa_id.clone(),
            to_subagent_path: jsonl_path
                .parent()
                .map(|p| p.join("subagents").join(format!("{sa_id}.jsonl")).to_string_lossy().to_string())
                .unwrap_or_default(),
        });
    }
    // UsedTool 边:把 tool_counts 摊开
    for (name, count) in &state.tool_counts {
        edges.push(Edge::UsedTool {
            session: node.node_id.clone(),
            tool_name: name.clone(),
            count: *count,
        });
    }
    // AttemptedFix 边:有错才出
    if state.error_count > 0 {
        edges.push(Edge::AttemptedFix {
            session: node.node_id.clone(),
            error_count: state.error_count,
        });
    }
    // CrossSession 边 — 在 node 里已经 move 过 parent_session_id,这里从局部 mirror 读
    if let Some(parent) = node.parent_session_id.clone() {
        edges.push(Edge::CrossSession {
            parent,
            child: node.node_id.clone(),
        });
    }

    Ok(SessionGraph { node, edges })
}

/// 从一个 JSONL 文件路径生成稳定 node_id
/// 用 sha256 不是必须 — 路径去斜杠已经够稳,直接 hash
fn stable_node_id(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    // 取最后的相对路径段做 ID,避免暴露绝对路径
    let trimmed = s
        .split("/.claude/")
        .last()
        .or_else(|| s.split("/.openclaw/").last())
        .unwrap_or(&s);
    format!("node:{trimmed}")
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// 单 session 解析时累积的所有 state
#[derive(Default)]
struct SessionState {
    session_id: Option<String>,
    workspace: Option<String>,
    first_prompt: Option<String>,
    first_timestamp_ms: Option<i64>,
    last_timestamp_ms: Option<i64>,
    token_total: u64,
    subagent_ids: Vec<String>,
    is_sidechain_seen: Option<bool>,
    parent_session_id: Option<String>,
    tool_counts: HashMap<String, u64>,
    error_count: u64,
}

impl SessionState {
    fn observe(&mut self, v: &Value) {
        // sessionId
        if self.session_id.is_none() {
            if let Some(s) = v.get("sessionId").and_then(|x| x.as_str()) {
                self.session_id = Some(s.to_string());
            }
        }
        // timestamp
        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
            if let Ok(d) = chrono::DateTime::parse_from_rfc3339(ts) {
                let ms = d.timestamp_millis();
                self.first_timestamp_ms.get_or_insert(ms);
                self.last_timestamp_ms = Some(ms);
            }
        }
        // cwd (Claude envelope)
        if self.workspace.is_none() {
            if let Some(s) = v.get("cwd").and_then(|x| x.as_str()) {
                self.workspace = Some(s.to_string());
            }
        }
        // parent session (OpenClaw sessions.json style might have parent field)
        if self.parent_session_id.is_none() {
            if let Some(s) = v.get("parentSessionId").and_then(|x| x.as_str()) {
                self.parent_session_id = Some(s.to_string());
            }
        }
        // isSidechain
        if let Some(b) = v.get("isSidechain").and_then(|x| x.as_bool()) {
            if b {
                self.is_sidechain_seen = Some(true);
            }
        }
        // first user prompt (取顶层 type=user 的首条 message.content 的 text)
        // 支持 message.content 是字符串(简化的 fixture 格式)或数组(真实 Claude 数据)
        if self.first_prompt.is_none() {
            let is_user = v
                .get("type")
                .and_then(|t| t.as_str())
                .map(|t| t == "user")
                .unwrap_or(false);
            if is_user {
                let content = v.get("message").and_then(|m| m.get("content"));
                let text_opt = match content {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .find(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .and_then(|item| item.get("text"))
                        .and_then(|t| t.as_str())
                        .map(String::from),
                    _ => None,
                };
                if let Some(text) = text_opt {
                    self.first_prompt = Some(text);
                }
            }
        }
        // token usage (assistant message.message.usage)
        if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
            for key in ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] {
                if let Some(n) = usage.get(key).and_then(|x| x.as_u64()) {
                    self.token_total = self.token_total.saturating_add(n);
                }
            }
        }
        // tool_use counts
        if let Some(arr) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            for item in arr {
                if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    if let Some(name) = item.get("name").and_then(|x| x.as_str()) {
                        *self.tool_counts.entry(name.to_string()).or_insert(0) += 1;
                    }
                }
                // tool_result is_error
                if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    if item.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) {
                        self.error_count += 1;
                    }
                }
            }
        }
        // subagent dir parse (Claude 把 subagents/ 子目录写入)
        if let Some(subagents) = v.get("subagents").and_then(|x| x.as_array()) {
            for sa in subagents {
                if let Some(id) = sa.get("agentId").and_then(|x| x.as_str()) {
                    let id = id.to_string();
                    if !self.subagent_ids.contains(&id) {
                        self.subagent_ids.push(id);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_jsonl(jsonl: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "{}", jsonl.lines().collect::<Vec<_>>().join("\n")).unwrap();
        f
    }

    #[test]
    fn parses_basic_claude_session() {
        let f = write_jsonl(
            r#"
{"type":"user","sessionId":"abc","timestamp":"2026-06-29T10:00:00Z","cwd":"/Users/x/proj","message":{"role":"user","content":[{"type":"text","text":"hello world"}]}}
{"type":"assistant","sessionId":"abc","timestamp":"2026-06-29T10:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"file-history-snapshot","message":{"content":[]}}
"#,
        );
        let g = parse_session(f.path()).unwrap();
        assert_eq!(g.node.session_id, "abc");
        assert_eq!(g.node.workspace.as_deref(), Some("/Users/x/proj"));
        assert_eq!(g.node.first_prompt.as_deref(), Some("hello world"));
        assert_eq!(g.node.token_total, 15);
        assert_eq!(g.node.message_count, 3);
        // 1 UsedTool edge
        assert!(g.edges.iter().any(|e| matches!(e, Edge::UsedTool { tool_name, count, .. } if tool_name == "Bash" && *count == 1)));
    }

    #[test]
    fn aggregates_tools() {
        let f = write_jsonl(
            r#"
{"sessionId":"abc","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a"}},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"sessionId":"abc","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/b"}}]}}
"#,
        );
        let g = parse_session(f.path()).unwrap();
        let reads: u64 = g.edges.iter().filter_map(|e| match e {
            Edge::UsedTool { tool_name, count, .. } if tool_name == "Read" => Some(*count),
            _ => None,
        }).sum();
        assert_eq!(reads, 2);
    }

    #[test]
    fn counts_errors() {
        let f = write_jsonl(
            r#"
{"sessionId":"abc","message":{"role":"user","content":[{"type":"tool_result","content":"oops","is_error":true}]}}
{"sessionId":"abc","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}
"#,
        );
        let g = parse_session(f.path()).unwrap();
        assert!(g.edges.iter().any(|e| matches!(e, Edge::AttemptedFix { error_count: 1, .. })));
    }
}
