//! v0.11 (A1 / A3): 本地事件日志 Tauri commands
//!
//! **零上传边界**:本文件只把事件写入本地 `observer.db::event_log`,
//! 不引用任何 HTTP 客户端。`scripts/assert-local-events.mjs` 在 CI 里静态扫描
//! 本文件与前端 `eventsApi.ts`,出现 `fetch` / `XMLHttpRequest` / `sendBeacon` /
//! `reqwest` 等网络 API 即失败,守住战略 D-2「本地优先、零上传」。
//!
//! 既有 `llm/anthropic.rs` 的 reqwest 是用户在「AI 分析」里主动触发的 LLM 调用,
//! 不属于埋点链路,也不在本模块的依赖里。

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::db::event_log::{self, EventLogRow, NewEvent, P95Gate, ALLOWED_EVENTS};
use crate::error::{AppError, AppResult};
use crate::AppState;

const MAX_DETAIL_LEN: usize = 500;
const MAX_SOURCE_LEN: usize = 64;

/// 前端传 camelCase,serde 自动映射到 snake_case。
/// Tauri 调用形如 `invoke("append_local_event", { input: { eventName, ... } })`。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEventInput {
    pub event_name: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub session_count: Option<i64>,
    #[serde(default)]
    pub real_metric: Option<bool>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub detail: Option<String>,
}

fn validate(input: &LocalEventInput) -> AppResult<()> {
    if !ALLOWED_EVENTS.contains(&input.event_name.as_str()) {
        return Err(AppError::Invalid(format!(
            "未知本地事件: {}",
            input.event_name
        )));
    }
    if let Some(s) = &input.source {
        if s.chars().count() > MAX_SOURCE_LEN {
            return Err(AppError::Invalid("source 过长".into()));
        }
    }
    if let Some(d) = &input.detail {
        if d.chars().count() > MAX_DETAIL_LEN {
            return Err(AppError::Invalid("detail 过长".into()));
        }
    }
    if let Some(n) = input.session_count {
        if n < 0 {
            return Err(AppError::Invalid("sessionCount 不能为负".into()));
        }
    }
    if let Some(ms) = input.duration_ms {
        if ms < 0 {
            return Err(AppError::Invalid("durationMs 不能为负".into()));
        }
    }
    Ok(())
}

/// A1: 追加一条本地事件。失败由前端静默吞掉,绝不影响 UI 渲染。
#[tauri::command]
pub fn append_local_event(
    state: State<'_, Arc<AppState>>,
    input: LocalEventInput,
) -> AppResult<()> {
    validate(&input)?;
    state.db.with_write(|conn| {
        event_log::append_event(
            conn,
            &NewEvent {
                event_name: &input.event_name,
                source: input.source.as_deref(),
                session_count: input.session_count,
                real_metric: input.real_metric,
                duration_ms: input.duration_ms,
                detail: input.detail.as_deref(),
            },
        )?;
        Ok(())
    })
}

/// A1: 自查用 — 列出本地事件(最新在前)。
#[tauri::command]
pub fn list_local_events(
    state: State<'_, Arc<AppState>>,
    event_name: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<EventLogRow>> {
    state
        .db
        .with_read(|conn| event_log::list_events(conn, event_name.as_deref(), limit.unwrap_or(100)))
}

/// A3: 可选性能断言 — 返回最近样本的 nearest-rank P95 与 <500ms 门槛判定。
#[tauri::command]
pub fn local_event_p95(
    state: State<'_, Arc<AppState>>,
    event_name: String,
    limit: Option<u32>,
) -> AppResult<P95Gate> {
    if !ALLOWED_EVENTS.contains(&event_name.as_str()) {
        return Err(AppError::Invalid(format!("未知本地事件: {event_name}")));
    }
    state
        .db
        .with_read(|conn| event_log::check_p95_budget(conn, &event_name, limit.unwrap_or(100)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> LocalEventInput {
        LocalEventInput {
            event_name: name.to_string(),
            source: None,
            session_count: None,
            real_metric: None,
            duration_ms: None,
            detail: None,
        }
    }

    #[test]
    fn validate_accepts_only_whitelisted_events() {
        for name in ALLOWED_EVENTS {
            assert!(validate(&input(name)).is_ok(), "{name} 应在白名单内");
        }
        assert!(validate(&input("arbitrary_telemetry")).is_err());
    }

    #[test]
    fn validate_rejects_negative_counts_and_oversize_detail() {
        let mut i = input(event_log::EVENT_ANALYTICS_VIEW_OPEN);
        i.session_count = Some(-1);
        assert!(validate(&i).is_err());
        i.session_count = None;
        i.duration_ms = Some(-5);
        assert!(validate(&i).is_err());
        i.duration_ms = None;
        i.detail = Some("x".repeat(MAX_DETAIL_LEN + 1));
        assert!(validate(&i).is_err());
        i.detail = Some("ok".into());
        assert!(validate(&i).is_ok());
    }
}
