/**
 * v0.11 (B1 / FR-H1): 会话体检规则引擎
 *
 * 设计约束:
 * - 纯函数,输入必须是 `foldGraphEntries()` 折叠后的 nodes —— 与 G2 Analytics
 *   共用同一份数据,避免「体检口径」和「分析口径」不一致 (ROADMAP B2)。
 * - 每条标记都带**可解释标签**:命中规则 + 实际值 + 阈值,不做黑盒评分 (RK-V1)。
 * - 所有默认阈值都是 ROADMAP 标注的「估算值」,可在设置页修改并持久化 (B3)。
 * - 空数据 / 缺字段 / 非法阈值一律返回安全结果,绝不抛错、绝不产生 NaN 标签。
 *
 * 复现: `pnpm --filter @ocsv/frontend exec vitest run src/views/graph/health.test.ts`
 */

import { DEFAULT_HEALTH_RULES, type HealthRulesConfig } from "@ocsv/shared";
import { SOURCE_KEYS, sourceKey } from "./analytics";
import type { GraphNode, SourceKey } from "./analytics";

/** v0.11 (B3): 规则结构与默认值定义在 `@ocsv/shared`,此处只做转出,
 * 保证设置页 / 体检页 / Rust settings.json 消费的是同一份定义。 */
export { DEFAULT_HEALTH_RULES };
export type { HealthRulesConfig };

/** 四条规则与 ROADMAP 6 / B1 一一对应 */
export type HealthRuleId = "highErrors" | "tokenOutlier" | "manySubagents" | "modelDrift";

export const HEALTH_RULE_LABELS: Record<HealthRuleId, string> = {
  highErrors: "高错误数",
  tokenOutlier: "token 离群",
  manySubagents: "子会话过多",
  modelDrift: "同会话模型漂移",
};

/** 一条命中记录:UI 显示 label,hover 显示 detail,actual/threshold 可断言 */
export interface HealthFlag {
  rule: HealthRuleId;
  label: string;
  detail: string;
  actual: number;
  threshold: number;
}

export interface FlaggedSession {
  node: GraphNode;
  flags: HealthFlag[];
  /** 命中规则数,用作 Top 风险排序的第一关键字 */
  score: number;
}

export interface HealthRuleBucket {
  rule: HealthRuleId;
  label: string;
  count: number;
}

export interface HealthSourceBucket {
  source: SourceKey;
  total: number;
  flagged: number;
}

export interface HealthReport {
  totalSessions: number;
  flaggedCount: number;
  cleanCount: number;
  /** 按 score → error_count → token_total → session_id 稳定排序 */
  flagged: FlaggedSession[];
  byRule: HealthRuleBucket[];
  bySource: HealthSourceBucket[];
  tokenMean: number;
  tokenStdDev: number;
  /** null = 样本不足或 σ 为 0,此轮不判定 token 离群 */
  tokenCutoff: number | null;
}

const RULE_IDS: HealthRuleId[] = ["highErrors", "tokenOutlier", "manySubagents", "modelDrift"];

/**
 * 把任意来源(老 settings.json / 用户乱填 / IPC 脏数据)归一成合法规则配置。
 * 数值用 clamp 而非直接透传,避免 NaN 让比较永远 false、或负数阈值全量误报。
 */
export function normalizeHealthRules(input?: Partial<HealthRulesConfig> | null): HealthRulesConfig {
  const d = DEFAULT_HEALTH_RULES;
  const num = (v: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

  return {
    highErrorsEnabled: bool(input?.highErrorsEnabled, d.highErrorsEnabled),
    highErrorsThreshold: num(input?.highErrorsThreshold, d.highErrorsThreshold, 0, 1_000_000),
    tokenOutlierEnabled: bool(input?.tokenOutlierEnabled, d.tokenOutlierEnabled),
    // sigma 必须 > 0,否则 cutoff = μ 会把一半会话标成离群
    tokenSigma: num(input?.tokenSigma, d.tokenSigma, 0.01, 100),
    subagentsEnabled: bool(input?.subagentsEnabled, d.subagentsEnabled),
    subagentsThreshold: num(input?.subagentsThreshold, d.subagentsThreshold, 0, 1_000_000),
    modelDriftEnabled: bool(input?.modelDriftEnabled, d.modelDriftEnabled),
    // 至少 2 个模型才叫"漂移",1 个模型没有意义
    modelDriftMinModels: Math.max(
      2,
      Math.round(num(input?.modelDriftMinModels, d.modelDriftMinModels, 2, 100))
    ),
  };
}

/** 总体标准差(population stddev),样本 < 2 时返回 0 */
function populationStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += (v - mean) ** 2;
  return Math.sqrt(sum / values.length);
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

/**
 * 对折叠后的 nodes 执行体检,返回报告。
 * 规则全部是「≥ / >」的单向判定,不输出健康分 —— 避免黑盒 (RK-V1)。
 */
export function evaluateHealth(
  nodes: GraphNode[],
  rulesInput?: Partial<HealthRulesConfig> | null
): HealthReport {
  const rules = normalizeHealthRules(rulesInput);
  const list = Array.isArray(nodes) ? nodes : [];
  const emptyByRule: HealthRuleBucket[] = RULE_IDS.map((rule) => ({
    rule,
    label: HEALTH_RULE_LABELS[rule],
    count: 0,
  }));
  const bySource: HealthSourceBucket[] = SOURCE_KEYS.map((source) => ({
    source,
    total: 0,
    flagged: 0,
  }));
  const sourceIndex = new Map<SourceKey, HealthSourceBucket>(bySource.map((b) => [b.source, b]));

  const base: HealthReport = {
    totalSessions: list.length,
    flaggedCount: 0,
    cleanCount: list.length,
    flagged: [],
    byRule: emptyByRule,
    bySource,
    tokenMean: 0,
    tokenStdDev: 0,
    tokenCutoff: null,
  };
  if (list.length === 0) return base;

  // token 基线:用全体会话(含未命中者)算 μ / σ,口径在 UI 上明确写出
  const tokens = list.map((n) => (Number.isFinite(n.token_total) ? n.token_total : 0));
  const mean = tokens.reduce((a, b) => a + b, 0) / tokens.length;
  const stdDev = populationStdDev(tokens, mean);
  const cutoff = rules.tokenOutlierEnabled && stdDev > 0 ? mean + rules.tokenSigma * stdDev : null;
  base.tokenMean = mean;
  base.tokenStdDev = stdDev;
  base.tokenCutoff = cutoff;

  const flagged: FlaggedSession[] = [];

  for (const node of list) {
    const flags: HealthFlag[] = [];
    const errors = Number.isFinite(node.error_count) ? node.error_count : 0;
    const subagents = Number.isFinite(node.subagent_count) ? node.subagent_count : 0;
    const tokensOfNode = Number.isFinite(node.token_total) ? node.token_total : 0;
    const models = Array.isArray(node.available_models) ? node.available_models.length : 0;

    if (rules.highErrorsEnabled && errors >= rules.highErrorsThreshold) {
      flags.push({
        rule: "highErrors",
        label: `高错误数（${fmtInt(errors)} ≥ ${fmtInt(rules.highErrorsThreshold)}）`,
        detail: `error_count = ${fmtInt(errors)}，阈值 = ${fmtInt(rules.highErrorsThreshold)}`,
        actual: errors,
        threshold: rules.highErrorsThreshold,
      });
    }

    if (cutoff !== null && tokensOfNode > cutoff) {
      flags.push({
        rule: "tokenOutlier",
        label: `token 离群（${fmtInt(tokensOfNode)} > ${fmtInt(cutoff)}）`,
        detail:
          `token_total = ${fmtInt(tokensOfNode)}，均值 μ = ${fmtInt(mean)}，` +
          `总体标准差 σ = ${fmtInt(stdDev)}，判定线 μ + ${rules.tokenSigma}σ = ${fmtInt(cutoff)}`,
        actual: tokensOfNode,
        threshold: cutoff,
      });
    }

    if (rules.subagentsEnabled && subagents >= rules.subagentsThreshold) {
      flags.push({
        rule: "manySubagents",
        label: `子会话过多（${fmtInt(subagents)} ≥ ${fmtInt(rules.subagentsThreshold)}）`,
        detail: `subagent_count = ${fmtInt(subagents)}，阈值 = ${fmtInt(rules.subagentsThreshold)}`,
        actual: subagents,
        threshold: rules.subagentsThreshold,
      });
    }

    if (rules.modelDriftEnabled && models >= rules.modelDriftMinModels) {
      flags.push({
        rule: "modelDrift",
        label: `同会话模型漂移（${models} 个模型 ≥ ${rules.modelDriftMinModels}）`,
        detail:
          `available_models 含 ${models} 个模型，阈值 = ${rules.modelDriftMinModels}；` +
          `主模型 ${node.primary_model ?? "—"}`,
        actual: models,
        threshold: rules.modelDriftMinModels,
      });
    }

    const bucket = sourceIndex.get(sourceKey(node.source));
    if (bucket) {
      bucket.total += 1;
      if (flags.length > 0) bucket.flagged += 1;
    }

    if (flags.length > 0) {
      for (const f of flags) {
        const rb = base.byRule.find((b) => b.rule === f.rule);
        if (rb) rb.count += 1;
      }
      flagged.push({ node, flags, score: flags.length });
    }
  }

  flagged.sort(
    (a, b) =>
      b.score - a.score ||
      b.node.error_count - a.node.error_count ||
      b.node.token_total - a.node.token_total ||
      a.node.session_id.localeCompare(b.node.session_id)
  );

  base.flagged = flagged;
  base.flaggedCount = flagged.length;
  base.cleanCount = list.length - flagged.length;
  return base;
}
