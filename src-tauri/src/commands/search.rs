//! 搜索命令

use std::path::Path;
use std::sync::Arc;

use regex::Regex;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;
use tokio::sync::mpsc;

use crate::error::AppResult;
use crate::fs::walker;
use crate::parser::jsonl;
use crate::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitOut {
    pub session_path: String,
    pub session_id: String,
    pub index: u32,
    pub byte_offset: u64,
    pub snippet: String,
    pub char_offset: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchHitOut {
    pub session_path: String,
    pub session_id: String,
    pub project_key: String,
    pub workspace_guess: Option<String>,
    pub source: String,
    pub title: Option<String>,
    pub hit: SearchHitOut,
}

/// 在单个会话内搜索
#[tauri::command]
pub async fn search_session(path: String, query: String, app: AppHandle) -> AppResult<()> {
    let (tx, mut rx) = mpsc::channel::<SearchHitOut>(128);
    let app_clone = app.clone();

    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let p = Path::new(&path);
        if !p.exists() {
            return Ok(());
        }
        let session_id = p
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // 简化:对每行做 substring 搜索
        let q = query.to_lowercase();
        jsonl::for_each_line(p, |idx, byte, v| {
            let s = v.to_string().to_lowercase();
            if let Some(pos) = s.find(&q) {
                let snippet = extract_snippet(&v.to_string(), pos, q.len());
                let _ = tx.blocking_send(SearchHitOut {
                    session_path: path.clone(),
                    session_id: session_id.clone(),
                    index: idx as u32,
                    byte_offset: byte,
                    snippet,
                    char_offset: pos as u32,
                });
            }
        })?;
        Ok(())
    });

    tauri::async_runtime::spawn(async move {
        while let Some(hit) = rx.recv().await {
            let _ = app_clone.emit("search-hit", &hit);
        }
        let _ = app_clone.emit("search-done", &serde_json::json!({}));
    });

    Ok(())
}

/// 跨所有会话搜索
#[tauri::command]
pub async fn search_all(
    query: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> AppResult<()> {
    let (tx, mut rx) = mpsc::channel::<GlobalSearchHitOut>(128);
    let app_clone = app.clone();

    // 收集所有 jsonl 路径
    let mut all = Vec::new();
    all.extend(walker::list_jsonl_files(&state.paths.claude.projects_dir)?);
    if let Some(oc) = &state.paths.openclaw {
        if oc.agents_dir.exists() {
            for entry in std::fs::read_dir(&oc.agents_dir)?.filter_map(|e| e.ok()) {
                let sessions = entry.path().join("sessions");
                if sessions.exists() {
                    all.extend(walker::list_jsonl_files(&sessions)?);
                }
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let q = query.to_lowercase();
        for path in all {
            let path_str = path.to_string_lossy().to_string();
            let session_id = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let project_key = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let source = if path_str.contains(".openclaw") {
                "openclaw"
            } else {
                "claude"
            };

            let _ = jsonl::for_each_line(&path, |idx, byte, v| {
                let s = v.to_string().to_lowercase();
                if let Some(pos) = s.find(&q) {
                    let snippet = extract_snippet(&v.to_string(), pos, q.len());
                    let _ = tx.blocking_send(GlobalSearchHitOut {
                        session_path: path_str.clone(),
                        session_id: session_id.clone(),
                        project_key: project_key.clone(),
                        workspace_guess: None,
                        source: source.to_string(),
                        title: None,
                        hit: SearchHitOut {
                            session_path: path_str.clone(),
                            session_id: session_id.clone(),
                            index: idx as u32,
                            byte_offset: byte,
                            snippet,
                            char_offset: pos as u32,
                        },
                    });
                }
            });
        }
    });

    tauri::async_runtime::spawn(async move {
        while let Some(hit) = rx.recv().await {
            let _ = app_clone.emit("global-search-hit", &hit);
        }
        let _ = app_clone.emit("global-search-done", &serde_json::json!({}));
    });

    Ok(())
}

fn extract_snippet(text: &str, pos: usize, q_len: usize) -> String {
    const PAD: usize = 60;
    let start = pos.saturating_sub(PAD);
    let end = (pos + q_len + PAD).min(text.len());
    let mut s = text[start..end].to_string();
    s = s.replace('\n', " ");
    if start > 0 {
        s = format!("…{}", s);
    }
    if end < text.len() {
        s.push('…');
    }
    s
}

// 给后续 regex 模式预留
#[allow(dead_code)]
fn _try_regex(_re: &Regex) {}
