//! 子代理命令

use std::path::Path;

use crate::error::AppResult;
use crate::fs::walker;
use crate::model::SubagentMeta;

/// 列出某个会话下的所有子代理
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
                .and_then(|s| serde_json::from_str(&s).ok())
        } else {
            None
        };
        out.push(SubagentMeta {
            agent_id,
            jsonl_path: jsonl_path.to_string_lossy().to_string(),
            meta_path: meta_path.to_string_lossy().to_string(),
            meta,
        });
    }
    Ok(out)
}
