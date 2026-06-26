/** 格式化工具 */

/** v0.4.2: 时区选项。'auto' = 跟随浏览器 TZ */
export interface FormatOpts {
  tz?: string;
}

/** v0.4.2: 解析 'auto' 或具体 IANA 名为实际 IANA 名(返回浏览器 TZ) */
export function resolveTimezone(tz: string | undefined): string {
  if (!tz || tz === "auto") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return tz;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatTime(iso?: string, opts: FormatOpts = {}): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    // 相对时间 TZ-agnostic,只有 fallback 绝对日期用 TZ
    return d.toLocaleDateString("zh-CN", { timeZone: resolveTimezone(opts.tz) });
  } catch {
    return "";
  }
}

export function formatTimeShort(iso?: string, opts: FormatOpts = {}): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: resolveTimezone(opts.tz),
    });
  } catch {
    return "";
  }
}

export function formatTimeExact(iso?: string, opts: FormatOpts = {}): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", { timeZone: resolveTimezone(opts.tz) });
  } catch {
    return "";
  }
}

export function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * v0.4.2: 把 `<input type="datetime-local">` 的 naive 字符串("YYYY-MM-DDTHH:mm")
 * 按指定 TZ 解析成 UTC ISO 字符串。
 *
 * 为什么需要:浏览器 `new Date("2026-01-15T10:00")` 默认按 OS 本地时区解析,
 * 当用户选了非本地 TZ 时,这会导致 filter 范围错位。
 *
 * 实现:用 `Intl.DateTimeFormat` 反推"naive 字符串"在 tz 下的真实 epoch ms。
 * naive 字符串里写的时间视为 tz 内的 wall-clock,反推成 UTC。
 */
export function formatLocalInputToIsoInTz(localStr: string | undefined, tz: string): string {
  if (!localStr) return "";
  if (!localStr) return "";
  // naive 字符串 "YYYY-MM-DDTHH:mm" 或 "YYYY-MM-DDTHH:mm:ss"
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localStr);
  if (!m) return "";
  const y = m[1] ?? "1970";
  const mo = m[2] ?? "01";
  const d = m[3] ?? "01";
  const h = m[4] ?? "00";
  const mi = m[5] ?? "00";
  const s = m[6] ?? "00";
  const targetTz = resolveTimezone(tz);
  // 用 Intl.DateTimeFormat 把"这个 wall-clock 在 tz 里"格式化出 UTC 偏移,
  // 然后从 naive epoch(假设 UTC)里扣掉偏移,得到真实的 UTC epoch。
  // 步骤:1) 先猜 naive 是 UTC,2) 用 Intl 看它会被解释成 tz 里的什么时间,
  // 3) 偏移 = 实际显示时间 - naive
  const naiveUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const tzDate = new Date(naiveUtc);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: targetTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(tzDate);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  // 注意 hour12=false 在 en-US 上 0 点会显示 "24",需 mod 24
  const tzYear = +get("year");
  const tzMonth = +get("month");
  const tzDay = +get("day");
  const tzHour = +get("hour") % 24;
  const tzMin = +get("minute");
  const tzSec = +get("second");
  // 计算 naiveUtc 在 tz 里的 wall-clock (用 tz 的 offset)
  const tzWall = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, tzSec);
  const offsetMs = tzWall - naiveUtc;
  return new Date(naiveUtc - offsetMs).toISOString();
}

/**
 * v0.4.2: 反向操作 — 把 ISO 字符串按指定 TZ 渲染成 naive "YYYY-MM-DDTHH:mm"
 * 给 `<input type="datetime-local">` 的 value 用。
 */
export function isoToLocalInputInTz(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const targetTz = resolveTimezone(tz);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: targetTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // en-CA 格式 = "YYYY-MM-DD, HH:MM",我们把它整理成 "YYYY-MM-DDTHH:MM"
  const s = fmt.format(d).replace(", ", "T");
  return s;
}
