/**
 * useSessionUrlSync — URL → store / scroll 同步 hook
 *
 * 修真实 bug:SessionDetailRoute (v0.4.4) 把 ?line=N 和 ?from=?to= 放在同一个
 * useEffect,依赖 entries.length,首次进入 entries.length===0 时 ?line=N
 * 永不生效。拆成两个 effect:
 *
 * 1. ?from=ISO&to=ISO → 仅依赖 location.search,进入页面立即 setRange
 * 2. ?line=N → 依赖 entries.length>0 + location.search,等第一条 entry 到达
 *    再触发 jumpToEntry(virtualizer.scrollToIndex,非 DOM query)
 *
 * jumpToEntry 由调用方传入(从 useTranscriptScroll 取),保证滚动统一走
 * virtualizer(避免 scrollIntoView vs scrollToIndex 冲突 — v0.4.3 comment)。
 *
 * v0.7.0: 新增内容维度 URL 参数:
 *   ?tool=A,B,C   (CSV,多选 tool)
 *   ?role=user    (单值 role,undefined = 全部)
 *   ?has=thinking,error (CSV,多选 has-attribute)
 * URL 是 "可分享筛选"的入口 — 把 ?from&to&tool&role&has 当成可序列化的 filter snapshot。
 *
 * 设计:URL → store 单向同步(刷新页面 → 读 URL → set store),反向(store → URL)
 *   由 SessionDetailRoute 单独的 effect 写,不在本 hook(避免循环依赖)。
 */

import { useEffect } from "react";

import { useTranscriptFilterStore } from "../state/transcriptFilterStore";
import type { HasAttribute } from "../lib/filterEntries";

interface UrlSyncOpts {
  /** 当前 location.search 字符串 */
  search: string;
  /** entries 是否已流入(供 ?line=N 等待) */
  entriesLoaded: boolean;
  /** 从 useTranscriptScroll 取得的跳到指定 entry 的回调 */
  jumpToEntry: (entryIndex: number) => void;
}

const HAS_VALUES: ReadonlySet<HasAttribute> = new Set([
  "thinking",
  "tool_use",
  "error",
  "subagent",
]);

/** 把 CSV 字符串解析成 has[] — 跳过非法值,空字符串 = [] */
export function parseHasCsv(csv: string | null): HasAttribute[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is HasAttribute => HAS_VALUES.has(s as HasAttribute));
}

/** 同样的 CSV 思路,tool name 没有白名单(用户 session 可能有任意 tool)— 不做过滤 */
export function parseToolCsv(csv: string | null): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 把 URL search 字符串一次性解析成 store 5 字段
 *  供 useSessionUrlSync 调用,也便于纯函数测试。
 *
 *  注意:`?role=` 空值被当成 undefined(URLSearchParams.get 会返回 "",我们
 *  转成 undefined 保持 store 的"未设置"语义)。
 */
function emptyToUndef(s: string | null): string | undefined {
  if (s == null) return undefined;
  const trimmed = s.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function parseUrlSearch(search: string): {
  from?: string;
  to?: string;
  role?: string;
  tools: string[];
  has: HasAttribute[];
} {
  const params = new URLSearchParams(search);
  return {
    from: emptyToUndef(params.get("from")),
    to: emptyToUndef(params.get("to")),
    role: emptyToUndef(params.get("role")),
    tools: parseToolCsv(params.get("tool")),
    has: parseHasCsv(params.get("has")),
  };
}

export function useSessionUrlSync({ search, entriesLoaded, jumpToEntry }: UrlSyncOpts): void {
  // 1. URL → store: time + content filter 一次解析(避免多次 setState 抖动)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const from = params.get("from") ?? undefined;
    const to = params.get("to") ?? undefined;
    const role = params.get("role") ?? undefined;
    const tools = parseToolCsv(params.get("tool"));
    const has = parseHasCsv(params.get("has"));

    const s = useTranscriptFilterStore.getState();
    // 用 setState 一次性合并,避免 4 次单独 set 触发 4 次 pipeline 重算
    useTranscriptFilterStore.setState({
      from,
      to,
      preset: from || to ? "custom" : tools.length > 0 || role || has.length > 0 ? "all" : s.preset, // 没 URL 干预时保留现有 preset
      role,
      tools,
      has,
    });
  }, [search]);

  // 2. ?line=N → 等 entries 流入后跳
  useEffect(() => {
    if (!entriesLoaded) return;
    const params = new URLSearchParams(search);
    const line = params.get("line");
    if (!line) return;
    const target = parseInt(line, 10);
    if (isNaN(target)) return;
    // rAF 等 React 把新 entry 渲染到 DOM,virtualizer 有尺寸后再滚
    requestAnimationFrame(() => jumpToEntry(target));
  }, [entriesLoaded, search, jumpToEntry]);
}
