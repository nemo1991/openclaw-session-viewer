//! 子代理命令

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Arc;

use tauri::State;

#[cfg(test)]
use crate::error::AppError;
use crate::error::AppResult;
use crate::fs::paths::{self, AppPaths};
use crate::fs::walker;
use crate::model::{SubagentMeta, SubagentSummary};
use crate::AppState;

/// v0.8.14 item B: 单文件大小上限 50 MB — 防恶意 / 损坏 jsonl
/// 让 scan_jsonl_summary / read_to_string 一次性吞 4GB 内存。
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;
/// 同样为 .meta.json 设上限(正常 < 4 KB,1 MB 已经是非常宽松的兜底)
const MAX_META_FILE_SIZE: u64 = 1024 * 1024;

/// agent_id 仅允许 ASCII 字母 / 数字 / `-` / `_`,防止
/// `agent-../etc` 这种 traversal 后逃出 subagents/ 子目录。
fn sanitize_agent_id(agent_id: &str) -> Option<&str> {
    if agent_id.is_empty() {
        return None;
    }
    if agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(agent_id)
    } else {
        None
    }
}

/// 列出某个会话下的所有子代理
///
/// v0.5.0:除基础信息外,还从 .meta.json 提取 agentType/description/toolUseId,
/// 并扫描子 jsonl 头部 200 行提取 message_count / first_timestamp / last_timestamp。
///
/// v0.6.0:同时从 .meta.json 提取 spawnDepth(递归子代理层级)。
///
/// v0.8.14 item B: 加 assert_within_any_root 路径安全检查 + 单文件 size cap
/// + meta.json panic catch。跟其他 file-touching Tauri command 对齐。
#[tauri::command]
pub async fn list_subagents(
    session_dir: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<SubagentMeta>> {
    list_subagents_inner(Path::new(&session_dir), &state.paths.read())
}

/// v0.8.14 item B: state-independent body — 可测。
pub(crate) fn list_subagents_inner(
    session_dir: &Path,
    paths: &AppPaths,
) -> AppResult<Vec<SubagentMeta>> {
    paths::assert_within_any_root(paths, session_dir)?;
    if !session_dir.exists() {
        return Ok(vec![]);
    }
    let subagent_dir = session_dir.join("subagents");
    if !subagent_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = walker::list_jsonl_files(&subagent_dir).unwrap_or_default();
    for jsonl_path in entries {
        // v0.8.14 item B: 单文件 size cap
        if let Ok(meta) = std::fs::metadata(&jsonl_path) {
            if meta.len() > MAX_FILE_SIZE {
                log::warn!(
                    "list_subagents: 跳过过大文件 {:?} ({} bytes > 50MB)",
                    jsonl_path,
                    meta.len()
                );
                continue;
            }
        }

        let stem = jsonl_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // 文件名形如 agent-<id>
        let agent_id = stem.strip_prefix("agent-").unwrap_or(&stem).to_string();
        let meta_path = subagent_dir.join(format!("{}.meta.json", stem));

        // v0.8.14 item B: meta.json size cap + panic catch
        // 防止 attacker 塞 5 GB "meta.json" 让 read_to_string OOM,
        // 或塞畸形内容让 serde_json::from_str panic。
        let meta = if meta_path.exists() {
            match std::fs::metadata(&meta_path) {
                Ok(m) if m.len() > MAX_META_FILE_SIZE => {
                    log::warn!(
                        "list_subagents: 跳过过大 meta.json {:?} ({} bytes > 1MB)",
                        meta_path,
                        m.len()
                    );
                    None
                }
                Ok(_) => std::panic::catch_unwind(|| {
                    std::fs::read_to_string(&meta_path)
                        .ok()
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                })
                .unwrap_or_else(|_| {
                    log::warn!("list_subagents: 解析 meta.json panic {meta_path:?}");
                    None
                }),
                Err(_) => None,
            }
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
///
/// v0.8.14 item B: 跟 list_subagents 一致 — 加 assert_within_any_root 路径安全检查,
/// 单文件 size cap (50MB),meta.json size cap (1MB) + panic catch。
/// agent_id 走 sanitize_agent_id 防 traversal。
#[tauri::command]
pub async fn get_subagent_summary(
    session_dir: String,
    agent_id: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Option<SubagentSummary>> {
    let sanitized = match sanitize_agent_id(&agent_id) {
        Some(s) => s,
        None => {
            log::warn!("get_subagent_summary: 拒绝非法 agent_id {agent_id:?}");
            return Ok(None);
        }
    };
    get_subagent_summary_inner(Path::new(&session_dir), sanitized, &state.paths.read())
}

/// v0.8.14 item B: state-independent body — 可测。agent_id 必须先通过 sanitize_agent_id。
pub(crate) fn get_subagent_summary_inner(
    session_dir: &Path,
    agent_id: &str,
    paths: &AppPaths,
) -> AppResult<Option<SubagentSummary>> {
    paths::assert_within_any_root(paths, session_dir)?;
    let subagent_dir = session_dir.join("subagents");
    if !subagent_dir.exists() {
        return Ok(None);
    }
    // agent_id 形如 "a1d924c..." → 文件名 "agent-a1d924c...jsonl"
    let jsonl_path = subagent_dir.join(format!("agent-{}.jsonl", agent_id));
    if !jsonl_path.exists() {
        return Ok(None);
    }

    // v0.8.14 item B: 单文件 size cap — 防止 5GB jsonl 让 scan_jsonl_summary 卡住
    match std::fs::metadata(&jsonl_path) {
        Ok(meta) if meta.len() > MAX_FILE_SIZE => {
            log::warn!(
                "get_subagent_summary: 跳过过大文件 {:?} ({} bytes > 50MB)",
                jsonl_path,
                meta.len()
            );
            return Ok(None);
        }
        Err(e) => {
            log::error!("get_subagent_summary stat 失败 {jsonl_path:?}: {e}");
            return Ok(None);
        }
        Ok(_) => {}
    }

    let meta_path = subagent_dir.join(format!("agent-{}.meta.json", agent_id));

    // v0.8.14 item B: meta.json size cap + panic catch
    let meta = if meta_path.exists() {
        match std::fs::metadata(&meta_path) {
            Ok(m) if m.len() > MAX_META_FILE_SIZE => {
                log::warn!(
                    "get_subagent_summary: 跳过过大 meta.json {:?} ({} bytes > 1MB)",
                    meta_path,
                    m.len()
                );
                None
            }
            Ok(_) => std::panic::catch_unwind(|| {
                std::fs::read_to_string(&meta_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            })
            .unwrap_or_else(|_| {
                log::warn!("get_subagent_summary: 解析 meta.json panic {meta_path:?}");
                None
            }),
            Err(_) => None,
        }
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
    // v0.8.14 item B: panic catch 包 scan_jsonl_summary 防内部 panic
    let scan_result = std::panic::catch_unwind(|| scan_jsonl_summary(&jsonl_path, 500))
        .unwrap_or_else(|_| {
            log::warn!("get_subagent_summary: scan_jsonl_summary panic {jsonl_path:?}");
            (0, vec![], None, None)
        });
    let (message_count, tool_distribution, first_timestamp, last_timestamp) = scan_result;

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
        agent_id: agent_id.to_string(),
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

    // ===== v0.8.14 item B: list_subagents / get_subagent_summary path safety + size cap =====

    use crate::fs::paths::{AppPaths, ClaudePaths, OpenClawPaths, RootSource};

    /// 构造最小 AppPaths — root 指向 tempdir,
    /// 所以 tempdir/.claude/... 路径视为 inside root, /etc/passwd 视为 outside。
    fn make_test_paths(tmp: &tempfile::TempDir) -> AppPaths {
        let home = tmp.path().to_path_buf();
        AppPaths {
            home: home.clone(),
            default_root: RootSource {
                label: "default".to_string(),
                path: home.clone(),
                claude: Some(ClaudePaths::new(&home)),
                openclaw: Some(OpenClawPaths::new(&home)),
            },
            custom_roots: vec![],
        }
    }

    #[test]
    fn sanitize_agent_id_accepts_safe_chars() {
        assert_eq!(sanitize_agent_id("abc123"), Some("abc123"));
        assert_eq!(sanitize_agent_id("a1d2-3f4_"), Some("a1d2-3f4_"));
        assert_eq!(sanitize_agent_id("UPPERCASE"), Some("UPPERCASE"));
    }

    #[test]
    fn sanitize_agent_id_rejects_traversal_and_empty() {
        // 空
        assert_eq!(sanitize_agent_id(""), None);
        // 路径 traversal
        assert_eq!(sanitize_agent_id("../../../etc"), None);
        assert_eq!(sanitize_agent_id("../foo"), None);
        assert_eq!(sanitize_agent_id("foo/bar"), None);
        assert_eq!(sanitize_agent_id("a..b"), None);
        // shell meta
        assert_eq!(sanitize_agent_id("a;b"), None);
        assert_eq!(sanitize_agent_id("a b"), None);
        assert_eq!(sanitize_agent_id("a\\b"), None);
    }

    #[test]
    fn list_subagents_inner_rejects_path_outside_roots() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);

        // /etc/passwd 不在 tmp/.claude 或 .openclaw 下 → 应 Err
        let r = list_subagents_inner(Path::new("/etc/passwd"), &paths);
        assert!(matches!(r, Err(AppError::PathSecurity(_))), "{r:?}");
    }

    #[test]
    fn list_subagents_inner_accepts_valid_session_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);

        // 构造 tempdir/.claude/projects/proj-a/sess-1/subagents/agent-abc.jsonl
        let project = tmp.path().join(".claude/projects/proj-a/sess-1");
        let subs = project.join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        std::fs::write(
            subs.join("agent-abc.jsonl"),
            r#"{"type":"user","timestamp":"2026-08-01T10:00:00Z","message":{"content":"hi"}}
{"type":"assistant","timestamp":"2026-08-01T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}
"#,
        )
        .unwrap();
        std::fs::write(
            subs.join("agent-abc.meta.json"),
            r#"{"agentType":"Explore","description":"explore x","spawnDepth":1}"#,
        )
        .unwrap();

        let subs_out = list_subagents_inner(&project, &paths).expect("ok");
        assert_eq!(subs_out.len(), 1);
        let s = &subs_out[0];
        assert_eq!(s.agent_id, "abc");
        assert_eq!(s.agent_type.as_deref(), Some("Explore"));
        assert_eq!(s.spawn_depth, Some(1));
        assert_eq!(s.message_count, Some(2));
    }

    #[test]
    fn list_subagents_inner_skips_oversized_jsonl() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);
        let project = tmp.path().join(".claude/projects/proj-a/sess-1");
        let subs = project.join("subagents");
        std::fs::create_dir_all(&subs).unwrap();

        // 写大文件 (>50MB):用 sparse 文件(fallocate or just write actual size)
        // NamedTempFile 不是 sparse — 改用 tempdir 里直接创建文件然后 truncate + write 50MB+1 byte
        let big = subs.join("agent-big.jsonl");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_FILE_SIZE + 1).unwrap();
        drop(f);

        let r = list_subagents_inner(&project, &paths).expect("ok");
        // oversized 应被 skip,out 为空
        assert!(r.is_empty(), "过大 jsonl 应被 skip,实际 {r:?}");

        std::fs::remove_file(&big).ok();
    }

    #[test]
    fn list_subagents_inner_ignores_oversized_meta_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);
        let project = tmp.path().join(".claude/projects/proj-a/sess-1");
        let subs = project.join("subagents");
        std::fs::create_dir_all(&subs).unwrap();

        // 合法 jsonl + 过大 meta.json (>1MB) — meta 应被忽略,但 subagent 仍出现
        std::fs::write(
            subs.join("agent-x.jsonl"),
            r#"{"type":"user","timestamp":"2026-08-01T10:00:00Z","message":{"content":"hi"}}
"#,
        )
        .unwrap();
        let big_meta = subs.join("agent-x.meta.json");
        let f = std::fs::File::create(&big_meta).unwrap();
        f.set_len(MAX_META_FILE_SIZE + 1).unwrap();
        drop(f);

        let r = list_subagents_inner(&project, &paths).expect("ok");
        assert_eq!(r.len(), 1, "oversized meta 应被 skip 但 subagent 仍保留");
        assert_eq!(r[0].agent_type, None, "meta 失败 → agent_type None");
        assert_eq!(r[0].spawn_depth, None);

        std::fs::remove_file(&big_meta).ok();
    }

    #[test]
    fn list_subagents_inner_returns_empty_when_no_subagent_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);
        let project = tmp.path().join(".claude/projects/proj-a/sess-1");
        std::fs::create_dir_all(&project).unwrap();

        // 没有 subagents/ 子目录 — 应 Ok(empty)
        let r = list_subagents_inner(&project, &paths).expect("ok");
        assert!(r.is_empty());
    }

    #[test]
    fn get_subagent_summary_inner_rejects_path_outside_roots() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);

        let r = get_subagent_summary_inner(Path::new("/etc/passwd"), "abc123", &paths);
        assert!(matches!(r, Err(AppError::PathSecurity(_))));
    }

    #[test]
    fn get_subagent_summary_inner_returns_none_for_missing_agent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);
        let project = tmp.path().join(".claude/projects/proj-a/sess-1");
        std::fs::create_dir_all(project.join("subagents")).unwrap();

        // 不存在的 agent_id
        let r = get_subagent_summary_inner(&project, "no-such-agent", &paths).expect("ok");
        assert!(r.is_none(), "missing jsonl 应返 None");
    }

    #[test]
    fn get_subagent_summary_inner_skips_oversized_jsonl() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths(&tmp);
        let project = tmp.path().join(".claude/projects/proj-a/sess-1");
        let subs = project.join("subagents");
        std::fs::create_dir_all(&subs).unwrap();

        // oversized jsonl
        let big = subs.join("agent-big.jsonl");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_FILE_SIZE + 1).unwrap();
        drop(f);

        let r = get_subagent_summary_inner(&project, "big", &paths).expect("ok");
        assert!(r.is_none(), "oversized jsonl 应返 None");

        std::fs::remove_file(&big).ok();
    }
}
