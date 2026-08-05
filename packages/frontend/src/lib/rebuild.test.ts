/**
 * v0.8.14 item A: rebuild.ts 共享文案锁住契约。
 *
 * v0.8.12 之前 DatabasePanel.confirm 写 "会清空 session_meta / override / tag / link",
 * 跟实际 rebuild_db 行为(其实是清 6 表)一致 — 但 v0.8.13 改成只清 session_meta,
 * HomeStatusBar 文案跟着改了;DatabasePanel 文案忘了跟进 — 用户看到 "override 也会被清"
 * 会误以为 rebuild 是 destructive 操作,不敢点。
 *
 * v0.8.14 提取为常量,DatabasePanel + HomeStatusBar 共用。本测试锁住:
 * - 常量字符串包含 "保留" 和 "override / tag / link / 搜索历史"
 * - 故意**不**包含 "会清空 override" 这种跟 v0.8.13 行为反向的措辞
 * - 长度大于 0 (占位)
 */
import { describe, it, expect } from "vitest";
import { REBUILD_CONFIRM_TEXT, REBUILD_SUCCESS_HINT } from "./rebuild";

describe("rebuild.ts v0.8.14 item A", () => {
  it("REBUILD_CONFIRM_TEXT 包含 '保留' + 用户数据类型", () => {
    expect(REBUILD_CONFIRM_TEXT).toContain("保留");
    // 用户数据列举一定要有 override / tag / link
    expect(REBUILD_CONFIRM_TEXT).toContain("override");
    expect(REBUILD_CONFIRM_TEXT).toContain("tag");
    expect(REBUILD_CONFIRM_TEXT).toContain("link");
  });

  it("REBUILD_CONFIRM_TEXT 不包含 '会清空 override'(跟 v0.8.13 行为反向)", () => {
    // v0.8.13 rebuild_db 真行为: override/tag/link/history 都保留,
    // 只清 session_meta。文案必须告诉用户这些数据保留,不能误导。
    expect(REBUILD_CONFIRM_TEXT).not.toContain("会清空 override");
    expect(REBUILD_CONFIRM_TEXT).not.toContain("清空所有");
  });

  it("REBUILD_CONFIRM_TEXT 是非空字符串", () => {
    expect(REBUILD_CONFIRM_TEXT.length).toBeGreaterThan(0);
    expect(REBUILD_CONFIRM_TEXT).toContain("重建");
  });

  it("REBUILD_SUCCESS_HINT 非空字符串", () => {
    expect(REBUILD_SUCCESS_HINT.length).toBeGreaterThan(0);
    expect(REBUILD_SUCCESS_HINT).toContain("数据库");
  });
});
