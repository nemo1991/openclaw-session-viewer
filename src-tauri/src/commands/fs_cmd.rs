//! FS 辅助命令

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

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

/// 在 Finder/Explorer 中显示文件
#[tauri::command]
pub async fn reveal_in_finder(path: String, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let shell = app.shell();
    #[cfg(target_os = "macos")]
    {
        shell
            .command("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        shell
            .command("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // 尝试常见文件管理器
        let _ = shell.command("xdg-open").args([&path]).spawn();
    }
    Ok(())
}
