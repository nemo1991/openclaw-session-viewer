import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Play, Square, Settings as SettingsIcon } from "lucide-react";

import { useAnalyzeStore } from "../state/analyzeStore";
import { useSettingsStore } from "../state/settingsStore";
import { useTranscriptStore } from "../state/transcriptStore";
import { Markdown } from "../components/Markdown";
import { ANALYSIS_TEMPLATES } from "@ocsv/shared";
import { formatNumber } from "../lib/format";
import type { SessionMeta } from "@ocsv/shared";
import "./AnalyzeRoute.css";

export default function AnalyzeRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const meta = (location.state as { session?: SessionMeta } | null)?.session;
  const settings = useSettingsStore((s) => s.settings);
  const { totalCount } = useTranscriptStore();

  const analyze = useAnalyzeStore();
  const {
    template,
    customPrompt,
    range,
    result,
    streaming,
    error,
    inputTokens,
    outputTokens,
    setTemplate,
    setCustomPrompt,
    setRange,
    start,
    cancel,
  } = analyze;

  const [fromIdx, setFromIdx] = useState(0);
  const [toIdx, setToIdx] = useState(0);

  useEffect(() => {
    if (totalCount > 0) {
      setFromIdx(0);
      setToIdx(totalCount);
    }
  }, [totalCount]);

  const hasApiKey = settings.anthropic.apiKey.length > 0;

  const handleStart = async () => {
    if (!meta?.jsonlPath) return;
    const r =
      range.fromIndex !== undefined
        ? { fromIndex: range.fromIndex, toIndex: range.toIndex, onlyUser: range.onlyUser }
        : {};
    await start(
      meta.jsonlPath,
      settings.anthropic.baseUrl,
      settings.anthropic.apiKey,
      settings.anthropic.model,
      settings.anthropic.maxTokens
    );
    // 同时也设置 range
    setRange(r);
  };

  return (
    <div className="analyze-page">
      <header className="analyze-header">
        <button onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> {t("detail.back")}
        </button>
        <h1>
          🤖 {t("analyze.title")} — {meta?.title || sessionId?.slice(0, 8)}
        </h1>
        {!hasApiKey && (
          <button onClick={() => navigate("/settings")} className="primary">
            <SettingsIcon size={14} /> {t("analyze.goSettings")}
          </button>
        )}
      </header>

      <div className="analyze-config">
        <section>
          <label>{t("analyze.template")}</label>
          <select value={template} onChange={(e) => setTemplate(e.target.value as any)}>
            {ANALYSIS_TEMPLATES.map((tpl) => (
              <option key={tpl.key} value={tpl.key}>
                {tpl.label} — {tpl.description}
              </option>
            ))}
          </select>
          {template === "custom" && (
            <textarea
              rows={6}
              placeholder={t("analyze.customPromptPlaceholder")}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
            />
          )}
        </section>

        <section>
          <label>{t("analyze.range")}</label>
          <div className="range-options">
            <label>
              <input
                type="radio"
                name="range"
                checked={range.fromIndex === undefined}
                onChange={() => setRange({})}
              />
              {t("analyze.rangeAll")} ({totalCount})
            </label>
            <label>
              <input
                type="radio"
                name="range"
                checked={range.fromIndex !== undefined}
                onChange={() => setRange({ fromIndex: fromIdx, toIndex: toIdx })}
              />
              {t("analyze.rangeSlice")}
              {range.fromIndex !== undefined && (
                <span className="range-inputs">
                  <input
                    type="number"
                    min={0}
                    max={totalCount}
                    value={fromIdx}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 0;
                      setFromIdx(v);
                      setRange({ fromIndex: v, toIndex: toIdx });
                    }}
                  />
                  —
                  <input
                    type="number"
                    min={0}
                    max={totalCount}
                    value={toIdx}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 0;
                      setToIdx(v);
                      setRange({ fromIndex: fromIdx, toIndex: v });
                    }}
                  />
                </span>
              )}
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!range.onlyUser}
                onChange={(e) => setRange({ ...range, onlyUser: e.target.checked })}
              />
              {t("analyze.rangeUser")}
            </label>
          </div>
        </section>

        <section>
          {!streaming ? (
            <button
              onClick={handleStart}
              disabled={!hasApiKey || !meta?.jsonlPath}
              className="primary"
            >
              <Play size={14} /> {t("analyze.start")}
            </button>
          ) : (
            <button onClick={cancel} className="danger">
              <Square size={14} /> {t("analyze.stop")}
            </button>
          )}
          {!hasApiKey && (
            <div className="warning">{t("analyze.noApiKey")}</div>
          )}
        </section>
      </div>

      <div className="analyze-result">
        <div className="analyze-result-header">
          <h2>{t("analyze.result")}</h2>
          <div className="analyze-stats">
            {streaming && <span className="streaming">● {t("analyze.streaming")}</span>}
            {(inputTokens > 0 || outputTokens > 0) && (
              <span>
                已用 {formatNumber(inputTokens + outputTokens)} tokens
              </span>
            )}
          </div>
        </div>
        {error && <div className="error">{t("analyze.error", { msg: error })}</div>}
        {result ? (
          <div className="analyze-result-body">
            <Markdown text={result} />
          </div>
        ) : (
          <div className="analyze-result-empty">
            {streaming ? t("analyze.streaming") : "点击「开始分析」以运行"}
          </div>
        )}
      </div>
    </div>
  );
}
