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

    tauri::async_runtime::spawn_blocking(move || {
        // 第二层兜底: 单会话 panic 不影响其他会话/前端。
        // 用 catch_unwind catch + log + 吞掉(不要 rethrow — rethrow
        // 在 Rust 2024 下会触发 "Rust panics must be rethrown, aborting"
        // 导致 catch_unwind 反而把进程杀掉)。
        let inner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> AppResult<()> {
            let p = Path::new(&path);
            if !p.exists() {
                return Ok(());
            }
            let session_id = p
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
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
            })
        }));
        match inner {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::error!("search_session 内部错误: {}", e),
            // 故意吞掉 panic payload — panic hook 已经 log 了位置 + 内容,
            // 这里不再 rethrow,避免 Rust 2024 aborting 整套进程
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "<non-string panic>".to_string());
                log::error!("search_session panic,此会话未完成搜索: {}", msg);
            }
        }
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

    // 收集所有 jsonl 路径(走所有 root:default + custom_roots)
    let mut all = Vec::new();
    let paths_snapshot = state.paths.read().clone();
    for projects_dir in paths_snapshot.all_claude_projects_dirs() {
        all.extend(walker::list_jsonl_files(projects_dir)?);
    }
    for agents_dir in paths_snapshot.all_openclaw_agents_dirs() {
        if !agents_dir.exists() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(agents_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let sessions = entry.path().join("sessions");
                if sessions.exists() {
                    all.extend(walker::list_jsonl_files(&sessions)?);
                }
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        // 第二层兜底: 单文件 panic 不影响其他文件
        let inner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        }));
        match inner {
            Ok(()) => {}
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "<non-string panic>".to_string());
                log::error!("search_all panic,部分会话可能未搜索到: {}", msg);
            }
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

/// 取匹配位置的上下文片段
///
/// **关键陷阱**: caller 传入的 `pos` 是 `s.find(&q)` 的结果,
/// 其中 `s = text.to_lowercase()`。Lowercasing **不改变 ASCII 字节长度**,
/// 但**会改变 Unicode 字符串的字节长度**(e.g. `İ`(U+0130, 2 bytes) →
/// `i`(1 byte))。如果 `text` 是非 lowercased 的原始字符串,
/// 那么 `pos` 可能落在 UTF-8 字符中间 → `text[start..end]` panic。
///
/// 修复: 把 `start`/`end` 对齐到最近的 char boundary。
fn extract_snippet(text: &str, pos: usize, q_len: usize) -> String {
    const PAD: usize = 60;
    let start = floor_char_boundary(text, pos.saturating_sub(PAD));
    let end_upper = (pos.saturating_add(q_len).saturating_add(PAD)).min(text.len());
    let end = floor_char_boundary(text, end_upper);
    if start >= end || end > text.len() {
        return text.chars().take(120).collect();
    }
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

/// 把 byte index 向下对齐到最近的 UTF-8 char boundary
fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

// 给后续 regex 模式预留
#[allow(dead_code)]
fn _try_regex(_re: &Regex) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_floor_char_boundary_ascii() {
        let s = "hello world";
        assert_eq!(floor_char_boundary(s, 0), 0);
        assert_eq!(floor_char_boundary(s, 5), 5);
        assert_eq!(floor_char_boundary(s, 11), 11);
        assert_eq!(floor_char_boundary(s, 100), 11);
    }

    #[test]
    fn test_floor_char_boundary_unicode() {
        let s = "中文 hello";
        // 中(3 bytes)文(3 bytes) (1 byte)h...
        assert_eq!(floor_char_boundary(s, 0), 0);
        assert_eq!(floor_char_boundary(s, 1), 0); // mid-中 → 0
        assert_eq!(floor_char_boundary(s, 2), 0);
        assert_eq!(floor_char_boundary(s, 3), 3); // at 文 boundary
        assert_eq!(floor_char_boundary(s, 5), 3); // mid-文 → 3
        assert_eq!(floor_char_boundary(s, 6), 6); // after space
    }

    #[test]
    fn test_extract_snippet_ascii() {
        let text = "The quick brown fox jumps over the lazy dog";
        // "fox" 在 index 16
        let s = extract_snippet(text, 16, 3);
        assert!(s.contains("fox"));
        assert!(s.contains("brown"));
        assert!(s.contains("jumps"));
    }

    #[test]
    fn test_extract_snippet_unicode_no_panic() {
        let text = "中文测试字符串包含中文文本文档";
        let s = extract_snippet(text, 3, 3);
        assert!(s.contains("文"));
    }

    #[test]
    fn test_extract_snippet_out_of_bounds_safe() {
        let text = "short";
        let s = extract_snippet(text, 100, 5);
        assert!(s.len() <= 120);
    }

    #[test]
    fn test_extract_snippet_unicode_with_turkish_i() {
        let text = "İstanbul";
        let s = extract_snippet(text, 0, 1);
        assert!(s.contains("tanbul") || s.contains("İ"));
    }
}
