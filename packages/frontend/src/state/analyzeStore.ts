/**
 * 大模型分析 store
 */

import { create } from "zustand";
import { listenAnalyze, type AnalyzeEvent } from "../lib/api";
import { invoke } from "@tauri-apps/api/core";

export type AnalysisTemplate = "summary" | "code-changes" | "errors" | "custom";

export interface AnalyzeRange {
  fromIndex?: number;
  toIndex?: number;
  onlyUser?: boolean;
}

interface AnalyzeStore {
  path: string | null;
  template: AnalysisTemplate;
  customPrompt: string;
  range: AnalyzeRange;
  result: string;
  streaming: boolean;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  setTemplate: (t: AnalysisTemplate) => void;
  setCustomPrompt: (p: string) => void;
  setRange: (r: AnalyzeRange) => void;
  start: (path: string, baseUrl: string, apiKey: string, model: string, maxTokens: number) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export const useAnalyzeStore = create<AnalyzeStore>((set, get) => ({
  path: null,
  template: "summary",
  customPrompt: "",
  range: {},
  result: "",
  streaming: false,
  error: null,
  inputTokens: 0,
  outputTokens: 0,
  setTemplate: (t) => set({ template: t }),
  setCustomPrompt: (p) => set({ customPrompt: p }),
  setRange: (r) => set({ range: r }),
  reset: () =>
    set({
      result: "",
      streaming: false,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
    }),
  start: async (path, baseUrl, apiKey, model, maxTokens) => {
    const { template, customPrompt, range } = get();
    get().reset();
    set({ path, streaming: true });

    const unlisteners = await listenAnalyze(
      (evt: AnalyzeEvent) => {
        if (evt.kind === "delta") {
          set((s) => ({ result: s.result + evt.text }));
        } else if (evt.kind === "done") {
          set({
            inputTokens: evt.totalInputTokens ?? 0,
            outputTokens: evt.totalOutputTokens ?? 0,
            streaming: false,
          });
        } else if (evt.kind === "error") {
          set({ error: evt.message, streaming: false });
        }
      },
      () => {
        set({ streaming: false });
      }
    );

    try {
      await invoke("analyze_session", {
        args: {
          path,
          template,
          customPrompt: template === "custom" ? customPrompt : null,
          range,
          baseUrl,
          apiKey,
          model,
          maxTokens,
        },
      });
    } catch (e) {
      set({ error: String(e), streaming: false });
      unlisteners.forEach((u) => u());
    }
  },
  cancel: async () => {
    try {
      await invoke("cancel_analyze");
      set({ streaming: false });
    } catch (e) {
      console.error("cancel 失败:", e);
    }
  },
}));
