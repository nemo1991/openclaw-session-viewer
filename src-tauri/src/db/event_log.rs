//! v0.11 (A1 / A3): 本地事件日志 (local event log)
//!
//! 战略 D-2「本地优先、零上传」:v0.10 PRD 第十章原写的「埋点上报」既无基础设施、
//! 也与隐私定位冲突,按变更流程重定义为**只写本地 SQLite** 的事件日志。
//! 本模块及 `commands/events.rs` 不存在任何网络调用;`scripts/assert-local-events.mjs`
//! 会在 CI 里静态门禁这条边界(既有 `llm/anthropic.rs` 的 reqwest 是用户主动触发的
//! LLM 分析功能,不属于埋点链路)。
//!
//! 落地事件:
//! - `analytics_view_open`      打开 Analytics
//! - `source_dimension_select`  切换 source 维度
//! - `retry_rate_displayed`     真实重试率数值卡渲染
//! - `analytics_ready`          A3: 打开 → 首屏可交互耗时 (duration_ms)
//! - `health_view_open`         v0.11 (B2): 打开会话体检 tab
//!
//! 表 `event_log` 由 `db/schema.rs::SCHEMA_SQL`(新库)与
//! `db/migrations.rs::NEW_TABLES`(老库)两处幂等创建。

use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::error::AppResult;

/// A1: v0.10 PRD 第十章定义的三个埋点事件(本地日志口径)
pub const EVENT_ANALYTICS_VIEW_OPEN: &str = "analytics_view_open";
pub const EVENT_SOURCE_DIMENSION_SELECT: &str = "source_dimension_select";
pub const EVENT_RETRY_RATE_DISPLAYED: &str = "retry_rate_displayed";
/// A3: 打开 Analytics → 首屏可交互的耗时,写入 duration_ms
pub const EVENT_ANALYTICS_READY: &str = "analytics_ready";
/// v0.11 (B2): 打开体检 tab,为「体检标记有用率」指标提供本地数据底座
pub const EVENT_HEALTH_VIEW_OPEN: &str = "health_view_open";

/// command 侧白名单 — 只允许这些事件名入库,避免前端把任意字符串写进本地 DB
pub const ALLOWED_EVENTS: &[&str] = &[
    EVENT_ANALYTICS_VIEW_OPEN,
    EVENT_SOURCE_DIMENSION_SELECT,
    EVENT_RETRY_RATE_DISPLAYED,
    EVENT_ANALYTICS_READY,
    EVENT_HEALTH_VIEW_OPEN,
];

/// A3 门槛(PRD 估算目标 <500ms)。真实阈值待运行期采集校正,不作为生产硬失败。
pub const P95_BUDGET_MS: f64 = 500.0;

/// 一条待写入事件。`ts_ms` 由后端本地时钟生成,不接受前端传入。
#[derive(Debug, Clone, Default)]
pub struct NewEvent<'a> {
    pub event_name: &'a str,
    pub source: Option<&'a str>,
    pub session_count: Option<i64>,
    /// 指标是否使用真实口径(对应 v0.10 PRD 第十章「是否真实口径」字段)
    pub real_metric: Option<bool>,
    /// A3: 打开 → 首屏可交互耗时
    pub duration_ms: Option<i64>,
    pub detail: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLogRow {
    pub id: i64,
    pub event_name: String,
    pub ts_ms: i64,
    pub source: Option<String>,
    pub session_count: Option<i64>,
    pub real_metric: Option<bool>,
    pub duration_ms: Option<i64>,
    pub detail: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 写入一条本地事件,返回自增 id。**唯一的写入路径,无网络副作用。**
pub fn append_event(conn: &Connection, e: &NewEvent<'_>) -> AppResult<i64> {
    let real = e.real_metric.map(i64::from);
    conn.execute(
        "INSERT INTO event_log
           (event_name, ts_ms, source, session_count, real_metric, duration_ms, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            e.event_name,
            now_ms(),
            e.source,
            e.session_count,
            real,
            e.duration_ms,
            e.detail
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn map_row(r: &Row<'_>) -> rusqlite::Result<EventLogRow> {
    Ok(EventLogRow {
        id: r.get(0)?,
        event_name: r.get(1)?,
        ts_ms: r.get(2)?,
        source: r.get(3)?,
        session_count: r.get(4)?,
        // SQLite 存 0/1 INTEGER,读回映射成 bool
        real_metric: r.get::<_, Option<i64>>(5)?.map(|v| v != 0),
        duration_ms: r.get(6)?,
        detail: r.get(7)?,
    })
}

/// 查询本地事件(最新在前)。`event_name = None` 表示不过滤;limit 夹在 1..=1000。
pub fn list_events(
    conn: &Connection,
    event_name: Option<&str>,
    limit: u32,
) -> AppResult<Vec<EventLogRow>> {
    let limit = limit.clamp(1, 1000) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, event_name, ts_ms, source, session_count, real_metric, duration_ms, detail
           FROM event_log
          WHERE (?1 IS NULL OR event_name = ?1)
          ORDER BY ts_ms DESC, id DESC
          LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![event_name, limit], map_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// nearest-rank P95: 排序后取 `ceil(0.95 * n)` 个样本(1-based)。
/// 前端 `views/graph/perf.ts::p95` 用同一定义,保证两侧口径一致。
pub fn duration_p95(samples: &[f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = (0.95 * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.saturating_sub(1).min(sorted.len() - 1)])
}

/// A3 可选性能断言结果(开发 / CI 模式消费,生产不硬失败)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P95Gate {
    pub event_name: String,
    pub sample_count: usize,
    pub p95_ms: Option<f64>,
    pub budget_ms: f64,
    pub ok: bool,
    pub reason: String,
}

/// 门槛断言:无样本时跳过(ok=true),有样本时 P95 必须 < 500ms。
pub fn check_p95_budget(conn: &Connection, event_name: &str, limit: u32) -> AppResult<P95Gate> {
    let rows = list_events(conn, Some(event_name), limit)?;
    let samples: Vec<f64> = rows
        .iter()
        .filter_map(|r| r.duration_ms.map(|d| d as f64))
        .collect();
    let sample_count = samples.len();
    let p95_ms = duration_p95(&samples);
    let (ok, reason) = match p95_ms {
        None => (true, "无耗时样本,跳过门槛".to_string()),
        Some(p) if p < P95_BUDGET_MS => (
            true,
            format!("P95 {p:.1}ms < {P95_BUDGET_MS:.0}ms (估算预算)"),
        ),
        Some(p) => (
            false,
            format!("P95 {p:.1}ms ≥ {P95_BUDGET_MS:.0}ms — 疑似性能回归"),
        ),
    };
    Ok(P95Gate {
        event_name: event_name.to_string(),
        sample_count,
        p95_ms,
        budget_ms: P95_BUDGET_MS,
        ok,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 新库路径:schema::apply 会建全表 + 跑幂等迁移
    fn fresh_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::apply(&conn).expect("apply schema");
        conn
    }

    fn insert(conn: &Connection, e: NewEvent<'_>) -> i64 {
        append_event(conn, &e).expect("append event")
    }

    #[test]
    fn append_event_round_trips_all_fields() {
        let conn = fresh_conn();
        let id = insert(
            &conn,
            NewEvent {
                event_name: EVENT_RETRY_RATE_DISPLAYED,
                source: Some("claude"),
                session_count: Some(12),
                real_metric: Some(true),
                duration_ms: Some(321),
                detail: Some("3/40"),
            },
        );
        assert!(id > 0);
        let rows = list_events(&conn, None, 10).expect("list");
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.id, id);
        assert_eq!(r.event_name, EVENT_RETRY_RATE_DISPLAYED);
        assert!(r.ts_ms > 0, "时间戳应由后端本地时钟生成");
        assert_eq!(r.source.as_deref(), Some("claude"));
        assert_eq!(r.session_count, Some(12));
        assert_eq!(r.real_metric, Some(true));
        assert_eq!(r.duration_ms, Some(321));
        assert_eq!(r.detail.as_deref(), Some("3/40"));
    }

    #[test]
    fn list_events_filters_by_name_and_limits() {
        let conn = fresh_conn();
        for _ in 0..5 {
            insert(
                &conn,
                NewEvent {
                    event_name: EVENT_ANALYTICS_VIEW_OPEN,
                    ..Default::default()
                },
            );
        }
        insert(
            &conn,
            NewEvent {
                event_name: EVENT_SOURCE_DIMENSION_SELECT,
                source: Some("kimi"),
                ..Default::default()
            },
        );
        let all = list_events(&conn, None, 100).unwrap();
        assert_eq!(all.len(), 6);
        let only_select = list_events(&conn, Some(EVENT_SOURCE_DIMENSION_SELECT), 100).unwrap();
        assert_eq!(only_select.len(), 1);
        assert_eq!(only_select[0].source.as_deref(), Some("kimi"));
        // limit 生效且夹在合法范围
        assert_eq!(list_events(&conn, None, 3).unwrap().len(), 3);
        assert_eq!(list_events(&conn, None, 0).unwrap().len(), 1);
    }

    #[test]
    fn duration_p95_uses_nearest_rank() {
        assert_eq!(duration_p95(&[]), None);
        assert_eq!(duration_p95(&[42.0]), Some(42.0));
        let samples: Vec<f64> = (1..=20).map(|i| i as f64 * 10.0).collect();
        // ceil(0.95 * 20) = 19 → 第 19 个 = 190
        assert_eq!(duration_p95(&samples), Some(190.0));
    }

    #[test]
    fn p95_gate_passes_for_typical_samples() {
        let conn = fresh_conn();
        for ms in [120i64, 180, 210, 260, 310, 380, 155, 240, 290, 195] {
            insert(
                &conn,
                NewEvent {
                    event_name: EVENT_ANALYTICS_READY,
                    duration_ms: Some(ms),
                    ..Default::default()
                },
            );
        }
        let gate = check_p95_budget(&conn, EVENT_ANALYTICS_READY, 100).unwrap();
        assert_eq!(gate.sample_count, 10);
        assert_eq!(gate.p95_ms, Some(380.0));
        assert!(gate.ok, "典型样本应通过门槛: {}", gate.reason);
    }

    #[test]
    fn p95_gate_detects_regression() {
        // 注入验证:慢样本必须让门槛失败,而不是永远变绿
        let conn = fresh_conn();
        for _ in 0..20 {
            insert(
                &conn,
                NewEvent {
                    event_name: EVENT_ANALYTICS_READY,
                    duration_ms: Some(650),
                    ..Default::default()
                },
            );
        }
        let gate = check_p95_budget(&conn, EVENT_ANALYTICS_READY, 100).unwrap();
        assert_eq!(gate.p95_ms, Some(650.0));
        assert!(!gate.ok, "650ms 样本应触发性能回归判定");
        assert!(gate.reason.contains("性能回归"));
    }

    #[test]
    fn p95_gate_skips_when_no_duration_samples() {
        let conn = fresh_conn();
        let gate = check_p95_budget(&conn, EVENT_ANALYTICS_READY, 100).unwrap();
        assert_eq!(gate.sample_count, 0);
        assert_eq!(gate.p95_ms, None);
        assert!(gate.ok, "无样本时跳过,不在 CI 里假失败");
    }

    #[test]
    fn event_log_table_is_created_for_legacy_db() {
        // 模拟老库:只有 session_meta,再跑 ensure_tables 应补出 event_log
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT PRIMARY KEY,
                project_key TEXT NOT NULL,
                source TEXT NOT NULL,
                jsonl_path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL,
                mtime_ms INTEGER NOT NULL,
                line_count INTEGER NOT NULL,
                synced_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        crate::db::migrations::ensure_tables(&conn).unwrap();
        // 幂等:再跑一次
        crate::db::migrations::ensure_tables(&conn).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='event_log'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "老库补表后 event_log 应存在");
        insert(
            &conn,
            NewEvent {
                event_name: EVENT_ANALYTICS_VIEW_OPEN,
                ..Default::default()
            },
        );
        assert_eq!(list_events(&conn, None, 10).unwrap().len(), 1);
    }
}
