/**
 * v0.4.2: 读取 settings.timezone 解析成 format.ts 的 FormatOpts
 * "auto" → 浏览器 TZ(Intl 自动检测)
 */

import { useSettingsStore } from "../state/settingsStore";
import { resolveTimezone } from "../lib/format";

export interface ResolvedFormatOpts {
  /** 已解析的具体 IANA 时区名("auto" 已转成浏览器 TZ) */
  tz: string;
}

export function useFormatOpts(): ResolvedFormatOpts {
  const tz = useSettingsStore((s) => s.settings.timezone);
  return { tz: resolveTimezone(tz) };
}
