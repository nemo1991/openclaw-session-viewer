//! 导出 Markdown / HTML

use std::fs;
use std::path::Path;

use crate::error::AppResult;
use crate::parser::claude::normalize;
use crate::parser::jsonl;
use crate::parser::openclaw::normalize_entry;

/// 导出为 Markdown
#[tauri::command]
pub async fn export_markdown(path: String, out_path: String) -> AppResult<()> {
    let jsonl_path = Path::new(&path);
    if !jsonl_path.exists() {
        return Err(crate::error::AppError::NotFound(path));
    }
    let is_openclaw = path.contains(".openclaw");

    let mut md = String::new();
    md.push_str(&format!("# 会话导出\n\n**文件**: `{}`\n\n", path));

    jsonl::for_each_line(jsonl_path, |idx, _, v| {
        let norm = if is_openclaw {
            normalize_entry(v, idx)
        } else {
            normalize(v, idx)
        };
        if let Some(n) = norm {
            append_message_md(&mut md, &n);
        }
    })?;

    fs::write(&out_path, md)?;
    Ok(())
}

/// 导出为 HTML(独立可分享)
#[tauri::command]
pub async fn export_html(path: String, out_path: String) -> AppResult<()> {
    let jsonl_path = Path::new(&path);
    if !jsonl_path.exists() {
        return Err(crate::error::AppError::NotFound(path));
    }
    let is_openclaw = path.contains(".openclaw");

    let mut body = String::new();
    body.push_str(&format!(
        r#"<h1>会话导出</h1><p><code>{}</code></p>"#,
        escape_html(&path)
    ));

    jsonl::for_each_line(jsonl_path, |idx, _, v| {
        let norm = if is_openclaw {
            normalize_entry(v, idx)
        } else {
            normalize(v, idx)
        };
        if let Some(n) = norm {
            append_message_html(&mut body, &n);
        }
    })?;

    let full = HTML_TEMPLATE.replace("{{body}}", &body);
    fs::write(&out_path, full)?;
    Ok(())
}

fn append_message_md(md: &mut String, n: &crate::parser::claude::NormalizedMessage) {
    let ts = n.timestamp.clone().unwrap_or_default();
    let role = match n.role.as_str() {
        "user" => "👤 用户",
        "assistant" => "🤖 助手",
        "tool" => "🛠 工具",
        "system" => "⚙ 系统",
        _ => "📎 元信息",
    };
    md.push_str(&format!("\n## {} · {}\n\n", role, ts));
    if let Some(model) = &n.model {
        md.push_str(&format!("*模型: {}*\n\n", model));
    }
    for block in &n.blocks {
        match block.kind.as_str() {
            "text" => {
                if let Some(text) = block.data.get("text").and_then(|v| v.as_str()) {
                    md.push_str(text);
                    md.push_str("\n\n");
                }
            }
            "thinking" => {
                let text = block
                    .data
                    .get("thinking")
                    .and_then(|v| v.as_str())
                    .or_else(|| block.data.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("");
                md.push_str(&format!("<details><summary>💭 思考</summary>\n\n{}\n\n</details>\n\n", text));
            }
            "tool_use" => {
                let name = block.data.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                let input = block
                    .data
                    .get("input")
                    .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                    .unwrap_or_default();
                md.push_str(&format!("### 🔧 工具调用: `{}`\n\n```json\n{}\n```\n\n", name, input));
            }
            "tool_result" => {
                let content = block
                    .data
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        block
                            .data
                            .get("content")
                            .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                    })
                    .unwrap_or_default();
                let is_err = block
                    .data
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let label = if is_err { "❌ 工具结果 (失败)" } else { "✅ 工具结果" };
                md.push_str(&format!("### {} \n\n```\n{}\n```\n\n", label, content));
            }
            "meta" => {
                let label = block
                    .data
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("meta");
                md.push_str(&format!("> 📎 {}\n\n", label));
            }
            _ => {
                md.push_str(&format!("> 📎 {} block\n\n", block.kind));
            }
        }
    }
}

fn append_message_html(body: &mut String, n: &crate::parser::claude::NormalizedMessage) {
    let ts = n.timestamp.clone().unwrap_or_default();
    let role_class = match n.role.as_str() {
        "user" => "msg-user",
        "assistant" => "msg-assistant",
        "tool" => "msg-tool",
        "system" => "msg-system",
        _ => "msg-meta",
    };
    let role_label = match n.role.as_str() {
        "user" => "👤 用户",
        "assistant" => "🤖 助手",
        "tool" => "🛠 工具",
        "system" => "⚙ 系统",
        _ => "📎 元信息",
    };
    body.push_str(&format!(
        r#"<div class="msg {}"><div class="msg-header">{} · {}</div>"#,
        role_class, role_label, escape_html(&ts)
    ));
    if let Some(model) = &n.model {
        body.push_str(&format!(
            r#"<div class="msg-model">模型: {}</div>"#,
            escape_html(model)
        ));
    }
    body.push_str("<div class=\"msg-body\">");
    for block in &n.blocks {
        match block.kind.as_str() {
            "text" => {
                if let Some(text) = block.data.get("text").and_then(|v| v.as_str()) {
                    body.push_str(&format!("<p>{}</p>", escape_html(text)));
                }
            }
            "thinking" => {
                let text = block
                    .data
                    .get("thinking")
                    .and_then(|v| v.as_str())
                    .or_else(|| block.data.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("");
                body.push_str(&format!(
                    r#"<details class="thinking"><summary>💭 思考</summary><pre>{}</pre></details>"#,
                    escape_html(text)
                ));
            }
            "tool_use" => {
                let name = block.data.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                let input = block
                    .data
                    .get("input")
                    .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                    .unwrap_or_default();
                body.push_str(&format!(
                    r#"<div class="tool-use"><b>🔧 {}</b><pre>{}</pre></div>"#,
                    escape_html(name),
                    escape_html(&input)
                ));
            }
            "tool_result" => {
                let content = block
                    .data
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        block
                            .data
                            .get("content")
                            .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                    })
                    .unwrap_or_default();
                let is_err = block
                    .data
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let cls = if is_err { "tool-result err" } else { "tool-result" };
                body.push_str(&format!(
                    r#"<div class="{}"><pre>{}</pre></div>"#,
                    cls,
                    escape_html(&content)
                ));
            }
            "meta" => {
                let label = block
                    .data
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("meta");
                body.push_str(&format!(r#"<div class="meta">📎 {}</div>"#, escape_html(label)));
            }
            _ => {
                body.push_str(&format!(
                    r#"<div class="meta">📎 {} block</div>"#,
                    block.kind
                ));
            }
        }
    }
    body.push_str("</div></div>\n");
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

const HTML_TEMPLATE: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>OpenClaw 会话导出</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; color: #1f2328; background: #ffffff; }
h1 { border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }
.msg { margin: 16px 0; padding: 12px 16px; border-radius: 8px; border: 1px solid #d0d7de; }
.msg-header { font-weight: 600; margin-bottom: 4px; color: #57606a; font-size: 13px; }
.msg-model { color: #6e7781; font-size: 12px; margin-bottom: 8px; }
.msg-body p { margin: 8px 0; line-height: 1.6; }
.msg-user { background: #ddf4ff; }
.msg-assistant { background: #f6f8fa; }
.msg-tool { background: #fff8c5; }
.msg-system { background: #fbefff; }
.msg-meta { background: #f6f8fa; }
.tool-use, .tool-result { margin: 8px 0; padding: 8px; background: #ffffff; border: 1px solid #d0d7de; border-radius: 4px; }
.tool-result.err { border-color: #cf222e; background: #ffebe9; }
.tool-use pre, .tool-result pre, .thinking pre { white-space: pre-wrap; word-wrap: break-word; font-size: 12px; max-height: 400px; overflow: auto; margin: 4px 0 0 0; }
.thinking { margin: 8px 0; }
.thinking summary { cursor: pointer; color: #57606a; font-size: 13px; }
.meta { color: #6e7781; font-size: 12px; font-style: italic; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  h1 { border-color: #30363d; }
  .msg, .tool-use, .tool-result { border-color: #30363d; }
  .msg-user { background: #0c2d6b; }
  .msg-assistant { background: #161b22; }
  .msg-tool { background: #341a00; }
  .msg-system { background: #2d1b3d; }
  .msg-meta { background: #161b22; }
  .tool-use, .tool-result { background: #0d1117; }
  .tool-result.err { background: #3c0d0d; border-color: #f85149; }
}
</style>
</head>
<body>
{{body}}
</body>
</html>
"#;
