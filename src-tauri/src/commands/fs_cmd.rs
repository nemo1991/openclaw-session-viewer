//! FS 辅助命令

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;

/// 弹出目录选择对话框
#[tauri::command]
pub async fn pick_export_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let path = rx.await.map_err(|e| e.to_string())?;
    Ok(path.map(|p| p.to_string()))
}

/// v0.6.0: 在 Finder/Explorer 中显示文件,带 workspace 安全沙箱
///
/// 参数:
/// - path: 要 reveal 的文件/目录
/// - workspace_root: 调用方 session 的 workspaceGuess(null = 不约束)
/// - allow_relaxed: 来自 settings.pathSecurity.allowRelaxed
///                   true → 放宽到"任一已知 root 下"(仍受 assert_within_any_root 兜底)
///                   false → 必须严格在 workspace_root 子树内
///
/// 错误:
/// - "PathSecurity: 路径不在 workspace 内" (lock-down 模式)
/// - "PathSecurity: 路径不在任一已知 root 下" (relaxed 模式)
/// - "PathSecurity: 需提供 workspace_root" (lock-down 但没传 root)
#[tauri::command]
pub async fn reveal_in_finder(
    path: String,
    workspace_root: Option<String>,
    allow_relaxed: bool,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let p = Path::new(&path);
    if !allow_relaxed {
        let root = workspace_root
            .as_deref()
            .ok_or_else(|| "PathSecurity: 需提供 workspace_root (lock-down 模式)".to_string())?;
        let root_p = Path::new(root);
        if !path_within(p, root_p) {
            return Err(format!(
                "PathSecurity: {:?} 不在 workspace {:?} 内",
                p, root_p
            ));
        }
    } else {
        // relaxed 模式:仍需在任一已知 root 下(防 ~/.ssh/id_rsa)
        crate::fs::paths::assert_within_any_root(&state.paths.read(), p)
            .map_err(|e| e.to_string())?;
    }

    use tauri_plugin_shell::ShellExt;
    let path_for_shell = path.clone();
    let shell = app.shell();
    #[cfg(target_os = "macos")]
    {
        shell
            .command("open")
            .args(["-R", &path_for_shell])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        shell
            .command("explorer")
            .args(["/select,", &path_for_shell])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // 尝试常见文件管理器
        let _ = shell.command("xdg-open").args([&path_for_shell]).spawn();
    }
    Ok(())
}

/// 路径"target 是 base 的子路径"比较,跨平台安全
/// (跟 paths::path_starts_with 一样的语义,但不依赖 state,纯函数便于单测)
fn path_within(target: &Path, base: &Path) -> bool {
    let norm = |p: &Path| -> String {
        let s = p.to_string_lossy();
        s.strip_prefix(r"\\?\")
            .unwrap_or(&s)
            .replace('\\', "/")
            .to_lowercase()
    };
    let t = norm(target);
    let b = norm(base);
    if t == b {
        return true;
    }
    let b_with_sep = if b.ends_with('/') {
        b.clone()
    } else {
        format!("{}/", b)
    };
    t.starts_with(&b_with_sep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_within_exact_match() {
        assert!(path_within(Path::new("/a/b/c"), Path::new("/a/b/c")));
    }

    #[test]
    fn path_within_subpath() {
        assert!(path_within(Path::new("/a/b/c/d"), Path::new("/a/b/c")));
        assert!(path_within(
            Path::new("/a/b/c/d/e.txt"),
            Path::new("/a/b/c")
        ));
    }

    #[test]
    fn path_within_parent_path_returns_false() {
        // /a/b 不是 /a/b/c 的子路径
        assert!(!path_within(Path::new("/a/b"), Path::new("/a/b/c")));
    }

    #[test]
    fn path_within_sibling_returns_false() {
        // /a/c 不是 /a/b 的子路径(防止 /a/b 通过 /a 误判)
        assert!(!path_within(Path::new("/a/c"), Path::new("/a/b")));
        // 关键: 严格 base 必须以 separator 结尾避免前缀误判
        assert!(!path_within(Path::new("/a/bb"), Path::new("/a/b")));
    }

    #[test]
    fn path_within_traversal_lexical_only() {
        // ⚠️ 已知限制: 词法检查不解析 `..` — `/a/b/../c` 字符串以 `/a/b/` 开头,
        // 会被词法误判为 inside `/a/b`。
        // 实际防越界靠 assert_within_any_root 兜底(走 canonicalize)
        // 跟 paths::path_starts_with 同样的语义,不在 fs_cmd 重复造轮子
        assert!(path_within(Path::new("/a/b/../c"), Path::new("/a/b")));
    }
}
