import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "./state/settingsStore";
import { useSessionsStore } from "./state/sessionsStore";
import { applyTheme } from "./theme/ThemeProvider";
import SessionsRoute from "./routes/SessionsRoute";
import SessionDetailRoute from "./routes/SessionDetailRoute";
import AnalyzeRoute from "./routes/AnalyzeRoute";
import SettingsRoute from "./routes/SettingsRoute";
import TrajectoryRoute from "./routes/TrajectoryRoute";
import GraphExplorerRoute from "./routes/GraphExplorerRoute";
import { ToolsRoute } from "./routes/ToolsRoute"; // v0.8.5 B: 全局 tool 聚合页
import { RevealErrorToast } from "./components/RevealErrorToast";
import { useOverridesBridge } from "./state/overridesStore";

export default function App() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const refresh = useSessionsStore((s) => s.refresh);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // v0.8.0: 后台同步进度 bridge + overrides-changed 监听
  useOverridesBridge();

  // v0.9.28 (M11.1): 启动时显式触发一次 sync —
  // 后端 sync_loop 也会在 setup() 跑一次,但 sync_loop 是 tokio task 异步启动,
  // 在 frontend listener 注册之前就 emit "sync-progress"/"sessions-updated" 事件
  // 会被全部丢掉,用户感知"打开应用后没自动同步,需要手动同步"。
  // 这里 refresh_sessions() 既 notify sync_loop 重跑(本轮带 listener,status bar
  // 能看到 "扫描中…/同步 N/M"),又立刻返回当前 DB 快照供首屏渲染。
  useEffect(() => {
    void refresh();
    const unlistenPromise = listen("sessions-updated", () => {
      void useSessionsStore.getState().load();
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, [refresh]);

  return (
    <>
      <Routes>
        <Route path="/" element={<SessionsRoute />} />
        <Route path="/graph/*" element={<GraphExplorerRoute />} />
        <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        <Route path="/session/:sessionId/trajectory" element={<TrajectoryRoute />} />
        <Route path="/analyze/:sessionId" element={<AnalyzeRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/tools" element={<ToolsRoute />} /> {/* v0.8.5 B */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* v0.6.x: 全局 reveal 错误 toast, 监听 REVEAL_ERROR_EVENT */}
      <RevealErrorToast />
    </>
  );
}
