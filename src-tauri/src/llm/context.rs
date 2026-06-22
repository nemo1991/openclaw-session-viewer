//! 上下文裁剪:按用户选定的范围过滤 + 序列化

use crate::commands::analyze::AnalyzeRange;
use crate::parser::claude::NormalizedMessage;

pub fn build_context(entries: &[NormalizedMessage], range: &AnalyzeRange) -> String {
    let from = range.from_index.unwrap_or(0) as usize;
    let to = range.to_index.map(|t| t as usize).unwrap_or(entries.len());
    let only_user = range.only_user.unwrap_or(false);

    let mut out = String::new();
    out.push_str(&format!("共 {} 条消息(范围 {} - {})\n\n", entries.len(), from, to));

    for (i, e) in entries.iter().enumerate() {
        if i < from || i >= to {
            continue;
        }
        if only_user && e.role != "user" {
            continue;
        }
        out.push_str(&format!("\n--- [{}] {} · {} ---\n", i, e.timestamp.clone().unwrap_or_default(), e.role));
        for block in &e.blocks {
            match block.kind.as_str() {
                "text" => {
                    if let Some(text) = block.data.get("text").and_then(|v| v.as_str()) {
                        out.push_str(text);
                        out.push('\n');
                    }
                }
                "thinking" => {
                    let text = block
                        .data
                        .get("thinking")
                        .and_then(|v| v.as_str())
                        .or_else(|| block.data.get("text").and_then(|v| v.as_str()))
                        .unwrap_or("");
                    out.push_str(&format!("[思考] {}\n", text));
                }
                "tool_use" => {
                    let name = block.data.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let input = block
                        .data
                        .get("input")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_default();
                    out.push_str(&format!("[工具调用:{}] {}\n", name, input));
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
                                .map(|v| serde_json::to_string(v).unwrap_or_default())
                        })
                        .unwrap_or_default();
                    let is_err = block
                        .data
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let label = if is_err { "[工具结果:失败]" } else { "[工具结果]" };
                    // 截断过长的输出
                    let truncated = truncate(&content, 4000);
                    out.push_str(&format!("{} {}\n", label, truncated));
                }
                "meta" => {
                    let label = block
                        .data
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or("meta");
                    out.push_str(&format!("[元] {}\n", label));
                }
                _ => {
                    out.push_str(&format!("[{} block]\n", block.kind));
                }
            }
        }
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}\n...(截断,共 {} 字符)", &s[..max], s.len())
    }
}
