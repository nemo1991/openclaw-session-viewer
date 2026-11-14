/**
 * v0.10 (Epic 1 / FR-T4): 归一化契约测试（TS 侧）
 *
 * 与 Rust 侧 `src-tauri/src/parser/contract.rs` 共用同一份脱敏样本
 * (`src/__fixtures__/contract-samples.json`)，对照 Rust 生成的快照
 * (`src/generated/normalize-contract-rust.json`)。
 *
 * 断言 PRD FR-T4 规定的 4 类关键字段在两侧完全一致：
 *   - role
 *   - block 类型序列 (blockKinds)
 *   - token 用量 (tokenUsage)
 *   - error 标记 (hasError = stopReason=="error" 或任一 tool_result.is_error)
 *
 * 任一字段不一致即 FAIL，并打印所有差异字段（含期望值 / 实际值 / 样本 id / source）。
 *
 * CI 顺序：先 `cargo test --lib parser::contract::...` 生成/刷新 Rust 快照，
 * 再跑本测试。修改任一 Rust 归一化结构体字段或 TS 归一化逻辑导致漂移，
 * 这里会直接阻断合并。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  normalizeClaudeRecord,
  normalizeOpenClawEntry,
  normalizeKimiRecord,
  normalizeDshRecord,
  type NormalizedMessage,
  type SessionSource,
} from "./index.js";
import type { ClaudeRecord } from "./claude-types.js";
import type { OpenClawEntry } from "./openclaw-types.js";
import type { KimiRecord } from "./kimi-types.js";

interface ContractSample {
  id: string;
  source: SessionSource;
  index: number;
  record: unknown;
}

/** 两侧共用的「关键字段投影」形状 */
interface Projection {
  normalized: boolean;
  role: string | null;
  blockKinds: string[];
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  hasError: boolean;
}

interface RustCase extends Projection {
  id: string;
  source: string;
  index: number;
}

const FIXTURES = new URL("./__fixtures__/contract-samples.json", import.meta.url);
const RUST_SNAPSHOT = new URL("./generated/normalize-contract-rust.json", import.meta.url);

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

/**
 * 规范化序列化：递归按键排序，避免 Rust(ts-rs/serde_json BTreeMap) 与 TS
 * 对象字面量的键顺序不同造成伪差异。语义一致即视为一致。
 */
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

/** TS 侧归一化入口分派（与 Rust contract.rs 的 normalize_sample 一一对应） */
function normalizeBySource(sample: ContractSample): NormalizedMessage | null {
  const { source, record, index } = sample;
  switch (source) {
    case "claude":
      return normalizeClaudeRecord(record as ClaudeRecord, index);
    case "openclaw":
      return normalizeOpenClawEntry(record as OpenClawEntry, index);
    case "kimi":
      return normalizeKimiRecord(record as KimiRecord, index);
    case "dsh":
      return normalizeDshRecord(record, index);
    default:
      throw new Error(`契约样本出现未知 source: ${source satisfies never}`);
  }
}

/** 把 TS NormalizedMessage 投影成契约关键字段（与 Rust project() 语义一致） */
function project(msg: NormalizedMessage | null): Projection {
  if (!msg) {
    return {
      normalized: false,
      role: null,
      blockKinds: [],
      tokenUsage: null,
      hasError: false,
    };
  }
  const hasError = msg.stopReason === "error" || msg.blocks.some((b) => b.is_error === true);
  const tokenUsage = msg.tokenUsage
    ? {
        input: msg.tokenUsage.input,
        output: msg.tokenUsage.output,
        cacheRead: msg.tokenUsage.cacheRead,
        cacheWrite: msg.tokenUsage.cacheWrite,
      }
    : null;
  return {
    normalized: true,
    role: msg.role,
    blockKinds: msg.blocks.map((b) => b.kind),
    tokenUsage,
    hasError,
  };
}

const FIELDS: Array<keyof Projection> = [
  "normalized",
  "role",
  "blockKinds",
  "tokenUsage",
  "hasError",
];

/** 逐样本逐字段对照，返回全部差异描述（PRD FR-T4: 任一字段不一致即 FAIL） */
function collectDiffs(samples: ContractSample[], rustCases: RustCase[]): string[] {
  const rustById = new Map(rustCases.map((c) => [c.id, c]));
  const diffs: string[] = [];

  for (const sample of samples) {
    const expected = rustById.get(sample.id);
    if (!expected) {
      diffs.push(`[${sample.id}] Rust 快照缺少该样本`);
      continue;
    }
    if (expected.source !== sample.source || expected.index !== sample.index) {
      diffs.push(
        `[${sample.id}] 元信息不一致: source/index = ${expected.source}/${expected.index} (rust) vs ${sample.source}/${sample.index} (ts)`
      );
    }

    const actual = project(normalizeBySource(sample));
    for (const field of FIELDS) {
      const e = canonicalize(expected[field]);
      const a = canonicalize(actual[field]);
      if (e !== a) {
        diffs.push(
          `[${sample.id}] (${sample.source}) 字段 ${field} 不一致:\n` +
            `      rust: ${e}\n` +
            `      ts  : ${a}`
        );
      }
    }
  }
  return diffs;
}

describe("FR-T4 归一化契约 (Rust ↔ TS)", () => {
  const samples = readJson<{ version: number; samples: ContractSample[] }>(FIXTURES).samples;
  const rust = readJson<{ version: number; source: string; cases: RustCase[] }>(RUST_SNAPSHOT);

  it("样本集覆盖全部 4 种 source 且快照版本/条数一致", () => {
    const sources = [...new Set(samples.map((s) => s.source))].sort();
    expect(sources).toEqual(["claude", "dsh", "kimi", "openclaw"]);
    expect(rust.version).toBe(1);
    expect(rust.source).toBe("rust");
    expect(rust.cases).toHaveLength(samples.length);
  });

  it("每个样本的关键字段 (role / block 类型 / token / error 标记) 与 Rust 一致", () => {
    const diffs = collectDiffs(samples, rust.cases);
    // 一次性打印全部差异字段，便于定位漂移点
    expect(diffs, diffs.length ? `归一化契约漂移:\n${diffs.join("\n")}` : undefined).toEqual([]);
  });

  it("门禁自检：注入 4 类伪造漂移均应被检出并打印差异字段", () => {
    const tamper = (id: string, patch: Partial<RustCase>): { cases: RustCase[]; label: string } => {
      const cases = rust.cases.map((c) => (c.id === id ? { ...c, ...patch } : c));
      return { cases, label: Object.keys(patch).join(",") };
    };
    const injections = [
      tamper("claude-user-text", { role: "assistant" }), // role 漂移
      tamper("claude-assistant-tool-use-token", { blockKinds: ["text"] }), // block 类型漂移
      tamper("dsh-assistant-message-token-tool", {
        tokenUsage: { input: 999, output: 12, cacheRead: 40, cacheWrite: 5 },
      }), // token 漂移
      tamper("claude-tool-result-error", { hasError: false }), // error 标记漂移
    ];
    for (const { cases, label } of injections) {
      const diffs = collectDiffs(samples, cases);
      expect(diffs.length, `注入 ${label} 漂移却未被检出`).toBeGreaterThan(0);
      expect(diffs.join("\n")).toContain("不一致");
    }
  });
});
