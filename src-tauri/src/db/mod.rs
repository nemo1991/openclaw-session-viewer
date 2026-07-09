//! v0.8.0 嵌入式关系型数据库模块
//!
//! 持有 `~/.{bundle}/observer.db`,管理:
//! - `session_meta`     — 所有 session 的元数据(jsonl 同步结果)
//! - `session_override` — 用户视角(rename/hide/pin/archive/notes)
//! - `tag`/`session_tag`— 多对多标签
//! - `session_link`     — 跨 session backlink
//! - `sync_state`       — 单行同步状态
//!
//! 设计要点:
//! - WAL 模式,`synchronous=NORMAL`,并发读不阻塞单写
//! - `Connection` 用 `parking_lot::Mutex` 包裹,所有读写都过 `with(|c| ...)`
//!   (本应用读多写少,串行化足够;后续若需要并行可换 `r2d2_sqlite`)
//! - 启动时 `PRAGMA integrity_check`,失败自动 rename + 重建(见 `open`)
//! - DB schema 一次性定义全表(v0.8.0 决定,后续若要迁移加 `migration` 表)

pub mod migrations;
pub mod schema;
pub mod sync;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::{AppError, AppResult};

/// DB 连接 + 路径(Arc 共享给 AppState)
#[derive(Clone)]
pub struct DbPool {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) inner: Arc<Mutex<Connection>>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) path: PathBuf,
}

impl DbPool {
    /// 跑一个闭包,拿到独占 Connection
    ///
    /// 用法:`pool.with(|c| c.execute(...))`
    pub fn with<R>(&self, f: impl FnOnce(&mut Connection) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self.inner.lock();
        f(&mut guard)
    }

    /// DB 文件路径(用于 SettingsRoute 展示)
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// 打开或创建 DB。带损坏自愈。
///
/// 流程:
/// 1. 确保父目录存在(`app_config_dir` 一般已建好,兜底再 mkdir)
/// 2. `Connection::open`
/// 3. `PRAGMA journal_mode=WAL` + `foreign_keys=ON` + `synchronous=NORMAL`
/// 4. `PRAGMA integrity_check` — 失败则 rename 为 `observer.db.corrupt-<ts>` 后重建
/// 5. 应用 schema(全表 `CREATE TABLE IF NOT EXISTS ...`)
pub fn open(app_config_dir: &Path) -> AppResult<DbPool> {
    std::fs::create_dir_all(app_config_dir).map_err(AppError::Io)?;
    let db_path = app_config_dir.join("observer.db");

    let conn = if db_path.exists() {
        match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("打开 observer.db 失败 {:?}: {e} — 重建", db_path);
                rename_corrupt(&db_path)?;
                Connection::open(&db_path)?
            }
        }
    } else {
        Connection::open(&db_path)?
    };

    // PRAGMA 必须在每条 connection 上设置,SQLite 不会持久化所有 PRAGMA
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();

    // integrity check — 如果 DB 损坏,rename + 重建
    let integrity_ok: String = conn
        .pragma_query_value(None, "integrity_check", |r| r.get(0))
        .unwrap_or_else(|_| "fail".to_string());
    if integrity_ok != "ok" {
        log::warn!(
            "observer.db integrity_check 失败: {} — rename + 重建",
            integrity_ok
        );
        drop(conn);
        rename_corrupt(&db_path)?;
        let conn = Connection::open(&db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        schema::apply(&conn)?;
        return Ok(DbPool {
            inner: Arc::new(Mutex::new(conn)),
            path: db_path,
        });
    }

    schema::apply(&conn)?;

    Ok(DbPool {
        inner: Arc::new(Mutex::new(conn)),
        path: db_path,
    })
}

fn rename_corrupt(db_path: &Path) -> AppResult<()> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = db_path.with_extension(format!("db.corrupt-{ts}"));
    std::fs::rename(db_path, &target)?;
    log::warn!("损坏 DB 已隔离到 {:?}", target);
    // WAL/SHM 残留也清掉
    let wal = db_path.with_extension("db-wal");
    let shm = db_path.with_extension("db-shm");
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(shm);
    Ok(())
}
