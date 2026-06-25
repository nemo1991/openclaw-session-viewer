//! OpenClaw trajectory 事件归一化
//!
//! 文件格式见 `docs/OPENCLAW_SESSION_FORMAT.md` 第 2 节:
//! 8 种事件 + envelope 通用字段 (traceSchema / schemaVersion / traceId / source /
//! type / ts / seq / sourceSeq / sessionId / sessionKey / runId / workspaceDir /
//! provider / modelId / modelApi / entryId / parentEntryId / data)

use serde::Serialize;
use serde_json::Value;

/// 单个 trajectory 事件归一化输出
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryEvent {
    /// 原始 seq (1-based)
    pub seq: u64,
    /// 事件类型,如 "session.started"
    pub event_type: String,
    /// ISO 8601 时间戳
    pub ts: String,
    /// envelope 透传字段(provider / modelId / entryId / parentEntryId 等)
    #[serde(flatten)]
    pub envelope: serde_json::Map<String, Value>,
    /// 事件特定 payload
    pub data: Value,
}

/// 归一化单个 trajectory 事件。
/// 失败返回 None(损坏行跳过)。
pub fn normalize_event(seq: u64, item: &Value) -> Option<TrajectoryEvent> {
    let obj = item.as_object()?;

    // envelope 字段:除 type/ts/seq/sourceSeq/data 外都透传
    let mut envelope = serde_json::Map::new();
    for (k, v) in obj {
        match k.as_str() {
            "type" | "ts" | "seq" | "sourceSeq" | "data" | "traceSchema" | "schemaVersion" => {
                continue;
            }
            _ => {
                envelope.insert(k.clone(), v.clone());
            }
        }
    }

    let event_type = obj.get("type")?.as_str()?.to_string();
    let ts = obj.get("ts")?.as_str()?.to_string();
    let data = obj.get("data").cloned().unwrap_or(Value::Null);

    Some(TrajectoryEvent {
        seq,
        event_type,
        ts,
        envelope,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_session_started() {
        let ev = normalize_event(
            1,
            &json!({
                "traceSchema": "openclaw-trajectory",
                "schemaVersion": 1,
                "traceId": "abc",
                "source": "runtime",
                "type": "session.started",
                "ts": "2026-06-23T07:24:38.563Z",
                "seq": 1,
                "sessionId": "abc",
                "sessionKey": "agent:main:main",
                "runId": "r1",
                "workspaceDir": "/tmp",
                "provider": "minimax",
                "modelId": "MiniMax-M3",
                "modelApi": "anthropic-messages",
                "data": {
                    "trigger": "user",
                    "agentId": "main"
                }
            }),
        )
        .unwrap();
        assert_eq!(ev.event_type, "session.started");
        assert_eq!(ev.seq, 1);
        assert_eq!(ev.ts, "2026-06-23T07:24:38.563Z");
        // envelope 透传 provider/modelId
        assert_eq!(
            ev.envelope.get("provider").and_then(|v| v.as_str()),
            Some("minimax")
        );
        assert_eq!(
            ev.envelope.get("modelId").and_then(|v| v.as_str()),
            Some("MiniMax-M3")
        );
        // data 保留为对象
        assert_eq!(
            ev.data.get("trigger").and_then(|v| v.as_str()),
            Some("user")
        );
    }

    #[test]
    fn normalize_skips_invalid() {
        assert!(normalize_event(1, &json!({"type": "session.started"})).is_none()); // 缺 ts
        assert!(normalize_event(1, &json!(null)).is_none()); // 非对象
    }

    #[test]
    fn normalize_session_ended() {
        let ev = normalize_event(
            10,
            &json!({
                "type": "session.ended",
                "ts": "2026-06-23T07:30:00Z",
                "seq": 10,
                "data": {"status": "success"}
            }),
        )
        .unwrap();
        assert_eq!(ev.event_type, "session.ended");
        assert_eq!(
            ev.data.get("status").and_then(|v| v.as_str()),
            Some("success")
        );
        assert!(ev.envelope.is_empty());
    }
}
