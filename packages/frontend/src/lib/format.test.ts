import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatBytes,
  formatNumber,
  formatTime,
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

  it("undefined / 空字符串 → ''", () => {
    expect(isoToLocalInputInTz(undefined, "UTC")).toBe("");
    expect(isoToLocalInputInTz("", "UTC")).toBe("");
  });

  it("无效 ISO → ''", () => {
    expect(isoToLocalInputInTz("not-a-date", "UTC")).toBe("");
  });
});

describe("formatBytes", () => {
  it("0 → '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("< 1024 → B 单位", () => {
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("< 1MB → KB (1 位小数)", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("< 1GB → MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it(">= 1GB → GB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("边界:1023 vs 1024", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
  });
});

describe("formatNumber", () => {
  it("< 1000 → 原样", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(999)).toBe("999");
  });

  it("< 1M → k (1 位小数)", () => {
    expect(formatNumber(1000)).toBe("1.0k");
    expect(formatNumber(1500)).toBe("1.5k");
    expect(formatNumber(999999)).toBe("1000.0k");
  });

  it(">= 1M → M", () => {
    expect(formatNumber(1_000_000)).toBe("1.0M");
    expect(formatNumber(2_500_000)).toBe("2.5M");
  });
});

describe("formatTime (相对时间)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("undefined → ''", () => {
    expect(formatTime(undefined)).toBe("");
  });

  it("空字符串 → ''", () => {
    expect(formatTime("")).toBe("");
  });

  it("无效 ISO → ''", () => {
    expect(formatTime("not-a-date")).toBe("");
  });

  it("< 60s → '刚刚'", () => {
    expect(formatTime("2026-06-25T13:59:30Z")).toBe("刚刚");
  });

  it("< 1h → 'X 分钟前'", () => {
    expect(formatTime("2026-06-25T13:55:00Z")).toBe("5 分钟前");
  });

  it("< 24h → 'X 小时前'", () => {
    expect(formatTime("2026-06-25T10:00:00Z")).toBe("4 小时前");
  });

  it("< 7d → 'X 天前'", () => {
    expect(formatTime("2026-06-23T14:00:00Z")).toBe("2 天前");
  });

  it(">= 7d → 走 fallback 绝对日期", () => {
    const out = formatTime("2026-06-01T14:00:00Z", { tz: "UTC" });
    // 期望:不是 "X 天前" 形式,而是带年份的 zh-CN 格式
    expect(out).not.toMatch(/天前/);
    expect(out.length).toBeGreaterThan(0);
  });
});
