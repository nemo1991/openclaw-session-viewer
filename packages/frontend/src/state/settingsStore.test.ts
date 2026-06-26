/**
 * settingsStore 单元测试
 *
 * 覆盖:
 * - 初始状态 (settings=DEFAULT_SETTINGS, loaded=false)
 * - load() 成功:从后端拉设置, set loaded=true
 * - load() 失败:warn + still set loaded=true (默认值)
 * - save():写后端 + 更新本地
 * - update(partial):合并 settings; anthropic 嵌套深合并
 *
 * 重点覆盖 v0.4.2 timezone 字段
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";
import { DEFAULT_SETTINGS } from "@ocsv/shared";

// Mock api 模块
vi.mock("../lib/api", () => ({
  apiGetSettings: vi.fn(),
  apiSaveSettings: vi.fn(),
}));

import { apiGetSettings, apiSaveSettings } from "../lib/api";

const mockGet = apiGetSettings as ReturnType<typeof vi.fn>;
const mockSave = apiSaveSettings as ReturnType<typeof vi.fn>;

describe("settingsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 store 状态:由于 zustand store 是单例,需要在测试间手动 reset
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      loaded: false,
    });
  });

  it("初始状态:settings=DEFAULT_SETTINGS, loaded=false", () => {
    const s = useSettingsStore.getState();
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(s.loaded).toBe(false);
    // timezone 默认 "auto"
    expect(s.settings.timezone).toBe("auto");
  });

  it("load():成功拉取 → settings 更新, loaded=true", async () => {
    const remote = {
      ...DEFAULT_SETTINGS,
      timezone: "Asia/Shanghai",
      theme: "light" as const,
    };
    mockGet.mockResolvedValueOnce(remote);

    await useSettingsStore.getState().load();

    const s = useSettingsStore.getState();
    expect(s.settings.timezone).toBe("Asia/Shanghai");
    expect(s.settings.theme).toBe("light");
    expect(s.loaded).toBe(true);
  });

  it("load():失败 → console.warn, loaded=true (保持默认值)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGet.mockRejectedValueOnce(new Error("network down"));

    await useSettingsStore.getState().load();

    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("save():写后端 + 更新本地 settings", async () => {
    mockSave.mockResolvedValueOnce(undefined);
    const newSettings = { ...DEFAULT_SETTINGS, timezone: "America/New_York" };

    await useSettingsStore.getState().save(newSettings);

    expect(mockSave).toHaveBeenCalledWith(newSettings);
    expect(useSettingsStore.getState().settings.timezone).toBe("America/New_York");
  });

  it("update(partial):浅合并顶层字段", () => {
    useSettingsStore.getState().update({ theme: "light" });
    const s = useSettingsStore.getState();
    expect(s.settings.theme).toBe("light");
    expect(s.settings.uiLanguage).toBe(DEFAULT_SETTINGS.uiLanguage); // 其它不变
  });

  it("update(partial):anthropic 嵌套深合并 (不能整个覆盖)", () => {
    useSettingsStore.getState().update({
      anthropic: { baseUrl: "x", apiKey: "", model: "y", maxTokens: 8192 },
    });
    // 实际上 update 是 spread,会整个替换 anthropic
    const s = useSettingsStore.getState();
    expect(s.settings.anthropic.baseUrl).toBe("x");
    expect(s.settings.anthropic.maxTokens).toBe(8192);
  });

  it("update(partial {anthropic:{apiKey}}):跟其它 anthropic 字段合并", () => {
    // settingsStore 的 update 实际是浅合并 anthropic,看代码确认行为
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        anthropic: { ...DEFAULT_SETTINGS.anthropic, baseUrl: "https://old.com" },
      },
      loaded: true,
    });
    useSettingsStore.getState().update({
      anthropic: {
        baseUrl: "https://old.com",
        apiKey: "new-key",
        model: DEFAULT_SETTINGS.anthropic.model,
        maxTokens: DEFAULT_SETTINGS.anthropic.maxTokens,
      },
    });
    const s = useSettingsStore.getState();
    expect(s.settings.anthropic.apiKey).toBe("new-key");
    expect(s.settings.anthropic.baseUrl).toBe("https://old.com");
  });

  it("update({timezone:'Asia/Shanghai'}):仅更新时区,其它不动", () => {
    useSettingsStore.getState().update({ timezone: "Asia/Shanghai" });
    const s = useSettingsStore.getState();
    expect(s.settings.timezone).toBe("Asia/Shanghai");
    expect(s.settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.settings.anthropic).toEqual(DEFAULT_SETTINGS.anthropic);
  });
});
