//! 流式 `.jsonl.zstd` 解析器
//!
//! 设计:
//! - 复用 `parser/jsonl.rs` 的 64KB BufReader + 128KB count buffer 策略
//! - 把 `File` 用 `zstd::Decoder::new(file)` 包一层,语义透明(`Read` → `BufRead`)
//! - 损坏行 / 不完整行行为与 `jsonl.rs` 完全一致
//! - 调用方通过 `parser/jsonl::*_auto` 入口按文件后缀派发(`.zst` → 本模块)

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::error::AppResult;

/// 流式遍历整个 `.jsonl.zstd` 文件(逐行解压 + JSON 解析)。
///
/// 与 `jsonl::for_each_line` 行为一致:空行跳过,损坏行 warn + 跳过继续。
pub fn for_each_line_zst<F>(path: &Path, mut on_line: F) -> AppResult<()>
where
    F: FnMut(usize, u64, &serde_json::Value),
{
    let file = File::open(path)?;
    let decoder = zstd::Decoder::new(file)?;
    let mut reader = BufReader::with_capacity(64 * 1024, decoder);
    let mut index = 0usize;
    let mut byte: u64 = 0;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        byte += n as u64;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => {
                on_line(index, byte, &v);
                index += 1;
            }
            Err(e) => {
                log::warn!(
                    "跳过损坏的 JSONL.zstd 行 ({}:{}): {}",
                    path.display(),
                    index,
                    e
                );
            }
        }
    }
    Ok(())
}

/// 只解析前 N 行(用于提取 quick meta / fixture 检查)。
pub fn parse_first_n_zst(path: &Path, max: usize) -> AppResult<Vec<serde_json::Value>> {
    let mut out = Vec::with_capacity(max.min(64));
    for_each_line_zst(path, |idx, _, v| {
        if idx < max {
            out.push(v.clone());
        }
    })?;
    Ok(out)
}

/// 计数 `.jsonl.zstd` 文件的记录数(不解压完整文件,逐行 inflate + trim)。
#[allow(dead_code)]
pub fn count_lines_zst(path: &Path) -> AppResult<u64> {
    let file = File::open(path)?;
    let decoder = zstd::Decoder::new(file)?;
    let reader = BufReader::with_capacity(128 * 1024, decoder);
    let mut count = 0u64;
    for line in reader.lines() {
        let line = line?;
        if !line.trim().is_empty() {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zst(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("ocsv_test_zst");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let raw = std::fs::File::create(&path).unwrap();
        let mut enc = zstd::Encoder::new(raw, 3).unwrap();
        enc.write_all(content.as_bytes()).unwrap();
        enc.finish().unwrap();
        path
    }

    #[test]
    fn round_trips_basic_lines() {
        let p = write_zst("basic.jsonl.zstd", "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n");
        let mut got = vec![];
        for_each_line_zst(&p, |_, _, v| {
            got.push(v["a"].as_i64().unwrap());
        })
        .unwrap();
        assert_eq!(got, vec![1, 2, 3]);
    }

    #[test]
    fn handles_empty_file() {
        let p = write_zst("empty.jsonl.zstd", "");
        let mut count = 0;
        for_each_line_zst(&p, |_, _, _| count += 1).unwrap();
        assert_eq!(count, 0);
        assert_eq!(count_lines_zst(&p).unwrap(), 0);
    }

    #[test]
    fn handles_truncated_trailing_line() {
        // 末行无换行符——read_line 仍能完整取出。
        let p = write_zst("truncated.jsonl.zstd", "{\"a\":1}\n{\"a\":2}");
        let mut got = vec![];
        for_each_line_zst(&p, |_, _, v| {
            got.push(v["a"].as_i64().unwrap());
        })
        .unwrap();
        assert_eq!(got, vec![1, 2]);
    }

    #[test]
    fn for_each_line_skips_malformed() {
        let content = "{\"ok\":1}\nNOT JSON\n{\"ok\":2}\n{\"ok\":3}\n";
        let p = write_zst("malformed.jsonl.zstd", content);
        let mut indices = vec![];
        for_each_line_zst(&p, |idx, _, v| {
            indices.push(idx);
            assert_eq!(v["ok"], idx as i64 + 1);
        })
        .unwrap();
        assert_eq!(indices.len(), 3);
    }

    #[test]
    fn for_each_line_skips_blanks() {
        let content = "{\"a\":1}\n\n{\"a\":2}\n   \n{\"a\":3}\n";
        let p = write_zst("blank.jsonl.zstd", content);
        assert_eq!(count_lines_zst(&p).unwrap(), 3);
    }

    #[test]
    fn parse_first_n_zst_basic() {
        let content: String = (0..10).map(|i| format!("{{\"i\":{}}}\n", i)).collect();
        let p = write_zst("first_n.jsonl.zstd", &content);
        let first = parse_first_n_zst(&p, 5).unwrap();
        assert_eq!(first.len(), 5);
        assert_eq!(first[0]["i"], 0);
        assert_eq!(first[4]["i"], 4);
    }
}
