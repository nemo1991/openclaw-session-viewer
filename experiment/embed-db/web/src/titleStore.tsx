/**
 * 显示名(store) — 三视图共享,G1 / G2 / G3 必须显示同一个名字。
 *
 * 持久化层:localStorage (`openclaw.titleOverrides.v1`)
 * - 跨刷新:oK
 * - 跨 tab:同源共享
 * - 不依赖后端(实验分支 web 是 Vite 静态)
 *
 * API:
 * - useTitles().get(nodeId, fallback) → 命中的自定义,或 fallback
 * - useTitles().set(nodeId, title)   → 持久化 + 状态更新
 * - useTitles().clear(nodeId)        → 回落到 auto
 * - useTitles().auto(node)           → 跑 autoTitle() 启发式
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionNode } from "./types";
import { autoTitle } from "./title";

const KEY = "openclaw.titleOverrides.v1";
const VERSION = 1;

type OverrideMap = Record<string, string>;

function loadOverrides(): OverrideMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // 防御:版本不匹配或类型不对时清空
    if (
      typeof parsed === "object" &&
      parsed &&
      (parsed as { v?: number }).v === VERSION &&
      typeof (parsed as { m?: unknown }).m === "object"
    ) {
      return (parsed as { m: OverrideMap }).m;
    }
    return {};
  } catch {
    return {};
  }
}

function saveOverrides(m: OverrideMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, m }));
  } catch {
    // 隐私模式 / quota 满 — 静默失败,UI 不应该崩
  }
}

interface TitleApi {
  get: (nodeId: string, fallback: string) => string;
  set: (nodeId: string, title: string) => void;
  clear: (nodeId: string) => void;
  auto: (n: SessionNode) => string;
  hasOverride: (nodeId: string) => boolean;
}

const Ctx = createContext<TitleApi | null>(null);

export function TitleProvider({ children }: { children: ReactNode }) {
  // SSR / 预渲染容错:window 可能不存在
  const [overrides, setOverrides] = useState<OverrideMap>(() => {
    if (typeof window === "undefined") return {};
    return loadOverrides();
  });

  // 跨 tab 同步:监听 storage 事件,其他 tab 改了 → 这一 tab 跟着刷新
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          if (parsed && (parsed as { v?: number }).v === VERSION) {
            setOverrides((parsed as { m: OverrideMap }).m);
          }
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const get = useCallback(
    (nodeId: string, fallback: string) => overrides[nodeId] ?? fallback,
    [overrides]
  );

  const set = useCallback((nodeId: string, title: string) => {
    const v = title.trim();
    if (!v) return;
    setOverrides((prev) => {
      const next = { ...prev, [nodeId]: v };
      saveOverrides(next);
      return next;
    });
    // 通知同 tab 其他 view 同步 (storage 事件只对跨 tab 触发)
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("openclaw:titlesChanged"));
    }
  }, []);

  const clear = useCallback((nodeId: string) => {
    setOverrides((prev) => {
      if (!(nodeId in prev)) return prev;
      const { [nodeId]: _, ...rest } = prev;
      saveOverrides(rest);
      return rest;
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("openclaw:titlesChanged"));
    }
  }, []);

  const auto = useCallback((n: SessionNode) => autoTitle(n), []);

  const hasOverride = useCallback((nodeId: string) => nodeId in overrides, [overrides]);

  const value = useMemo<TitleApi>(
    () => ({ get, set, clear, auto, hasOverride }),
    [get, set, clear, auto, hasOverride]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTitles(): TitleApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTitles must be used inside <TitleProvider>");
  return v;
}
