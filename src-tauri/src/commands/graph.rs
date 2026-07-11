//! v0.8.5 C: graph 数据源从 NDJSON 切到 session_meta DB
//!
//! 提供 `list_graph` command, 返回 `Vec<GraphEntry>` (从 session_meta JOIN 派生)。
//!
//! v0.8.5 范围:
//! - node 字段全部从 session_meta 派生 (含 firstPrompt, lastMessageAt 等)
//! - UsedTool edges 从 session_meta.tool_usage_json 派生 (item 2' 固化数据)
//!
//! v0.8.6+ 后续补完:
//! - Spawned / ParentUuid / AttemptedFix / CrossSession edges
//! - is_subagent_root / parent_session_id 派生 (需要 subagent 关联扫描)
//! - assistant_text_snippets (RAG 用的 top 3 文本块)
//!
//! v0.8.7 B: CrossSession edges 派生 — 两遍扫:
//!   1) 第一遍: 收集所有 session_id (HashSet) + 反向 map subagent_id → parent_session_id
//!   2) 第二遍: 对每行:
//!      - 如果此 session_id 在反向 map 中 → is_subagent_root=true, parent_session_id=that parent
//!      - 对此 session 的 subagent_ids 中, 如果某个 id 也是 session_id → emit CrossSession edge

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GraphNodeFE {
    pub node_id: String,
    pub source: String, // "Claude" | "OpenClaw"
    pub session_id: String,
    pub workspace: Option<String>,
    pub jsonl_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub first_prompt: Option<String>,
    pub first_timestamp_ms: Option<i64>,
    pub last_timestamp_ms: Option<i64>,
    pub token_total: u64,
    pub thinking_count: u32,
    pub primary_model: Option<String>,
    pub top_tools: Vec<String>,
    pub error_count: u32,
    pub subagent_count: u32,
    pub subagent_ids: Vec<String>,
    pub is_subagent_root: bool,
    pub parent_session_id: Option<String>,
    pub message_count: u32,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EdgeFE {
    UsedTool {
        session: String,
        tool_name: String,
        count: u32,
    },
    /// v0.8.6 A: session.error_count > 0 → AttemptedFix edge
    AttemptedFix { session: String, error_count: u32 },
    /// v0.8.6 A: session.subagent_count > 0 → N 个 Spawned edges
    /// (from_session 派 subagent_id; to_subagent_path 暂时 None — subagent
    /// 文件路径需要 subagents/ 关联, 留 v0.8.7)
    Spawned {
        from_session: String,
        to_subagent_id: String,
        to_subagent_path: Option<String>,
        description: Option<String>,
    },
    /// v0.8.7 A: 该 session 每个 parent_uuid 派生一个 edge
    /// (session 内 message 引用了哪条 — 跨 session 关联可视化)
    ParentUuid { session: String, uuid: String },
    /// v0.8.7 B: 该 session 的 subagent_id 之一同时也是 session_meta 里的 session_id
    /// (即: 子代理自己也是个独立 session, 不只是 main 的附属 jsonl)
    /// parent=main session, child=subagent session
    CrossSession { parent: String, child: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEntryFE {
    pub node: GraphNodeFE,
    pub edges: Vec<EdgeFE>,
}

#[derive(serde::Deserialize)]
struct TokenUsageFE {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// ===== v0.8.7 B: CrossSession 派生辅助 =====

/// CrossSession 派生用的索引 — 给单元测试用, 跟 list_graph 内部逻辑一致
#[derive(Debug, Default, Clone)]
pub(crate) struct SessionIndex {
    /// 全部 session_id (给 CrossSession 派生用)
    pub all_session_ids: HashSet<String>,
    /// subagent_id → 第一个 parent_session_id (反向 map, 给 is_subagent_root 用)
    pub subagent_to_parent: HashMap<String, String>,
}

impl SessionIndex {
    /// 从 `(session_id, subagent_ids_json)` 列表构建
    pub fn build(pairs: &[(String, Option<String>)]) -> Self {
        let mut all_session_ids = HashSet::new();
        let mut subagent_to_parent = HashMap::new();
        for (sid, sub_json) in pairs {
            all_session_ids.insert(sid.clone());
            if let Some(json) = sub_json {
                if let Ok(subs) = serde_json::from_str::<Vec<String>>(json) {
                    for s in subs {
                        subagent_to_parent.entry(s).or_insert(sid.clone());
                    }
                }
            }
        }
        SessionIndex {
            all_session_ids,
            subagent_to_parent,
        }
    }
}

/// v0.8.7 B: 给定一个 session 的 subagent_ids, 派生 CrossSession edges
pub(crate) fn derive_cross_session_edges(
    session_id: &str,
    subagent_ids: &[String],
    index: &SessionIndex,
) -> Vec<EdgeFE> {
    let mut out = Vec::new();
    for sub_id in subagent_ids {
        if index.all_session_ids.contains(sub_id) && sub_id != session_id {
            out.push(EdgeFE::CrossSession {
                parent: session_id.to_string(),
                child: sub_id.clone(),
            });
        }
    }
    out
}

/// v0.8.7 B: 给定一个 session, 反向查是否被某个 main 列为 subagent
pub(crate) fn derive_subagent_root(
    session_id: &str,
    index: &SessionIndex,
) -> (bool, Option<String>) {
    index
        .subagent_to_parent
        .get(session_id)
        .map(|p| (true, Some(p.clone())))
        .unwrap_or((false, None))
}

#[tauri::command]
pub async fn list_graph(state: State<'_, AppState>) -> AppResult<Vec<GraphEntryFE>> {
    // v0.8.7 C: 纯读, 走 reader pool (跟其它读并发不互锁)
    state.db.with_read(|c| {
        // === v0.8.7 B: 第一遍扫 — 收集所有 session_id + 反向 subagent map ===
        // 给 CrossSession edges + is_subagent_root 派生用
        let index: SessionIndex = {
            let mut id_stmt =
                c.prepare("SELECT session_id, subagent_ids_json FROM session_meta")?;
            let id_rows = id_stmt.query_map([], |r| {
                let sid: String = r.get(0)?;
                let sub_json: Option<String> = r.get(1)?;
                Ok((sid, sub_json))
            })?;
            let pairs: Result<Vec<_>, _> = id_rows.collect();
            SessionIndex::build(&pairs?)
        };

        let mut stmt = c.prepare(
            "SELECT session_id, project_key, source, jsonl_path, size_bytes, mtime_ms,
                    first_timestamp, last_timestamp, message_count, thinking_count,
                    tool_use_count, top_tools_json, total_tokens_json, primary_model,
                    error_count, subagent_count, subagent_ids_json, first_prompt, agent_id,
                    tool_usage_json, parent_uuids_text
             FROM session_meta
             ORDER BY mtime_ms DESC",
        )?;

        let rows: Vec<GraphEntryFE> = stmt
            .query_map([], |r| {
                let session_id: String = r.get(0)?;
                let source_raw: String = r.get(2)?;
                let source = if source_raw == "claude" {
                    "Claude"
                } else {
                    "OpenClaw"
                };

                let first_ts: Option<String> = r.get(6)?;
                let last_ts: Option<String> = r.get(7)?;
                let first_ts_ms = first_ts.as_deref().and_then(parse_iso_ms);
                let last_ts_ms = last_ts.as_deref().and_then(parse_iso_ms);

                let top_tools_json: Option<String> = r.get(11)?;
                let top_tools: Vec<String> = top_tools_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    .unwrap_or_default();

                let total_tokens_json: Option<String> = r.get(12)?;
                let token_total: u64 = total_tokens_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<TokenUsageFE>(s).ok())
                    .map(|t| t.input + t.output + t.cache_read + t.cache_write)
                    .unwrap_or(0);

                let subagent_ids_json: Option<String> = r.get(17)?;
                let subagent_ids: Vec<String> = subagent_ids_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    .unwrap_or_default();
                // v0.8.6 A: 提前读 error_count / subagent_count 给 edges 派生用
                let error_count: u32 = r.get::<_, i64>(14)? as u32;
                // 用完 subagent_count 立即释放 borrow
                let subagent_count: u32 = r.get::<_, i64>(15)? as u32;
                let _ = subagent_count; // 只在 node 用

                // v0.8.7 B: 反向 map — 此 session 是否是某个 main 的 subagent
                let (is_subagent_root, parent_session_id) =
                    derive_subagent_root(&session_id, &index);

                let node = GraphNodeFE {
                    node_id: session_id.clone(),
                    source: source.to_string(),
                    session_id: session_id.clone(),
                    workspace: r.get(1)?,
                    jsonl_path: r.get(3)?,
                    size_bytes: r.get::<_, i64>(4)? as u64,
                    mtime_ms: r.get::<_, i64>(5)? as u64,
                    first_prompt: r.get(18)?,
                    first_timestamp_ms: first_ts_ms,
                    last_timestamp_ms: last_ts_ms,
                    token_total,
                    thinking_count: r.get::<_, i64>(9)? as u32,
                    primary_model: r.get(13)?,
                    top_tools,
                    error_count,
                    subagent_count,
                    subagent_ids: subagent_ids.clone(), // v0.8.6 A: edges 派生也要用
                    is_subagent_root,                   // v0.8.7 B: 反向 map 派生
                    parent_session_id,                  // v0.8.7 B: 反向 map 派生
                    message_count: r.get::<_, i64>(8)? as u32,
                    agent_id: r.get(19)?,
                };

                // UsedTool edges 派生 from tool_usage_json: [["Bash", 286], ...]
                let tool_usage_json: Option<String> = r.get(20)?;
                let mut edges: Vec<EdgeFE> = Vec::new();
                if let Some(json) = tool_usage_json {
                    if let Ok(usage) = serde_json::from_str::<Vec<(String, u32)>>(&json) {
                        for (tool_name, count) in usage {
                            edges.push(EdgeFE::UsedTool {
                                session: session_id.clone(),
                                tool_name,
                                count,
                            });
                        }
                    }
                }

                // v0.8.6 A: AttemptedFix — error_count > 0 时派生
                if error_count > 0 {
                    edges.push(EdgeFE::AttemptedFix {
                        session: session_id.clone(),
                        error_count,
                    });
                }
                // v0.8.6 A: Spawned — 每个 subagent_id 派生一个 edge
                // (subagent_ids 来自 subagent_ids_json, SessionMeta 已经有)
                for sub_id in &subagent_ids {
                    edges.push(EdgeFE::Spawned {
                        from_session: session_id.clone(),
                        to_subagent_id: sub_id.clone(),
                        to_subagent_path: None, // v0.8.7+ 加 SessionSubagentMeta 表
                        description: None,
                    });
                }

                // v0.8.7 A: ParentUuid edges — 读 parent_uuids_text 列(newline-separated),
                // 每个 uuid 派生 1 个 edge 给 G1 跨 session 关联可视化
                let parent_uuids_text: Option<String> = r.get(21)?;
                if let Some(text) = parent_uuids_text {
                    for uuid in text.lines().filter(|l| !l.is_empty()) {
                        edges.push(EdgeFE::ParentUuid {
                            session: session_id.clone(),
                            uuid: uuid.to_string(),
                        });
                    }
                }

                // v0.8.7 B: CrossSession edges — subagent_id 命中 session_id 时派生
                // (子代理 jsonl 自己也作为独立 session 被 sync 进来)
                edges.extend(derive_cross_session_edges(
                    &session_id,
                    &subagent_ids,
                    &index,
                ));

                Ok(GraphEntryFE { node, edges })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // v0.8.7 B: SessionIndex::build — 基础构建 + 反向 map
    #[test]
    fn session_index_build_basic() {
        let pairs = vec![
            (
                "main-a".to_string(),
                Some(r#"["sub-x","sub-y"]"#.to_string()),
            ),
            ("main-b".to_string(), Some(r#"["sub-z"]"#.to_string())),
            ("orphan".to_string(), None),
        ];
        let idx = SessionIndex::build(&pairs);
        // all_session_ids
        assert_eq!(idx.all_session_ids.len(), 3);
        assert!(idx.all_session_ids.contains("main-a"));
        assert!(idx.all_session_ids.contains("orphan"));
        // 反向 map
        assert_eq!(
            idx.subagent_to_parent.get("sub-x"),
            Some(&"main-a".to_string())
        );
        assert_eq!(
            idx.subagent_to_parent.get("sub-y"),
            Some(&"main-a".to_string())
        );
        assert_eq!(
            idx.subagent_to_parent.get("sub-z"),
            Some(&"main-b".to_string())
        );
    }

    // v0.8.7 B: SessionIndex::build — 多个 main 引用同一 subagent_id 时, or_insert 取先看到的
    #[test]
    fn session_index_dedup_subagent_keeps_first_parent() {
        let pairs = vec![
            ("main-a".to_string(), Some(r#"["shared"]"#.to_string())),
            ("main-b".to_string(), Some(r#"["shared"]"#.to_string())),
        ];
        let idx = SessionIndex::build(&pairs);
        // 谁先谁赢 — 当前实现里遍历顺序 = 输入顺序 (main-a 优先)
        assert_eq!(
            idx.subagent_to_parent.get("shared"),
            Some(&"main-a".to_string())
        );
    }

    // v0.8.7 B: derive_cross_session_edges — subagent_id 命中 session_id 时派生
    #[test]
    fn derive_cross_session_edge_when_subagent_matches_session() {
        let pairs = vec![
            (
                "main-1".to_string(),
                Some(r#"["main-2","unrelated"]"#.to_string()),
            ),
            ("main-2".to_string(), None),
            ("main-3".to_string(), Some(r#"["main-1"]"#.to_string())),
        ];
        let idx = SessionIndex::build(&pairs);
        let subs = vec!["main-2".to_string(), "unrelated".to_string()];
        let edges = derive_cross_session_edges("main-1", &subs, &idx);
        // main-1 → main-2 派生, "unrelated" 不在 session_id 集合里跳过
        assert_eq!(edges.len(), 1);
        match &edges[0] {
            EdgeFE::CrossSession { parent, child } => {
                assert_eq!(parent, "main-1");
                assert_eq!(child, "main-2");
            }
            _ => panic!("expected CrossSession"),
        }
    }

    // v0.8.7 B: derive_cross_session_edges — subagent_id 等于自己时跳过
    #[test]
    fn derive_cross_session_skips_self_loop() {
        let pairs = vec![("main-1".to_string(), Some(r#"["main-1"]"#.to_string()))];
        let idx = SessionIndex::build(&pairs);
        let subs = vec!["main-1".to_string()];
        let edges = derive_cross_session_edges("main-1", &subs, &idx);
        // self-reference 不派生 (parent == child)
        assert!(edges.is_empty(), "self-loop should not emit edge");
    }

    // v0.8.7 B: derive_cross_session_edges — 完全没有命中时返回空
    #[test]
    fn derive_cross_session_no_match_returns_empty() {
        let pairs = vec![
            (
                "main-1".to_string(),
                Some(r#"["sub-x","sub-y"]"#.to_string()),
            ),
            ("main-2".to_string(), None),
        ];
        let idx = SessionIndex::build(&pairs);
        let subs = vec!["sub-x".to_string(), "sub-y".to_string()];
        let edges = derive_cross_session_edges("main-1", &subs, &idx);
        assert!(edges.is_empty());
    }

    // v0.8.7 B: derive_cross_session_edges — 多 subagent_id 同时命中
    #[test]
    fn derive_cross_session_multiple_matches() {
        let pairs = vec![
            (
                "main-1".to_string(),
                Some(r#"["sub-a","sub-b","sub-c"]"#.to_string()),
            ),
            ("sub-a".to_string(), None),
            ("sub-c".to_string(), None),
        ];
        let idx = SessionIndex::build(&pairs);
        let subs = vec![
            "sub-a".to_string(),
            "sub-b".to_string(),
            "sub-c".to_string(),
        ];
        let edges = derive_cross_session_edges("main-1", &subs, &idx);
        // 命中 sub-a + sub-c, 跳过 sub-b
        assert_eq!(edges.len(), 2);
        let children: Vec<&str> = edges
            .iter()
            .filter_map(|e| match e {
                EdgeFE::CrossSession { child, .. } => Some(child.as_str()),
                _ => None,
            })
            .collect();
        assert!(children.contains(&"sub-a"));
        assert!(children.contains(&"sub-c"));
        assert!(!children.contains(&"sub-b"));
    }

    // v0.8.7 B: derive_subagent_root — 反向 map 命中
    #[test]
    fn derive_subagent_root_when_in_reverse_map() {
        let pairs = vec![("main-1".to_string(), Some(r#"["sub-x"]"#.to_string()))];
        let idx = SessionIndex::build(&pairs);
        let (is_root, parent) = derive_subagent_root("sub-x", &idx);
        assert!(is_root);
        assert_eq!(parent, Some("main-1".to_string()));
    }

    // v0.8.7 B: derive_subagent_root — 不在反向 map 中
    #[test]
    fn derive_subagent_root_returns_false_when_orphan() {
        let pairs = vec![("main-1".to_string(), None)];
        let idx = SessionIndex::build(&pairs);
        let (is_root, parent) = derive_subagent_root("orphan", &idx);
        assert!(!is_root);
        assert!(parent.is_none());
    }

    // v0.8.7 B: 整合场景 — main-a 派 sub-x, sub-x 自己也作为 session 被 sync 进来
    #[test]
    fn integration_main_owns_subagent_that_is_also_session() {
        let pairs = vec![
            ("main-a".to_string(), Some(r#"["sub-x"]"#.to_string())),
            (
                "sub-x".to_string(),
                None, // sub-x 没有再派 subagent
            ),
        ];
        let idx = SessionIndex::build(&pairs);

        // main-a: 是 root, 不在反向 map 里
        let (is_root_a, parent_a) = derive_subagent_root("main-a", &idx);
        assert!(!is_root_a);
        assert!(parent_a.is_none());

        // main-a → CrossSession(sub-x) 派生
        let edges_a = derive_cross_session_edges("main-a", &["sub-x".to_string()], &idx);
        assert_eq!(edges_a.len(), 1);
        match &edges_a[0] {
            EdgeFE::CrossSession { parent, child } => {
                assert_eq!(parent, "main-a");
                assert_eq!(child, "sub-x");
            }
            _ => panic!("expected CrossSession"),
        }

        // sub-x: 是 subagent root, parent=main-a
        let (is_root_x, parent_x) = derive_subagent_root("sub-x", &idx);
        assert!(is_root_x);
        assert_eq!(parent_x, Some("main-a".to_string()));

        // sub-x 没 subagent, 无 CrossSession edge 派生
        let edges_x = derive_cross_session_edges("sub-x", &[], &idx);
        assert!(edges_x.is_empty());
    }
}
