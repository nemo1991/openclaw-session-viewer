//! 路径解析 — Claude Code 和 OpenClaw 目录布局

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ClaudePaths {
    pub home: PathBuf,
    pub projects_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub session_env_dir: PathBuf,
    pub tasks_dir: PathBuf,
    pub shell_snapshots_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub file_history_dir: PathBuf,
    pub plugins_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub history_file: PathBuf,
    pub settings_file: PathBuf,
}

impl ClaudePaths {
    pub fn new(home_dir: &Path) -> Self {
        let home = home_dir.join(".claude");
        Self {
            home: home.clone(),
            projects_dir: home.join("projects"),
            sessions_dir: home.join("sessions"),
            session_env_dir: home.join("session-env"),
            tasks_dir: home.join("tasks"),
            shell_snapshots_dir: home.join("shell-snapshots"),
            backups_dir: home.join("backups"),
            file_history_dir: home.join("file-history"),
            plugins_dir: home.join("plugins"),
            skills_dir: home.join("skills"),
            cache_dir: home.join("cache"),
            history_file: home.join("history.jsonl"),
            settings_file: home.join("settings.json"),
        }
    }

    pub fn exists(&self) -> bool {
        self.home.exists()
    }
}

#[derive(Debug, Clone)]
pub struct OpenClawPaths {
    pub home: PathBuf,
    pub agents_dir: PathBuf,
}

impl OpenClawPaths {
    pub fn new(home_dir: &Path) -> Self {
        Self {
            home: home_dir.join(".openclaw"),
            agents_dir: home_dir.join(".openclaw").join("agents"),
        }
    }

    pub fn exists(&self) -> bool {
        self.home.exists()
    }
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub home: PathBuf,
    pub claude: ClaudePaths,
    pub openclaw: Option<OpenClawPaths>,
}

impl AppPaths {
    pub fn new(home_dir: PathBuf) -> Self {
        let claude = ClaudePaths::new(&home_dir);
        let openclaw = OpenClawPaths::new(&home_dir);
        Self {
            home: home_dir,
            claude,
            openclaw: if openclaw.exists() {
                Some(openclaw)
            } else {
                None
            },
        }
    }
}

/// 路径安全检查(允许路径不存在):只做词法校验
pub fn assert_within_lexical(base: &Path, target: &Path) -> crate::error::AppResult<()> {
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let base_str = base_canon.to_string_lossy();
    let target_str = target.to_string_lossy();
    if !target_str.starts_with(base_str.as_ref()) {
        return Err(crate::error::AppError::PathSecurity(format!(
            "词法检查: {:?} 不在 {:?} 下",
            target, base
        )));
    }
    Ok(())
}

/// Claude 项目目录名编码(对应前端 paths.ts)
#[allow(dead_code)]
pub fn encode_project_key(abs_path: &str) -> String {
    const MAX: usize = 200;
    let sanitized: String = abs_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if sanitized.len() <= MAX {
        return sanitized;
    }
    let hash = simple_hash36(abs_path);
    format!("{}-{}", &sanitized[..MAX], hash)
}

#[allow(dead_code)]
fn simple_hash36(input: &str) -> String {
    let mut hash: u32 = 0;
    for b in input.bytes() {
        // wrapping_mul + wrapping_add 在 u32 上已经保证 wrap,不需要 & 0xFFFFFFFF
        hash = hash.wrapping_mul(31).wrapping_add(b as u32);
    }
    let mut n = hash;
    if n == 0 {
        return "0".to_string();
    }
    let mut out = String::new();
    while n > 0 {
        let r = n % 36;
        n /= 36;
        let c = if r < 10 {
            b'0' + r as u8
        } else {
            b'a' + (r - 10) as u8
        } as char;
        out.push(c);
    }
    out.chars().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_short_path() {
        let key = encode_project_key("/Users/foo/bar");
        assert_eq!(key, "-Users-foo-bar");
    }

    #[test]
    fn test_path_with_special_chars() {
        let key = encode_project_key("/Users/alice/my project@v1");
        // 所有非字母数字变成 -
        assert_eq!(key, "-Users-alice-my-project-v1");
    }

    #[test]
    fn test_long_path_truncates_and_hashes() {
        let long_path = format!("/Users/{}", "x".repeat(300));
        let key = encode_project_key(&long_path);
        // 200 字符限制 + "-" + 36 进制 hash
        assert!(key.len() <= 200 + 1 + 12);
        assert!(key.starts_with('-'));
        assert!(key.contains('-'));
    }

    #[test]
    fn test_simple_hash36_consistent() {
        let k1 = encode_project_key("/Users/test/path");
        let k2 = encode_project_key("/Users/test/path");
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_assert_within_lexical_accepts_subpath() {
        let base = std::path::Path::new("/Users/foo");
        let target = std::path::Path::new("/Users/foo/bar/baz");
        assert!(assert_within_lexical(base, target).is_ok());
    }

    #[test]
    fn test_assert_within_lexical_rejects_escape() {
        let base = std::path::Path::new("/Users/foo");
        let target = std::path::Path::new("/etc/passwd");
        assert!(assert_within_lexical(base, target).is_err());
    }
}
