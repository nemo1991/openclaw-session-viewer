import { describe, it, expect } from "vitest";
import {
  formatTimeExact,
  formatTimeShort,
  resolveTimezone,
  formatLocalInputToIsoInTz,
  isoToLocalInputInTz,
} from "./format";

describe("resolveTimezone", () => {
  it("undefined / 'auto' 走浏览器 TZ", () => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveTimezone(undefined)).toBe(browserTz);
    expect(resolveTimezone("auto")).toBe(browserTz);
  });

  it("具体 IANA 名原样返回", () => {
    expect(resolveTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(resolveTimezone("UTC")).toBe("UTC");
  });
});

describe("formatTimeExact with tz", () => {
  // 固定时间: 2026-06-25T14:00:00Z
  const iso = "2026-06-25T14:00:00Z";

  it("UTC 显示 14:00(无时差)", () => {
    const out = formatTimeExact(iso, { tz: "UTC" });
    // 14:00 UTC 仍然是 14:00(不强制要求带 "UTC" 缩写,zh-CN 不显示)
    expect(out).toMatch(/14:00/);
  });

  it("Asia/Shanghai (+08:00) 显示 22:00", () => {
    const out = formatTimeExact(iso, { tz: "Asia/Shanghai" });
    expect(out).toMatch(/22:00/);
  });

  it("America/New_York EDT (UTC-4) 显示 10:00", () => {
    // 6 月 25 日在夏令时,NY 是 EDT = UTC-4
    const out = formatTimeExact(iso, { tz: "America/New_York" });
    expect(out).toMatch(/10:00/);
  });

  it("不传 opts 走浏览器 TZ(向后兼容)", () => {
    const out = formatTimeExact(iso);
    expect(out).toBeTruthy();
    // 14:00 出现的可能性高(浏览器可能也在 UTC 附近)
    expect(typeof out).toBe("string");
  });

  it("formatTimeShort 也跟 opts", () => {
    const out = formatTimeShort(iso, { tz: "Asia/Shanghai" });
    expect(out).toMatch(/22:00/);
  });
});

describe("formatLocalInputToIsoInTz", () => {
  it("UTC tz:naive 当作 UTC", () => {
    expect(formatLocalInputToIsoInTz("2026-06-25T14:00", "UTC")).toBe("2026-06-25T14:00:00.000Z");
  });

  it("Asia/Shanghai (+08):14:00 shanghai = 06:00 UTC", () => {
    expect(formatLocalInputToIsoInTz("2026-06-25T14:00", "Asia/Shanghai")).toBe(
      "2026-06-25T06:00:00.000Z"
    );
  });

  it("America/New_York EDT (-04):14:00 NY = 18:00 UTC", () => {
    expect(formatLocalInputToIsoInTz("2026-06-25T14:00", "America/New_York")).toBe(
      "2026-06-25T18:00:00.000Z"
    );
  });

  it("带秒", () => {
    expect(formatLocalInputToIsoInTz("2026-06-25T14:30:45", "UTC")).toBe(
      "2026-06-25T14:30:45.000Z"
    );
  });

  it("空字符串 / 非法格式返回空", () => {
    expect(formatLocalInputToIsoInTz("", "UTC")).toBe("");
    expect(formatLocalInputToIsoInTz("not-a-date", "UTC")).toBe("");
  });
});

describe("isoToLocalInputInTz(反向)", () => {
  const iso = "2026-06-25T14:00:00Z";

  it("UTC tz", () => {
    expect(isoToLocalInputInTz(iso, "UTC")).toBe("2026-06-25T14:00");
  });

  it("Asia/Shanghai 显示 22:00", () => {
    expect(isoToLocalInputInTz(iso, "Asia/Shanghai")).toBe("2026-06-25T22:00");
  });

  it("America/New_York EDT 显示 10:00", () => {
    expect(isoToLocalInputInTz(iso, "America/New_York")).toBe("2026-06-25T10:00");
  });
});
