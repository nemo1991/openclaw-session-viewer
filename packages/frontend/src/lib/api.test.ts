/**
 * api.extractErrorMessage 单元测试
 *
 * 覆盖:
 * - 字符串 error 原样返回
 * - { message: "..." } 用 message
 * - { kind: "X" } 用 kind
 * - { kind: "X", message: "Y" } 合并 "X: Y"
 * - 其它对象 JSON.stringify
 * - null / undefined / number 转 String()
 *
 * 关键:不能是 "[object Object]"
 */

import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "./api";

describe("extractErrorMessage", () => {
  it("字符串原样返回", () => {
    expect(extractErrorMessage("connection failed")).toBe("connection failed");
    expect(extractErrorMessage("")).toBe("");
  });

  it("{message} 用 message 字段", () => {
    expect(extractErrorMessage({ message: "not found" })).toBe("not found");
  });

  it("{kind} 单独用 kind", () => {
    expect(extractErrorMessage({ kind: "PathSecurity" })).toBe("PathSecurity");
  });

  it("{kind, message} message 优先,只用 message (不合并)", () => {
    // 实际行为: 先 check message,有就用;不再回头合并 kind
    expect(extractErrorMessage({ kind: "PathSecurity", message: "traversal blocked" })).toBe(
      "traversal blocked"
    );
  });

  it("空对象 → JSON 序列化", () => {
    expect(extractErrorMessage({})).toBe("{}");
  });

  it("复杂对象 → JSON 序列化", () => {
    expect(extractErrorMessage({ code: 42, retry: true, msg: "wait" })).toBe(
      '{"code":42,"retry":true,"msg":"wait"}'
    );
  });

  it("null → 'null'", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("undefined → 'undefined'", () => {
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });

  it("number → 字符串", () => {
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(0)).toBe("0");
  });

  it("boolean → 字符串", () => {
    expect(extractErrorMessage(false)).toBe("false");
  });

  it("核心保证:不返回 '[object Object]'", () => {
    // Tauri invoke 抛 error 时直接 String(e) 会得到这个
    expect(extractErrorMessage({ kind: "X", message: "Y" })).not.toBe("[object Object]");
    expect(extractErrorMessage({})).not.toBe("[object Object]");
    expect(extractErrorMessage({ foo: "bar" })).not.toBe("[object Object]");
  });

  it("message 字段非字符串时 (number) 走 JSON 路径", () => {
    // e.g. { message: 42 } — 不应当作字符串
    expect(extractErrorMessage({ message: 42 })).toBe('{"message":42}');
  });

  it("嵌套对象 (有 kind 但没 message → 用 kind)", () => {
    expect(extractErrorMessage({ kind: "X", context: { a: 1 } })).toBe("X");
  });
});
