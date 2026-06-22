import { describe, it, expect } from "vitest";
import {
  encodeClaudeProjectKey,
  decodeClaudeProjectKey,
  joinPath,
} from "./paths.js";

describe("encodeClaudeProjectKey", () => {
  it("converts path separators and special chars", () => {
    expect(encodeClaudeProjectKey("/Users/foo/bar")).toBe("-Users-foo-bar");
  });

  it("preserves numbers and letters", () => {
    expect(encodeClaudeProjectKey("/Users/alice123/project-v2")).toBe(
      "-Users-alice123-project-v2"
    );
  });

  it("replaces unicode with dashes", () => {
    // 中文 是 2 个字符,每个变成 -,加上前面的 / 变成 - → 共 3 个 -
    expect(encodeClaudeProjectKey("/Users/alice/中文")).toBe("-Users-alice---");
  });

  it("handles empty path", () => {
    expect(encodeClaudeProjectKey("")).toBe("");
  });

  it("truncates very long paths with hash", () => {
    const long = "/Users/" + "x".repeat(300);
    const key = encodeClaudeProjectKey(long);
    // 200 字符 + "-" + 最多 12 字符 hash
    expect(key.length).toBeLessThanOrEqual(213);
    expect(key.startsWith("-")).toBe(true);
  });

  it("is deterministic", () => {
    const a = encodeClaudeProjectKey("/Users/test/path");
    const b = encodeClaudeProjectKey("/Users/test/path");
    expect(a).toBe(b);
  });

  it("different paths give different keys", () => {
    const a = encodeClaudeProjectKey("/Users/foo/a");
    const b = encodeClaudeProjectKey("/Users/foo/b");
    expect(a).not.toBe(b);
  });
});

describe("decodeClaudeProjectKey", () => {
  it("decodes a standard key", () => {
    expect(decodeClaudeProjectKey("-Users-foo-bar")).toBe("/Users/foo/bar");
  });

  it("returns null for keys not starting with dash", () => {
    expect(decodeClaudeProjectKey("Users-foo")).toBeNull();
  });

  it("decodes empty key", () => {
    expect(decodeClaudeProjectKey("-")).toBe("/");
  });
});

describe("joinPath", () => {
  it("joins paths with single slash", () => {
    expect(joinPath("a", "b", "c")).toBe("a/b/c");
  });

  it("skips empty segments", () => {
    expect(joinPath("a", "", "b", null, undefined, "c")).toBe("a/b/c");
  });

  it("trims leading and trailing slashes", () => {
    expect(joinPath("a/", "/b/", "/c/")).toBe("a/b/c");
  });

  it("preserves absolute path prefix", () => {
    expect(joinPath("/a/", "b/", "c/")).toBe("/a/b/c");
  });

  it("handles root-only prefix", () => {
    expect(joinPath("/", "Users", "foo")).toBe("/Users/foo");
  });

  it("returns empty for all-empty input", () => {
    expect(joinPath("", null, undefined)).toBe("");
  });
});