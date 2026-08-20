/**
 * v0.9.22 (M4): SessionOverview — L1 layer
 *
 * 头部 chrome 下方、TranscriptView 上方的"这是什么 session?" 区域,
 * 包含:
 * - `<SessionSummaryStrip>` — 一行聚合 chip (phaseHint / top-tools /
 *   subagent / thinking / error / repeatRun / idleGap)
 * - `<MetaBannerFold>` — kimi config/perm/tools 历史折叠面板 (kimi-only)
 *
 * 接收 `SessionMeta` props,内部按 `meta.metaBanner` 条件渲染 — 没
 * metaBanner (claude / openclaw) 就不渲染 fold。
 *
 * 之前 v0.4.5 — v0.9.21: 两个组件 (`SessionSummaryStrip` /
 * `MetaBannerFold`) + `formatIdleGapFromMs` 3 个 helper 全部 inline
 * 在 `routes/SessionDetailRoute.tsx`, route 长达 951 行。M4 抽出后
 * route 减到 < 500 行,SessionOverview 自身 ~270 行。
 *
 * 路由:
 * - SessionDetailRoute 顶部 header chrome 渲染完后立即渲染
 *   `<SessionOverview meta={meta} />`
 * - v0.9.22 (M5) 之后 `<ChartsRegion>` 在 SessionOverview 下方、
 *   TranscriptView 上方
 *
 * 设计:SessionOverview 跟 meta 子组件 (ChartBlock / EventMetaBlock /
 * AttachmentBlock) 平行 — L1 给用户的"session 概览"信息,跟 L3/L4
 * 的"单事件 meta"互不耦合。详见 ADR 0002。
 */

import { useState } from "react";
import type { SessionMeta } from "@ocsv/shared";

export interface SessionOverviewProps {
  meta: SessionMeta;
}

/**
 * L1 SessionOverview — 头部 chrome 下方第一个组件。
 *
 * 渲染逻辑:
 * 1. 始终渲染 `<SessionSummaryStrip>` (内部按空数据 hidden)
 * 2. 条件渲染 `<MetaBannerFold>` (kimi session 有 metaBanner,claude /
 *    openclaw 没)
 */
export function SessionOverview({ meta }: SessionOverviewProps) {
  return (
    <div className="session-overview" data-testid="session-overview">
      <SessionSummaryStrip meta={meta} />
      {meta.metaBanner && <MetaBannerFold banner={meta.metaBanner} />}
    </div>
  );
}

/**
 * SessionSummaryStrip — 一行聚合 chip
 *
 * v0.8.4 item 2': 全部从 `meta.*` 读 (DB 算好的派生数据), 不再调
 * `summarizeSession` / `findRepeatRuns` / `findIdleGaps` 实时 O(n) 扫 entries。
 *
 * 数据流:
 * - 后端 sync 二阶段 enrich: `build_meta_full` 算 9 个字段 → 写 session_meta
 * - 前端打开详情: 读 meta.* → 显示 chip
 * - 第一次 sync 走 quick path (50 行), `textMessageCount` + `toolUsage` 即可拿到
 *   (用户立刻看到); `phaseHint` / `repeatRun*` / `idleGap*` 走 enrich, 略等 ~1s
 *
 * 设计: 不抢戏 — 1 行, 小字号, 色块编码. 空数据不渲染。
 */
function SessionSummaryStrip({ meta }: { meta: SessionMeta }) {
  const textMsg = meta.textMessageCount ?? 0;
  const toolUsage = meta.toolUsage ?? [];
  const phaseHint = meta.phaseHint;
  const phaseDetail = meta.phaseDetail;
  const repeatRunCount = meta.repeatRunCount ?? 0;
  const idleGapCount = meta.idleGapCount ?? 0;
  const subagentCount = meta.subagentCount ?? 0;
  const thinkingCount = meta.thinkingCount ?? 0;
  const errorCount = meta.errorCount ?? 0;

  // 空数据不显示(避免加载中闪烁 / 完全没 scan 过的旧 session)
  if (textMsg === 0) return null;
  if (toolUsage.length === 0 && textMsg < 3) return null;
  // 没 phaseHint 说明 enrich 还没跑完 — 等一下
  if (!phaseHint) return null;

  // 取 top 5 tool, 剩余合 "其他" 显示计数
  const topTools = toolUsage.slice(0, 5);
  const otherTools = toolUsage.slice(5);
  const otherCount = otherTools.reduce((a, [, c]) => a + c, 0);
  // v0.8.5 D: 工具占比 % — 总调用数算分母, top 5 每条显示 (count/totalCalls * 100)%
  const totalCalls = toolUsage.reduce((a, [, c]) => a + c, 0);

  return (
    <div className="session-summary-strip" data-testid="session-summary-strip">
      <span className={`ss-phase ss-phase-${phaseHint}`} title={phaseDetail}>
        {phaseHint === "explore" && "探索"}
        {phaseHint === "implement" && "实施"}
        {phaseHint === "mixed" && "混合"}
        {phaseHint === "short" && "短会话"}
        {phaseDetail && <span className="ss-phase-detail"> · {phaseDetail}</span>}
      </span>
      <span className="ss-sep" />
      {topTools.map(([tool, count]) => {
        const pct = totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0;
        return (
          <span
            key={tool}
            className="ss-tool"
            title={`${tool} × ${count} (${pct}%)`}
            data-testid={`ss-tool-${tool}`}
          >
            {tool} <span className="ss-tool-count">{count}</span>
            <span className="ss-tool-pct">{pct}%</span>
          </span>
        );
      })}
      {otherCount > 0 && (
        <span
          className="ss-tool ss-tool-other"
          title={otherTools.map(([t, c]) => `${t} × ${c}`).join("; ")}
        >
          +{otherTools.length} 其他 <span className="ss-tool-count">{otherCount}</span>
        </span>
      )}
      {subagentCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-subagent">subagent × {subagentCount}</span>
        </>
      )}
      {thinkingCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-thinking">thinking × {thinkingCount}</span>
        </>
      )}
      {errorCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-error" title="包含 stopReason=error 的 assistant message">
            错误 × {errorCount}
          </span>
        </>
      )}
      {repeatRunCount > 0 && (
        <>
          <span className="ss-sep" />
          <span
            className="ss-repeat"
            title={
              meta.repeatRunMaxTool && meta.repeatRunMaxCount
                ? `${meta.repeatRunMaxTool} × ${meta.repeatRunMaxCount} (最大段)`
                : `${repeatRunCount} 段连续重复`
            }
          >
            连续重复 {repeatRunCount} 段
            {meta.repeatRunMaxTool && meta.repeatRunMaxCount && (
              <>
                {" · "}
                <span className="ss-repeat-max">
                  {meta.repeatRunMaxTool} × {meta.repeatRunMaxCount}
                </span>
              </>
            )}
          </span>
        </>
      )}
      {idleGapCount > 0 && meta.idleGapMaxMs && (
        <>
          <span className="ss-sep" />
          <span className="ss-idle" title={`最长间隔 ${formatIdleGapFromMs(meta.idleGapMaxMs)}`}>
            {idleGapCount} 长间隔 · 最长 {formatIdleGapFromMs(meta.idleGapMaxMs)}
          </span>
        </>
      )}
    </div>
  );
}

/** ms → "5 分钟" / "2 小时" / "3 天" — SST 自带, 不依赖 sessionInsights 模块 */
function formatIdleGapFromMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 > 0 ? `${hr} 小时 ${min % 60} 分` : `${hr} 小时`;
  const day = Math.floor(hr / 24);
  return hr % 24 > 0 ? `${day} 天 ${hr % 24} 小时` : `${day} 天`;
}

/**
 * v0.9.8: MetaBannerFold — kimi config/perm/tools 历史折叠面板
 *
 * 后端 `meta_banner` JSON 包含:
 * - protocol_version / profile_name / model_alias / thinking_effort / permission_mode
 * - active_tool_count
 * - config_change_count / approval_count / compaction_count
 * - last_compaction_duration_ms
 *
 * 设计:
 * - 默认折叠 — 一行显示 protocol_version + 4 个 count 的简略 tag
 * - 点 chevron 展开 — 显示完整 snapshot
 * - 无 metaBanner 不渲染 (claude/openclaw session 没有)
 */
function MetaBannerFold({ banner }: { banner: NonNullable<SessionMeta["metaBanner"]> }) {
  const [expanded, setExpanded] = useState(false);
  const totalChanges = banner.configChangeCount + banner.approvalCount + banner.compactionCount;

  return (
    <div
      className={`meta-banner-fold ${expanded ? "is-expanded" : ""}`}
      data-testid="meta-banner-fold"
    >
      <button
        className="meta-banner-toggle"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "折叠" : "展开完整 metadata snapshot"}
        data-testid="meta-banner-toggle"
      >
        <span className={`chev ${expanded ? "open" : ""}`}>▶</span>
        <span className="mb-label">📜 Meta</span>
        {banner.protocolVersion && (
          <span className="mb-pill mb-proto" title="kimi wire protocol version">
            v{banner.protocolVersion}
          </span>
        )}
        {banner.modelAlias && (
          <span className="mb-pill mb-model" title="config.update.modelAlias">
            {banner.modelAlias}
          </span>
        )}
        {banner.thinkingEffort && (
          <span className="mb-pill mb-thinking" title="thinking effort">
            🧠 {banner.thinkingEffort}
          </span>
        )}
        {banner.permissionMode && (
          <span className="mb-pill mb-perm" title="permission mode (dsh permission/preset)">
            🔐 {banner.permissionMode}
          </span>
        )}
        {banner.sandboxMode && (
          <span className="mb-pill mb-sandbox" title="sandbox mode (dsh sandbox/mode, M11.5)">
            🧪 {banner.sandboxMode}
          </span>
        )}
        {banner.approvalPolicy && (
          <span
            className="mb-pill mb-approval"
            title="approval policy (dsh approval/policy, M11.5)"
          >
            ⚖ {banner.approvalPolicy}
          </span>
        )}
        {totalChanges > 0 && (
          <span className="mb-pill mb-counts" title="config changes / approvals / compactions">
            {banner.configChangeCount > 0 && `${banner.configChangeCount} cfg`}
            {banner.approvalCount > 0 && ` · ${banner.approvalCount} approve`}
            {banner.compactionCount > 0 && ` · ${banner.compactionCount} compact`}
          </span>
        )}
      </button>
      {expanded && (
        <div className="meta-banner-detail" data-testid="meta-banner-detail">
          {banner.profileName && (
            <div className="mb-row">
              <span className="mb-key">profile</span>
              <span className="mb-val">{banner.profileName}</span>
            </div>
          )}
          {banner.activeToolCount !== undefined && banner.activeToolCount !== null && (
            <div className="mb-row">
              <span className="mb-key">active tools</span>
              <span className="mb-val">{banner.activeToolCount}</span>
            </div>
          )}
          <div className="mb-row">
            <span className="mb-key">config changes</span>
            <span className="mb-val">{banner.configChangeCount}</span>
          </div>
          <div className="mb-row">
            <span className="mb-key">approvals</span>
            <span className="mb-val">{banner.approvalCount}</span>
          </div>
          <div className="mb-row">
            <span className="mb-key">compactions</span>
            <span className="mb-val">{banner.compactionCount}</span>
          </div>
          {banner.lastCompactionDurationMs !== undefined &&
            banner.lastCompactionDurationMs !== null && (
              <div className="mb-row">
                <span className="mb-key">last compact</span>
                <span className="mb-val">{banner.lastCompactionDurationMs} ms</span>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
