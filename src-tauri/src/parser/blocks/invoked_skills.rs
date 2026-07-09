//! invoked_skills block handler (v0.8.4)
//!
//! `{ type: "invoked_skills", skills: [{ name, path, content }] }`
//!
//! 只取 name + path;content 是完整的 skill prompt 文本, 不进 DB / 不序列化到前端。

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// invoked-skills: 当前调用的 skill 列表 (v0.8.4 item 4)
pub struct InvokedSkillsHandler;

impl BlockHandler for InvokedSkillsHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("invoked_skills")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(skills) = item.get("skills").and_then(|v| v.as_array()) {
            let minimal: Vec<Value> = skills
                .iter()
                .map(|s| {
                    let mut m = serde_json::Map::new();
                    if let Some(n) = s.get("name").and_then(|v| v.as_str()) {
                        m.insert("name".to_string(), Value::String(n.to_string()));
                    }
                    if let Some(p) = s.get("path").and_then(|v| v.as_str()) {
                        m.insert("path".to_string(), Value::String(p.to_string()));
                    }
                    Value::Object(m)
                })
                .collect();
            data.insert("skills".to_string(), Value::Array(minimal));
        }
        Ok(NormalizedBlock {
            kind: "invoked_skills".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "invoked_skills"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn invoked_skills_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "invoked_skills",
                "skills": [
                    {"name": "statusline", "path": "builtin:statusline", "content": "ignore me"}
                ]
            }))
            .unwrap();
        assert_eq!(n.kind, "invoked_skills");
        let skills = n.data.get("skills").and_then(|v| v.as_array()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(
            skills[0].get("name").and_then(|v| v.as_str()),
            Some("statusline")
        );
        // content 不应进入 data
        assert!(skills[0].get("content").is_none());
    }

    #[test]
    fn invoked_skills_empty() {
        let r = default_registry();
        let n = r.normalize(&json!({"type": "invoked_skills"})).unwrap();
        assert_eq!(n.kind, "invoked_skills");
    }
}
