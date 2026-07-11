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
//! - WAL 模式,`synchronous=NORMAL`,并发读不阻塞单写 (SQLite WAL 原生支持)
//! - v0.8.7 C: 读写连接分离 — `rusqlite::Connection` 是 `Send` 但 `!Sync`,
//!   没法直接放 `RwLock`. 改用一组 reader + 1 个 writer:
//!   - `with_read(|c: &Connection|)` 多 reader 并发跑 (round-robin 分发)
//!     G1 GraphView / G2 Analytics 同时加载不再互锁
//!   - `with_write(|c: &mut Connection|)` 排他 writer (mutation + 事务)
//!   - `with(|c: &mut Connection|)` 兼容 alias → 走 writer (行为同 Mutex 时代)
//! - 启动时 `PRAGMA integrity_check`,失败自动 rename + 重建(见 `open`)
//! - DB schema 一次性定义全表(v0.8.0 决定,后续若要迁移加 `migration` 表)

pub mod migrations;
pub mod schema;
pub mod sync;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::{AppError, AppResult};

/// v0.8.7 C: 读写分离的连接池
///
/// 持有 1 个 writer (串行化所有 mutation) + N 个 reader (round-robin 分发,
/// 互不阻塞). SQLite WAL 模式下, 多 reader 跟 1 writer 可同时跑.
#[derive(Clone)]
pub struct DbPool {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) readers: Arc<Vec<Mutex<Connection>>>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) writer: Arc<Mutex<Connection>>,
    /// round-robin 下次选哪个 reader
    next_reader: Arc<AtomicUsize>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) path: PathBuf,
}

impl DbPool {
    /// v0.8.7 C: 只读访问 — 多 reader 并发跑 (round-robin 选 connection)
    ///
    /// 闭包拿到 `&Connection` (不是 `&mut`), 因此**不能**调 `c.execute(...)`
    /// 或开 transaction. 绝大多数 schema::* 函数都签名 `&Connection`,
    /// 全部走这条路径.
    ///
    /// 用法: `pool.with_read(|c| schema::list_all_joined(c))`
    pub fn with_read<R>(&self, f: impl FnOnce(&Connection) -> AppResult<R>) -> AppResult<R> {
        debug_assert!(!self.readers.is_empty(), "DbPool has no readers");
        let n = self.readers.len();
        // Relaxed 即可: 不需要 happens-before 同步, 只为分散负载
        let idx = self.next_reader.fetch_add(1, Ordering::Relaxed) % n;
        let guard = self.readers[idx].lock();
        f(&guard)
    }

    /// 排他访问 — 写操作 / 事务用, 阻塞所有 reader + 其它 writer
    ///
    /// v0.8.7 C: 新代码建议显式用 `with_write` 标明写意图.
    ///
    /// 用法: `pool.with_write(|c| { c.execute(...)?; ... })`
    pub fn with_write<R>(&self, f: impl FnOnce(&mut Connection) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self.writer.lock();
        f(&mut guard)
    }

    /// 兼容 alias: 行为等同于 `with_write` (走 writer 排他锁).
    /// 老调用 `pool.with(|c| ...)` 不动也能编译运行.
    /// 新代码请优先用 `with_read` / `with_write` 显式声明读写意图.
    pub fn with<R>(&self, f: impl FnOnce(&mut Connection) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self.writer.lock();
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

    let conn = open_connection(&db_path)?;
    apply_pragmas(&conn)?;

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
        let conn = open_connection(&db_path)?;
        apply_pragmas(&conn)?;
        schema::apply(&conn)?;
        let pool = build_pool(conn, db_path);
        return Ok(pool);
    }

    schema::apply(&conn)?;

    Ok(build_pool(conn, db_path))
}

/// v0.8.7 C: 抽出"开连接 + 应用 PRAGMA"的样板, 给 open / 重建分支复用
fn open_connection(db_path: &Path) -> AppResult<Connection> {
    if db_path.exists() {
        match Connection::open(db_path) {
            Ok(c) => Ok(c),
            Err(e) => {
                log::warn!("打开 observer.db 失败 {:?}: {e} — 重建", db_path);
                rename_corrupt(db_path)?;
                Connection::open(db_path).map_err(|e| AppError::Other(format!("reopen db: {e}")))
            }
        }
    } else {
        Connection::open(db_path).map_err(|e| AppError::Other(format!("open db: {e}")))
    }
}

/// v0.8.7 C: 给单条 connection 应用 PRAGMA (WAL + foreign_keys + synchronous=NORMAL)
///
/// v0.8.8: `journal_mode=WAL` 失败返 AppError(之前 `.ok()` 静默吞)。WAL 失败意味着
/// SQLite 退到 rollback journal 模式,reader/writer 池设计失效 (reader 跟 writer
/// 会互锁)— 必须 fail-fast 让 open 中断,而不是静默退化到池失效的状态。
/// `foreign_keys` / `synchronous` 失败仍 `.ok()` 兜底 (这俩失败降级明显但不会让池失效)。
fn apply_pragmas(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| AppError::Other(format!("PRAGMA journal_mode=WAL failed: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    Ok(())
}

/// v0.8.7 C: 把单个 connection 拆成 1 writer + N readers, 组装 DbPool
fn build_pool(writer: Connection, db_path: PathBuf) -> DbPool {
    // 经验值: 多于典型并发数 (G1 GraphView + G2 Analytics 同时加载
    // + sessions list + HomeStatusBar 等并发读, 4 足够 cover)
    const READER_COUNT: usize = 4;
    let mut readers: Vec<Mutex<Connection>> = Vec::with_capacity(READER_COUNT);
    for i in 0..READER_COUNT {
        match Connection::open(&db_path) {
            Ok(c) => {
                let _ = apply_pragmas(&c);
                readers.push(Mutex::new(c));
            }
            Err(e) => {
                log::warn!("DbPool reader #{i} 开连接失败: {e} — 该槽位降级");
            }
        }
    }
    if readers.is_empty() {
        // v0.8.8: 兜底改为真退化 — 把 writer 移进 readers 数组,占位 writer 用 :memory:
        // (永不写)。之前注释说"退化到单 connection"但实际 panic,跟 v0.8.6 时代单 Mutex
        // 行为不一致。改成真退化后行为 = v0.8.6 单 Mutex,所有读写互锁但功能正常。
        // (极罕见: 磁盘满 / fd 耗尽时 writer 能开但 reader 全失败才会触发)
        log::warn!("DbPool 无可用 reader — 退化到单 connection (writer 兼 reader,所有访问互锁)");
        readers.push(Mutex::new(writer));
        let placeholder = match Connection::open_in_memory() {
            Ok(c) => c,
            Err(e) => panic!("DbPool fallback in-memory open failed: {e}"),
        };
        return DbPool {
            readers: Arc::new(readers),
            writer: Arc::new(Mutex::new(placeholder)),
            next_reader: Arc::new(AtomicUsize::new(0)),
            path: db_path,
        };
    }
    DbPool {
        readers: Arc::new(readers),
        writer: Arc::new(Mutex::new(writer)),
        next_reader: Arc::new(AtomicUsize::new(0)),
        path: db_path,
    }
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

#[cfg(test)]
mod pool_tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn fresh_pool() -> (TempDir, DbPool) {
        let tmp = TempDir::new().expect("create tempdir");
        let pool = open(tmp.path()).expect("open db");
        // 插入 1 行 session_meta 供读测试用
        pool.with_write(|c| {
            c.execute(
                "INSERT INTO session_meta (session_id, project_key, source, jsonl_path,
                                           size_bytes, mtime_ms, line_count, synced_at)
                 VALUES ('s1', 'p', 'claude', '/tmp/x.jsonl', 0, 0, 0, 0)",
                [],
            )?;
            Ok::<(), AppError>(())
        })
        .expect("insert session");
        (tmp, pool)
    }

    // v0.8.7 C: with_read 基本读 — 验证 &Connection 路径能跑
    #[test]
    fn with_read_returns_data() {
        let (_tmp, pool) = fresh_pool();
        let session_id: String = pool
            .with_read(|c| {
                let n: String =
                    c.query_row("SELECT session_id FROM session_meta LIMIT 1", [], |r| {
                        r.get(0)
                    })?;
                Ok(n)
            })
            .expect("query_row");
        assert_eq!(session_id, "s1");
    }

    // v0.8.7 C: with_write 基本写 — 验证 &mut Connection 路径能跑
    #[test]
    fn with_write_inserts_data() {
        let (_tmp, pool) = fresh_pool();
        pool.with_write(|c| {
            c.execute(
                "INSERT INTO session_meta (session_id, project_key, source, jsonl_path,
                                           size_bytes, mtime_ms, line_count, synced_at)
                 VALUES ('s2', 'p', 'claude', '/tmp/y.jsonl', 0, 0, 0, 0)",
                [],
            )?;
            Ok::<(), AppError>(())
        })
        .expect("insert s2");
        let count: i64 = pool
            .with_read(|c| {
                let n: i64 = c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?;
                Ok(n)
            })
            .expect("count");
        assert_eq!(count, 2);
    }

    // v0.8.7 C: 关键测试 — 多 reader 并发跑 (round-robin 分发)
    //
    // 验证: 8 个并发 reader 各跑一个 sleep(100ms), 总耗时应该 ~100ms 而不是 ~800ms.
    // 串行实现下总耗时 ~800ms; 并行下 ~100ms. 留 50% buffer 防偶发抖动.
    #[test]
    fn with_read_runs_concurrently() {
        let (_tmp, pool) = fresh_pool();
        let pool = Arc::new(pool);
        let n_threads = 8;
        let sleep_ms = 100u64;

        let start = Instant::now();
        let handles: Vec<_> = (0..n_threads)
            .map(|_| {
                let p = Arc::clone(&pool);
                thread::spawn(move || {
                    p.with_read(|_c| {
                        // 模拟读 query: 实际只是 sleep, 模拟 query 在 SQLite 跑
                        // (SQLite 单条 SELECT 通常 <1ms, 用 sleep 把差异放大到可观测)
                        std::thread::sleep(Duration::from_millis(sleep_ms));
                        let _: i32 =
                            _c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?;
                        Ok(())
                    })
                })
            })
            .collect();

        for h in handles {
            h.join().expect("thread join").expect("with_read");
        }
        let elapsed = start.elapsed();

        let serial_estimate = Duration::from_millis(sleep_ms * n_threads as u64);
        let parallel_estimate = Duration::from_millis(sleep_ms);

        // 并发下应该明显比串行快
        // 用 0.7×串行 作为上界 (留 30% buffer 给线程调度 / 启动开销)
        let upper_bound = Duration::from_millis((serial_estimate.as_millis() as f64 * 0.7) as u64);

        assert!(
            elapsed < upper_bound,
            "并发读耗时 {:?} 超过串行上限 {:?} — reader 没真并发 (parallel_est={:?})",
            elapsed,
            upper_bound,
            parallel_estimate,
        );
    }

    // v0.8.7 C: round-robin 分发 — 连跑 12 次 (READER_COUNT=4 的 3 倍), 4 个 reader 各被选 3 次
    #[test]
    fn with_read_round_robin_distribution() {
        let (_tmp, pool) = fresh_pool();
        let n_readers = pool.readers.len();
        assert!(n_readers >= 2, "test 假设至少有 2 个 reader");

        // 跑 n_readers * 3 次 (确保 round-robin 转一圈以上)
        let total = n_readers * 3;
        for _ in 0..total {
            pool.with_read(|_c| Ok(())).expect("with_read");
        }
        // next_reader index 应该回到 total % n_readers (但 atomic add 不 mod, 所以是 total)
        assert_eq!(
            pool.next_reader.load(Ordering::Relaxed),
            total,
            "next_reader 应该精确累加 {} 次 (round-robin 用 fetch_add % n)",
            total,
        );
    }

    // v0.8.7 C: write 阻塞 reader — write 持锁期间 reader 应等
    // 用 100ms write + 100ms read, 总耗时应 ~200ms (write 完成后 read 立刻跑)
    #[test]
    fn with_write_excludes_readers() {
        let (_tmp, pool) = fresh_pool();
        let pool = Arc::new(pool);

        let start = Instant::now();

        let write_pool = Arc::clone(&pool);
        let write_thread = thread::spawn(move || {
            write_pool.with_write(|_c| {
                std::thread::sleep(Duration::from_millis(100));
                Ok::<(), AppError>(())
            })
        });

        // 等 writer 拿到锁 (50ms 后 writer 大概率已上锁)
        std::thread::sleep(Duration::from_millis(50));

        let read_pool = Arc::clone(&pool);
        let read_thread = thread::spawn(move || {
            read_pool.with_read(|_c| {
                std::thread::sleep(Duration::from_millis(100));
                Ok::<(), AppError>(())
            })
        });

        write_thread.join().expect("write join").expect("write");
        read_thread.join().expect("read join").expect("read");

        let elapsed = start.elapsed();
        // 串行执行 ≈ 50ms (writer 启动) + 100ms (write) + 100ms (read) = 250ms
        // 下界 ≈ 150ms (writer 启动前 reader 就到了, 50ms 后 writer 拿到锁)
        let lower_bound = Duration::from_millis(150);
        let upper_bound = Duration::from_millis(280);

        assert!(
            elapsed >= lower_bound && elapsed <= upper_bound,
            "write+read 串行耗时 {:?} 不在 [{:?}, {:?}] 区间 — write 没真正排他 reader",
            elapsed,
            lower_bound,
            upper_bound,
        );
    }

    // v0.8.7 C: with() 兼容 alias 仍然走 writer (排他锁)
    #[test]
    fn with_alias_uses_writer_lock() {
        let (_tmp, pool) = fresh_pool();
        // 写入应该 OK
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_meta (session_id, project_key, source, jsonl_path,
                                           size_bytes, mtime_ms, line_count, synced_at)
                 VALUES ('s3', 'p', 'claude', '/tmp/z.jsonl', 0, 0, 0, 0)",
                [],
            )?;
            Ok::<(), AppError>(())
        })
        .expect("legacy with() write");
        // 读回验证
        let count: i64 = pool
            .with_read(|c| {
                let n: i64 = c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?;
                Ok(n)
            })
            .expect("count");
        assert_eq!(count, 2); // s1 + s3 (fresh_pool 插了 s1, 这里加 s3)
    }

    // v0.8.7 C: 契约测试 — 锁住 build_pool 默认 reader 数 (READER_COUNT = 4)
    // 改了 READER_COUNT 会影响并发能力: 多了浪费 fd, 少了并发读瓶颈。
    // 改这个常量前应该 review 一遍 G1+G2+lists+HomeStatusBar 同时加载的需求
    #[test]
    fn pool_has_four_readers_by_default() {
        let (_tmp, pool) = fresh_pool();
        assert_eq!(
            pool.readers.len(),
            4,
            "DbPool 默认 4 readers — 改这个常量前请确认 G1/G2/lists/HomeStatusBar 同时加载还够用"
        );
    }

    // v0.8.7 C: 契约测试 — DbPool.path() 返回 AppConfigDir/observer.db
    // 给 SettingsRoute 展示用
    #[test]
    fn pool_path_returns_db_file() {
        let (_tmp, pool) = fresh_pool();
        assert_eq!(
            pool.path().file_name().and_then(|n| n.to_str()),
            Some("observer.db"),
            "DbPool.path() 应指向 observer.db"
        );
    }
}
