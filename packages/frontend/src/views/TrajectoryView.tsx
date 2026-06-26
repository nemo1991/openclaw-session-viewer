import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  CheckCircle2,
  FileText,
  Layers,
  Play,
  Square,
  Zap,
} from "lucide-react";

import { useTrajectoryStore } from "../state/trajectoryStore";
import type { TrajectoryEventFE } from "../lib/api";
import { formatTimeExact } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import "./TrajectoryView.css";

interface Props {
  sessionPath: string;
}

export function TrajectoryView({ sessionPath }: Props) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  const { events, loading, totalCount, loadedCount, error, start, reset } = useTrajectoryStore();

  useEffect(() => {
    void start(sessionPath);
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPath]);

  const summary = useMemo(() => buildSummary(events), [events]);

  if (error) {
    return (
      <div className="trajectory-view">
        <div className="trajectory-error">
          <AlertTriangle size={16} /> {error}
        </div>
      </div>
    );
  }

  return (
    <div className="trajectory-view">
      <div className="trajectory-toolbar">
        <Activity size={14} />
        <span className="trajectory-title">{t("trajectory.title")}</span>
        {summary.startedAt && summary.endedAt && (
          <span className="trajectory-duration">
            {formatTimeExact(summary.startedAt, fmtOpts)} →{" "}
            {formatTimeExact(summary.endedAt, fmtOpts)}
          </span>
        )}
        <span className="trajectory-counter">
          {loading
            ? t("trajectory.loadingProgress", {
                loaded: loadedCount,
                total: totalCount || "?",
              })
            : t("trajectory.totalCount", { count: events.length })}
        </span>
      </div>

      <div className="trajectory-list">
        {events.length === 0 && loading && (
          <div className="trajectory-empty">{t("trajectory.loading")}</div>
        )}
        {events.length === 0 && !loading && (
          <div className="trajectory-empty">{t("trajectory.empty")}</div>
        )}
        {events.map((ev, i) => (
          <TrajectoryEventCard key={`${ev.seq}-${i}`} event={ev} />
        ))}
      </div>
    </div>
  );
}

interface Summary {
  startedAt?: string;
  endedAt?: string;
  totalLatencyMs?: number;
  totalTokens?: number;
  totalPrompts?: number;
}

function buildSummary(events: TrajectoryEventFE[]): Summary {
  const started = events.find((e) => e.eventType === "session.started");
  const ended = events.find((e) => e.eventType === "session.ended");
  const totalTokens = events.reduce((sum, e) => {
    const u = (e.data as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)
      ?.usage;
    return sum + (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
  }, 0);
  const totalLatencyMs = events.reduce((sum, e) => {
    const lat = (e.data as { latencyMs?: number } | undefined)?.latencyMs;
    return sum + (lat ?? 0);
  }, 0);
  const totalPrompts = events.filter(
    (e) => e.eventType === "prompt.submitted" || e.eventType === "context.compiled"
  ).length;
  return {
    startedAt: started?.ts,
    endedAt: ended?.ts,
    totalLatencyMs: totalLatencyMs > 0 ? totalLatencyMs : undefined,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    totalPrompts: totalPrompts > 0 ? totalPrompts : undefined,
  };
}

function TrajectoryEventCard({ event }: { event: TrajectoryEventFE }) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  const meta = cardMeta(event.eventType);
  const data = (event.data ?? {}) as Record<string, unknown>;
  const Icon = meta.icon;
  const detailEntries = Object.entries(data).slice(0, 6);

  return (
    <div className={`trajectory-event trajectory-event-${meta.tone}`}>
      <div className="trajectory-event-header">
        <span className={`trajectory-event-badge badge-${meta.tone}`}>
          <Icon size={12} /> {t(`trajectory.events.${meta.i18nKey}`)}
        </span>
        <span className="trajectory-event-time">{formatTimeExact(event.ts, fmtOpts)}</span>
        <span className="trajectory-event-seq">#{event.seq}</span>
      </div>
      {meta.summary(data) && <div className="trajectory-event-summary">{meta.summary(data)}</div>}
      {detailEntries.length > 0 && (
        <details className="trajectory-event-details">
          <summary>{t("trajectory.details")}</summary>
          <div className="trajectory-event-fields">
            {detailEntries.map(([k, v]) => (
              <div key={k} className="trajectory-event-field">
                <span className="field-name">{k}</span>
                <span className="field-value">{stringify(v)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

interface CardMeta {
  i18nKey: string;
  tone: "info" | "success" | "warning" | "neutral";
  icon: typeof Play;
  summary: (data: Record<string, unknown>) => string | null;
}

function cardMeta(eventType: string): CardMeta {
  switch (eventType) {
    case "session.started":
      return {
        i18nKey: "sessionStarted",
        tone: "info",
        icon: Play,
        summary: (d) => `trigger: ${d.trigger ?? "?"}`,
      };
    case "session.ended":
      return {
        i18nKey: "sessionEnded",
        tone: "neutral",
        icon: Square,
        summary: (d) => `status: ${d.status ?? "?"}`,
      };
    case "trace.metadata":
      return { i18nKey: "traceMetadata", tone: "neutral", icon: Layers, summary: () => null };
    case "context.compiled":
      return {
        i18nKey: "contextCompiled",
        tone: "neutral",
        icon: Box,
        summary: (d) => {
          const sysLen = (d.systemPrompt as string | undefined)?.length ?? 0;
          return `system: ${sysLen} chars`;
        },
      };
    case "prompt.submitted":
      return {
        i18nKey: "promptSubmitted",
        tone: "info",
        icon: FileText,
        summary: (d) => {
          const count = (d.imagesCount as number | undefined) ?? 0;
          return count > 0 ? `${count} image(s)` : null;
        },
      };
    case "model.fallback_step":
      return {
        i18nKey: "modelFallback",
        tone: "warning",
        icon: ArrowRight,
        summary: (d) => `${d.source ?? "?"} → ${d.target ?? "?"}`,
      };
    case "model.completed":
      return {
        i18nKey: "modelCompleted",
        tone: "success",
        icon: CheckCircle2,
        summary: (d) => {
          const lat = (d.latencyMs as number | undefined) ?? 0;
          const tok = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          const parts: string[] = [];
          if (lat) parts.push(`${lat}ms`);
          if (tok) {
            parts.push(`${(tok.input_tokens ?? 0) + (tok.output_tokens ?? 0)} tok`);
          }
          return parts.length > 0 ? parts.join(" · ") : null;
        },
      };
    case "trace.artifacts":
      return { i18nKey: "traceArtifacts", tone: "neutral", icon: Layers, summary: () => null };
    default:
      return { i18nKey: "unknown", tone: "neutral", icon: Zap, summary: () => null };
  }
}
