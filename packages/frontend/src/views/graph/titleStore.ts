/**
 * 显示名 store — G1/G2/G3 共享 display_title,跨刷新跨 tab 持久化。
 *
 * 设计:zustand store + localStorage (通过 subscribe 自定义 persist)
 * - 主项目已经全 zustand,跟 sessionsStore/settingsStore 一致
 * - 不用 zustand/middleware/persist (因为我们需要 VERSION 字段的版本校验)
 * - 跨 tab 同步:window 'storage' 事件
 * - 跨 view 同 tab 同步:window 'openclaw:titlesChanged' 自定义事件
 *
 * API(跟原实验 web 的 useTitles() 一致,GraphView/GraphDetailPanel 调用方式不变):
 * - useTitleStore().get(nodeId, fallback) → 命中的自定义,或 fallback
 * - useTitleStore().set(nodeId, title)   → 持久化 + 状态更新
 * - useTitleStore().clear(nodeId)        → 回落到 auto
 * - useTitleStore().auto(node)           → 跑 autoTitle() 启发式
 * - useTitleStore().hasOverride(nodeId)  → boolean
 */

import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { SessionNode } from "./types";
import { autoTitle } from "./title";

const KEY = "openclaw.titleOverrides.v1";
const VERSION = 1;

type OverrideMap = Record<string, string>;

function loadOverrides(): OverrideMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
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
    if (typeof window === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, m }));
  } catch {
    // 隐私模式 / quota 满 — 静默失败,UI 不应该崩
  }
}

interface TitleState {
  overrides: OverrideMap;
  /** 内部用 — 触发 storage 事件回流重渲染(同 tab 自定义事件已能触发 zustand 更新,但 storage 事件从其他 tab 来需要这个 trigger) */
  bumpVersion: number;
  set: (nodeId: string, title: string) => void;
  clear: (nodeId: string) => void;
  /** 跨 tab storage 事件触发时调用 */
  reloadFromStorage: () => void;
}

const useTitleStoreBase = create<TitleState>((set) => ({
  overrides: loadOverrides(),
  bumpVersion: 0,
  set: (nodeId, title) => {
    const v = title.trim();
    if (!v) return;
    set((prev) => {
      const next = { ...prev.overrides, [nodeId]: v };
      saveOverrides(next);
      // 通知同 tab 其他 view
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("openclaw:titlesChanged"));
      }
      return { overrides: next };
    });
  },
  clear: (nodeId) => {
    set((prev) => {
      if (!(nodeId in prev.overrides)) return prev;
      const { [nodeId]: _drop, ...rest } = prev.overrides;
      saveOverrides(rest);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("openclaw:titlesChanged"));
      }
      return { overrides: rest };
    });
  },
  reloadFromStorage: () => {
    const fresh = loadOverrides();
    set((prev) => ({
      overrides: fresh,
      bumpVersion: prev.bumpVersion + 1,
    }));
  },
}));

/** 跨 tab 同步 — 在 App 顶层 mount 一次即可(由 GraphExplorerRoute 调用) */
export function useTitleStoreStorageBridge() {
  const reloadFromStorage = useTitleStoreBase((s) => s.reloadFromStorage);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) reloadFromStorage();
    };
    const onLocal = () => {
      // 同 tab 别的 view 改了 — zustand 已经是 single source of truth,
      // 但其他 React 组件可能需要触发 selector 重渲,这里 reload 一次确保一致
      reloadFromStorage();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("openclaw:titlesChanged", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("openclaw:titlesChanged", onLocal);
    };
  }, [reloadFromStorage]);
}

/** 业务 API hook — 返回跟原 useTitles() 一样的形状 */
export function useTitleStore() {
  const overrides = useTitleStoreBase((s) => s.overrides);
  const set = useTitleStoreBase((s) => s.set);
  const clear = useTitleStoreBase((s) => s.clear);

  const get = useCallback(
    (nodeId: string, fallback: string) => overrides[nodeId] ?? fallback,
    [overrides]
  );
  const auto = useCallback((n: SessionNode) => autoTitle(n), []);
  const hasOverride = useCallback((nodeId: string) => nodeId in overrides, [overrides]);

  return useMemo(
    () => ({ get, set, clear, auto, hasOverride }),
    [get, set, clear, auto, hasOverride]
  );
}
