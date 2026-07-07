import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { useSettingsStore } from "./state/settingsStore";
import { applyTheme } from "./theme/ThemeProvider";
import SessionsRoute from "./routes/SessionsRoute";
import SessionDetailRoute from "./routes/SessionDetailRoute";
import AnalyzeRoute from "./routes/AnalyzeRoute";
import SettingsRoute from "./routes/SettingsRoute";
import TrajectoryRoute from "./routes/TrajectoryRoute";
import GraphExplorerRoute from "./routes/GraphExplorerRoute";
import { RevealErrorToast } from "./components/RevealErrorToast";
import { SyncBanner } from "./components/SyncBanner";
import { useOverridesBridge } from "./state/overridesStore";

export default function App() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // v0.8.0: 后台同步进度 bridge + overrides-changed 监听
  useOverridesBridge();

  return (
    <>
      <Routes>
        <Route path="/" element={<SessionsRoute />} />
        <Route path="/graph/*" element={<GraphExplorerRoute />} />
        <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        <Route path="/session/:sessionId/trajectory" element={<TrajectoryRoute />} />
        <Route path="/analyze/:sessionId" element={<AnalyzeRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* v0.6.x: 全局 reveal 错误 toast, 监听 REVEAL_ERROR_EVENT */}
      <RevealErrorToast />
      {/* v0.8.0: 后台同步进度 toast */}
      <SyncBanner />
    </>
  );
}
