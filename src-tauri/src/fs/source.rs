//! v0.9.0: 单一 source 推断入口 — 替换散落 `path.contains(".openclaw")` 判断
//!
//! 新增 source 时只动这一处。返回 `"claude" | "openclaw" | "kimi"` 跟 DB CHECK
//! 约束和 SessionSource TS 联合对齐。

/// 根据 jsonl 路径字符串推断 source。
///
/// 约定:
/// - 含 `.openclaw` → OpenClaw
/// - 含 `.kimi` → Kimi (v0.9.0 新增)
/// - 其他 → Claude (兜底,跟原有行为一致)
pub fn source_from_path(path: &str) -> &'static str {
    if path.contains(".openclaw") {
        "openclaw"
    } else if path.contains(".kimi") {
        "kimi"
    } else {
        "claude"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_from_path_distinguishes_kimi_openclaw_claude() {
        assert_eq!(
            source_from_path("/home/u/.claude/projects/x/y.jsonl"),
            "claude"
        );
        assert_eq!(
            source_from_path("/home/u/.openclaw/agents/a/sessions/s.jsonl"),
            "openclaw"
        );
        assert_eq!(
            source_from_path("/home/u/.kimi/sessions/wd_x/session_y/agents/main/wire.jsonl"),
            "kimi"
        );
    }

    #[test]
    fn source_from_path_handles_nested_paths() {
        // 含子串匹配 — 即使中间段也认
        assert_eq!(source_from_path("/var/folders/.kimi/foo.jsonl"), "kimi");
        assert_eq!(
            source_from_path("/tmp/backup/.openclaw/x.jsonl"),
            "openclaw"
        );
    }

    #[test]
    fn source_from_path_defaults_to_claude() {
        assert_eq!(source_from_path("/tmp/random.jsonl"), "claude");
        assert_eq!(source_from_path(""), "claude");
    }
}
