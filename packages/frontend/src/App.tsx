import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { useSettingsStore } from "./state/settingsStore";
import { applyTheme } from "./theme/ThemeProvider";
import SessionsRoute from "./routes/SessionsRoute";
import SessionDetailRoute from "./routes/SessionDetailRoute";
import AnalyzeRoute from "./routes/AnalyzeRoute";
import SettingsRoute from "./routes/SettingsRoute";
import TrajectoryRoute from "./routes/TrajectoryRoute";
import { RevealErrorToast } from "./components/RevealErrorToast";

export default function App() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  return (
    <>
      <Routes>
        <Route path="/" element={<SessionsRoute />} />
        <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        <Route path="/session/:sessionId/trajectory" element={<TrajectoryRoute />} />
        <Route path="/analyze/:sessionId" element={<AnalyzeRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* v0.6.x: 全局 reveal 错误 toast, 监听 REVEAL_ERROR_EVENT */}
      <RevealErrorToast />
    </>
  );
}
