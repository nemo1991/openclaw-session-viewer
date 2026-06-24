//! 基于 mtime + size 的简单缓存层
//!
//! 键: (绝对路径, mtime_ms, size_bytes)
//! 失效: mtime 或 size 变化时,旧条目作废

use std::path::Path;
use std::time::Duration;

use moka::future::Cache;

use crate::error::AppResult;
use crate::model::SessionMeta;

#[derive(Clone)]
pub struct MetaCache {
    inner: Cache<PathKey, SessionMeta>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct PathKey {
    path: String,
    mtime_ms: u64,
    size: u64,
}

impl PathKey {
    fn from(path: &Path) -> AppResult<Self> {
        let meta = std::fs::metadata(path)?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(Self {
            path: path.to_string_lossy().to_string(),
            mtime_ms,
            size: meta.len(),
        })
    }
}

impl MetaCache {
    pub fn new() -> Self {
        let inner = Cache::builder()
            .max_capacity(2048)
            .time_to_live(Duration::from_secs(60))
            .build();
        Self { inner }
    }

    pub async fn get(&self, path: &Path) -> Option<SessionMeta> {
        let key = PathKey::from(path).ok()?;
        self.inner.get(&key).await
    }

    pub async fn insert(&self, path: &Path, meta: SessionMeta) -> AppResult<()> {
        let key = PathKey::from(path)?;
        self.inner.insert(key, meta).await;
        Ok(())
    }

    pub fn invalidate(&self, path: &Path) {
        // 简化:直接 invalidate_by_prefix 不太好,这里只能等 TTL 或重建
        // 实际场景下 notify watcher 会触发列表重扫
        let _ = path;
    }

    /// v0.2.5: 全量清空缓存(热重载时调用)
    pub async fn invalidate_all(&self) {
        // moka 0.12 的 invalidate_all 是同步的
        self.inner.invalidate_all();
    }
}

impl Default for MetaCache {
    fn default() -> Self {
        Self::new()
    }
}
