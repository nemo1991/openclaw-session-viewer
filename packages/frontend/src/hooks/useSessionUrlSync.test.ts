/**
 * useSessionUrlSync 纯函数测试
 *
 * 覆盖:
 * - parseHasCsv:CSV → HasAttribute[],跳过非法值,trim,空
 * - parseToolCsv:CSV → string[],trim,跳过空段
 * - parseUrlSearch:search → 5 字段完整 snapshot,空 search,部分字段
 *
 * 注意:hook 本身(useEffect)需要 React render,本测试只覆盖导出的纯函数部分,
 * hook 行为由 SessionDetailRoute 的 e2e 验证。
 */

import { describe, it, expect } from "vitest";
import { parseHasCsv, parseToolCsv, parseUrlSearch } from "./useSessionUrlSync";

describe("parseHasCsv", () => {
  it("null → []", () => {
    expect(parseHasCsv(null)).toEqual([]);
  });

  it("空字符串 → []", () => {
    expect(parseHasCsv("")).toEqual([]);
  });

  it("单值", () => {
    expect(parseHasCsv("thinking")).toEqual(["thinking"]);
  });

  it("CSV 多值", () => {
    expect(parseHasCsv("thinking,error,subagent")).toEqual(["thinking", "error", "subagent"]);
  });

  it("trim 空白", () => {
    expect(parseHasCsv(" thinking , error ")).toEqual(["thinking", "error"]);
  });

  it("非法值被跳过", () => {
    expect(parseHasCsv("thinking,unknown,bogus,error")).toEqual(["thinking", "error"]);
  });

  it("全是非法值 → []", () => {
    expect(parseHasCsv("foo,bar,baz")).toEqual([]);
  });
});

describe("parseToolCsv", () => {
  it("null → []", () => {
    expect(parseToolCsv(null)).toEqual([]);
  });

  it("空字符串 → []", () => {
    expect(parseToolCsv("")).toEqual([]);
  });

  it("单值", () => {
    expect(parseToolCsv("Bash")).toEqual(["Bash"]);
  });

  it("CSV 多值(任意 tool name 都保留,无白名单)", () => {
    expect(parseToolCsv("Bash,Read,Edit,SomeCustomTool")).toEqual([
      "Bash",
      "Read",
      "Edit",
      "SomeCustomTool",
    ]);
  });

  it("trim + 跳过空段(双逗号)", () => {
    expect(parseToolCsv("Bash,, Read ,")).toEqual(["Bash", "Read"]);
  });
});

describe("parseUrlSearch", () => {
  it("空 search → 全空", () => {
    expect(parseUrlSearch("")).toEqual({
      from: undefined,
      to: undefined,
      role: undefined,
      tools: [],
      has: [],
      models: [],
      sidechainMode: "all",
    });
  });

  it("全字段", () => {
    const r = parseUrlSearch(
      "?from=2026-06-25T10:00:00Z&to=2026-06-25T11:00:00Z&role=user&tool=Bash,Read&has=thinking,error&model=claude-opus-4-7,claude-sonnet-4-5&sidechain=main"
    );
    expect(r).toEqual({
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T11:00:00Z",
      role: "user",
      tools: ["Bash", "Read"],
      has: ["thinking", "error"],
      models: ["claude-opus-4-7", "claude-sonnet-4-5"],
      sidechainMode: "main",
    });
  });

  it("sidechain=sidechain → sidechainMode='sidechain'", () => {
    expect(parseUrlSearch("?sidechain=sidechain").sidechainMode).toBe("sidechain");
  });

  it("sidechain 非法值 → fall back to 'all'", () => {
    expect(parseUrlSearch("?sidechain=bogus").sidechainMode).toBe("all");
  });

  it("部分字段(time only)", () => {
    const r = parseUrlSearch("?from=2026-06-25T10:00:00Z");
    expect(r.from).toBe("2026-06-25T10:00:00Z");
    expect(r.to).toBeUndefined();
    expect(r.role).toBeUndefined();
    expect(r.tools).toEqual([]);
    expect(r.has).toEqual([]);
  });

  it("部分字段(content only)", () => {
    const r = parseUrlSearch("?tool=Bash&has=thinking");
    expect(r.from).toBeUndefined();
    expect(r.tools).toEqual(["Bash"]);
    expect(r.has).toEqual(["thinking"]);
  });

  it("role 空字符串(URL 里 ?role= 但没值)→ undefined", () => {
    const r = parseUrlSearch("?role=");
    expect(r.role).toBeUndefined();
  });

  it("tool 单值不强制 CSV 格式", () => {
    const r = parseUrlSearch("?tool=Read");
    expect(r.tools).toEqual(["Read"]);
  });

  it("非法 has 值被静默跳过", () => {
    const r = parseUrlSearch("?has=thinking,evil,error");
    expect(r.has).toEqual(["thinking", "error"]);
  });

  it("保留 URL 编码的 from 值(含特殊字符)", () => {
    const r = parseUrlSearch("?from=2026-06-25T10%3A00%3A00Z");
    expect(r.from).toBe("2026-06-25T10:00:00Z");
  });
});
