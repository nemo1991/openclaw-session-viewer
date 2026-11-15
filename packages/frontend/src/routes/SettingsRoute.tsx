import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import {
  ArrowLeft,
  Save,
  FolderOpen,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Database,
  ExternalLink,
  ShieldCheck,
  Activity,
} from "lucide-react";

import { useSettingsStore } from "../state/settingsStore";
import { apiPickExportDir, apiRevealInFinder } from "../lib/api";
import {
  DEFAULT_HEALTH_RULES,
  type CustomRootConfig,
  type CustomRootKind,
  type HealthRulesConfig,
} from "@ocsv/shared";
// v0.8.10: DatabasePanel 从 inline (~150 行 JSX) 抽到 components/DatabasePanel.tsx,
// 便于单独 unit test。SettingsRoute 只 import,不再 bind 业务逻辑。
import { DatabasePanel } from "../components/DatabasePanel";
import "./SettingsRoute.css";

export default function SettingsRoute() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { settings, save, update } = useSettingsStore();
  const [showKey, setShowKey] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  const handleSave = async () => {
    await save(settings);
    setSavedHint(true);
    setTimeout(() => setSavedHint(false), 2000);
  };

  const handlePickDir = async () => {
    const dir = await apiPickExportDir();
    if (dir) {
      update({ defaultExportDir: dir });
    }
  };

  /** v0.11 (B3): 老 settings.json 没有 healthRules 时用估算默认值兜底 */
  const healthRules: HealthRulesConfig = settings.healthRules ?? DEFAULT_HEALTH_RULES;
  /** 改任一阈值都是整体替换 healthRules —— 保存后体检页 useMemo 自动重算 */
  const setHealthRule = (patch: Partial<HealthRulesConfig>) => {
    update({ healthRules: { ...healthRules, ...patch } });
  };

  const handleAddCustomRoot = async () => {
    const dir = await apiPickExportDir();
    if (!dir) return;
    // 自动探测 kind:从路径最后一段看是不是 .openclaw/.claude/.kimi/.dsh
    // (更精确的探测在后端 probe,这里只是 UI 初值)
    const lastSeg = dir.split(/[/\\]/).filter(Boolean).pop() ?? dir;
    const looksLikeOpenclaw = lastSeg.toLowerCase().includes("openclaw");
    const looksLikeClaude = lastSeg.toLowerCase().includes("claude");
    const looksLikeKimi = lastSeg.toLowerCase().includes("kimi");
    const looksLikeDsh = lastSeg.toLowerCase().includes("dsh");
    let kind: CustomRootKind;
    if (looksLikeKimi && (looksLikeClaude || looksLikeOpenclaw)) {
      // 混用 — 落到最宽松,实际 probe 在后端再 refine
      kind = "Both"; // 包含 Kimi 时 UI 没有 "All",最接近是 Both(后端接受)
    } else if (looksLikeOpenclaw && looksLikeClaude) {
      kind = "Both";
    } else if (looksLikeOpenclaw) {
      kind = "OpenClaw";
    } else if (looksLikeClaude) {
      kind = "Claude";
    } else if (looksLikeKimi) {
      // v0.9.0: CustomRootKind union 不含 "Kimi"(用 Both 兜底 — 后端 probe 识别)
      kind = "Both";
    } else if (looksLikeDsh) {
      // v0.9.28 (M11): CustomRootKind union 不含 "dsh"(用 Both 兜底 — 后端 probe 识别)
      kind = "Both";
    } else {
      kind = "OpenClaw"; // 默认猜 OpenClaw(用户最常见场景)
    }

    const newRoot: CustomRootConfig = {
      label: lastSeg,
      path: dir,
      kind,
    };
    update({ customRoots: [...(settings.customRoots ?? []), newRoot] });
  };

  const handleRemoveCustomRoot = (idx: number) => {
    const next = (settings.customRoots ?? []).filter((_, i) => i !== idx);
    update({ customRoots: next });
  };

  const handleUpdateRootLabel = (idx: number, label: string) => {
    const next = (settings.customRoots ?? []).map((r, i) => (i === idx ? { ...r, label } : r));
    update({ customRoots: next });
  };

  // v0.6.x: 一键把 defaultExportDir 设到 ~/.claude (lock-down 模式下 plan 路径能 reveal)
  // 这是 '一键开启允许越界' 的反向: 不放松安全, 而是设更宽的 workspaceRoot
  const setWorkspaceRootToClaudeHome = () => {
    // 没法直接获取 homedir, 让用户用 pickDir
    handlePickDir();
  };

  return (
    <div className="settings-page">
      <header className="settings-header">
        <button onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> {t("detail.back")}
        </button>
        <h1>⚙ {t("settings.title")}</h1>
        <button onClick={handleSave} className="primary">
          <Save size={14} /> {t("settings.save")}
        </button>
        {savedHint && <span className="saved-hint">{t("settings.saved")}</span>}
      </header>

      <div className="settings-body">
        <section>
          <h2>{t("settings.api")}</h2>
          <div className="field">
            <label>{t("settings.baseUrl")}</label>
            <input
              type="text"
              value={settings.anthropic.baseUrl}
              onChange={(e) =>
                update({ anthropic: { ...settings.anthropic, baseUrl: e.target.value } })
              }
              placeholder="https://api.anthropic.com"
            />
            <p className="hint">支持任何 Anthropic 兼容接口(如 MiniMax、其他代理)</p>
          </div>
          <div className="field">
            <label>{t("settings.apiKey")}</label>
            <div className="key-input">
              <input
                type={showKey ? "text" : "password"}
                value={settings.anthropic.apiKey}
                onChange={(e) =>
                  update({ anthropic: { ...settings.anthropic, apiKey: e.target.value } })
                }
                placeholder="sk-ant-..."
              />
              <button onClick={() => setShowKey(!showKey)} type="button">
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div className="field">
            <label>{t("settings.model")}</label>
            <input
              type="text"
              value={settings.anthropic.model}
              onChange={(e) =>
                update({ anthropic: { ...settings.anthropic, model: e.target.value } })
              }
            />
            <p className="hint">推荐: claude-sonnet-4-6, claude-opus-4-8</p>
          </div>
          <div className="field">
            <label>{t("settings.maxTokens")}</label>
            <input
              type="number"
              min={512}
              max={32000}
              value={settings.anthropic.maxTokens}
              onChange={(e) =>
                update({
                  anthropic: {
                    ...settings.anthropic,
                    maxTokens: parseInt(e.target.value) || 4096,
                  },
                })
              }
            />
          </div>
        </section>

        <section>
          <h2>{t("settings.appearance")}</h2>
          <div className="field">
            <label>{t("settings.theme")}</label>
            <select
              value={settings.theme}
              onChange={(e) => update({ theme: e.target.value as any })}
            >
              <option value="dark">{t("settings.themeDark")}</option>
              <option value="light">{t("settings.themeLight")}</option>
              <option value="system">{t("settings.themeSystem")}</option>
            </select>
          </div>
          <div className="field">
            <label>{t("settings.language")}</label>
            <select
              value={settings.uiLanguage}
              onChange={(e) => {
                const lang = e.target.value as "zh-CN" | "en-US";
                update({ uiLanguage: lang });
                void i18n.changeLanguage(lang);
              }}
            >
              <option value="zh-CN">{t("settings.langZhCN")}</option>
              <option value="en-US">{t("settings.langEnUS")}</option>
            </select>
          </div>
          {/* v0.4.2: 时区设置 */}
          <div className="field">
            <label>{t("settings.timezone")}</label>
            <select
              value={settings.timezone ?? "auto"}
              onChange={(e) => update({ timezone: e.target.value })}
            >
              <option value="auto">
                {t("settings.timezoneAuto", {
                  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                })}
              </option>
              <option value="UTC">UTC</option>
              <option value="Asia/Shanghai">Asia/Shanghai (UTC+8)</option>
              <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
              <option value="Europe/London">Europe/London</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
            </select>
          </div>
        </section>

        {/* v0.6.x: 文件路径 reveal 安全策略 (用户报 '设置中并没有reveal的相关设置') */}
        <section className="path-security-section">
          <h2>
            <ShieldCheck size={14} /> {t("settings.pathSecurity.title")}
          </h2>
          <p className="hint">{t("settings.pathSecurity.hint")}</p>

          <div className="field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                data-testid="settings-allow-relaxed"
                checked={settings.pathSecurity?.allowRelaxed ?? false}
                onChange={(e) => update({ pathSecurity: { allowRelaxed: e.target.checked } })}
              />
              <span>{t("settings.pathSecurity.allowRelaxed")}</span>
            </label>
            <p className="hint">{t("settings.pathSecurity.allowRelaxedHint")}</p>
          </div>

          {!(settings.pathSecurity?.allowRelaxed ?? false) && (
            <div className="field path-security-alternative">
              <p className="hint">
                提示: lock-down 模式下,路径必须在「默认导出目录」子树内。如果需要 reveal plan 文件 ({" "}
                <code>~/.claude/plans/*.md</code> ), 请把下方「默认导出目录」设为
                <code>~/.claude</code>。
              </p>
              <button
                type="button"
                onClick={setWorkspaceRootToClaudeHome}
                className="secondary"
                data-testid="settings-pick-claude-home"
              >
                <FolderOpen size={12} /> 选择 ~/.claude 作为默认导出目录
              </button>
            </div>
          )}
        </section>

        {/* v0.11 (B3): 体检规则阈值 —— 本地 settings.json 持久化,重启保留 */}
        <section className="health-rules-section" data-testid="settings-health-rules">
          <h2>
            <Activity size={14} /> {t("settings.healthCheck.title")}
          </h2>
          <p className="hint">{t("settings.healthCheck.hint")}</p>

          <HealthRuleField
            label={t("settings.healthCheck.highErrors")}
            hint={t("settings.healthCheck.highErrorsHint")}
            valueLabel={t("settings.healthCheck.threshold")}
            enabled={healthRules.highErrorsEnabled}
            value={healthRules.highErrorsThreshold}
            testId="settings-health-high-errors"
            onToggle={(v) => setHealthRule({ highErrorsEnabled: v })}
            onValue={(v) => setHealthRule({ highErrorsThreshold: v })}
          />
          <HealthRuleField
            label={t("settings.healthCheck.tokenOutlier")}
            hint={t("settings.healthCheck.tokenSigmaHint")}
            valueLabel={t("settings.healthCheck.tokenSigma")}
            enabled={healthRules.tokenOutlierEnabled}
            value={healthRules.tokenSigma}
            step={0.5}
            min={0.01}
            max={100}
            testId="settings-health-token-outlier"
            onToggle={(v) => setHealthRule({ tokenOutlierEnabled: v })}
            onValue={(v) => setHealthRule({ tokenSigma: v })}
          />
          <HealthRuleField
            label={t("settings.healthCheck.subagents")}
            hint={t("settings.healthCheck.subagentsHint")}
            valueLabel={t("settings.healthCheck.threshold")}
            enabled={healthRules.subagentsEnabled}
            value={healthRules.subagentsThreshold}
            testId="settings-health-subagents"
            onToggle={(v) => setHealthRule({ subagentsEnabled: v })}
            onValue={(v) => setHealthRule({ subagentsThreshold: v })}
          />
          <HealthRuleField
            label={t("settings.healthCheck.modelDrift")}
            hint={t("settings.healthCheck.modelDriftHint")}
            valueLabel={t("settings.healthCheck.modelDriftMinModels")}
            enabled={healthRules.modelDriftEnabled}
            value={healthRules.modelDriftMinModels}
            min={2}
            max={100}
            testId="settings-health-model-drift"
            onToggle={(v) => setHealthRule({ modelDriftEnabled: v })}
            onValue={(v) => setHealthRule({ modelDriftMinModels: v })}
          />

          <button
            type="button"
            className="secondary"
            data-testid="settings-health-reset"
            onClick={() => setHealthRule({ ...DEFAULT_HEALTH_RULES })}
          >
            {t("settings.healthCheck.reset")}
          </button>
        </section>

        {/* v0.2.5: 数据源管理 */}
        <section>
          <h2>
            <Database size={14} /> {t("settings.dataSources.title")}
          </h2>
          <p className="hint">{t("settings.dataSources.hint")}</p>

          <div className="data-source-row default">
            <div>
              <strong>{t("settings.dataSources.default")}</strong>
              <div className="data-source-paths">
                <code>~/.claude</code>
                <code>~/.openclaw</code>
                {/* v0.9.0: Kimi Code — v0.9.1: 默认 home 改为 ~/.kimi-code */}
                <code>~/.kimi-code</code>
                {/* v0.9.28 (M11): DeepSeek Harness */}
                <code>~/.dsh</code>
              </div>
            </div>
          </div>

          {(settings.customRoots ?? []).map((root, idx) => (
            <div key={`${root.path}-${idx}`} className="data-source-row">
              <input
                className="data-source-label"
                value={root.label}
                onChange={(e) => handleUpdateRootLabel(idx, e.target.value)}
                placeholder="标签"
              />
              <code className="data-source-path">{root.path}</code>
              <span className={`kind-badge kind-${root.kind.toLowerCase()}`}>{root.kind}</span>
              <button
                type="button"
                onClick={() => apiRevealInFinder(root.path, null, true)}
                title="在文件管理器中打开"
              >
                <ExternalLink size={12} />
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => handleRemoveCustomRoot(idx)}
                title="删除"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          <button type="button" className="add-root" onClick={handleAddCustomRoot}>
            <Plus size={14} /> {t("settings.dataSources.add")}
          </button>
        </section>

        <section>
          <h2>{t("settings.export")}</h2>
          <div className="field">
            <label>{t("settings.defaultExportDir")}</label>
            <div className="dir-input">
              <input
                type="text"
                value={settings.defaultExportDir ?? ""}
                onChange={(e) => update({ defaultExportDir: e.target.value })}
                placeholder="未选择"
              />
              <button onClick={handlePickDir}>
                <FolderOpen size={14} /> {t("settings.pickDir")}
              </button>
              {settings.defaultExportDir && (
                <button onClick={() => apiRevealInFinder(settings.defaultExportDir!, null, true)}>
                  打开
                </button>
              )}
            </div>
          </div>
        </section>

        {/* v0.8.0: 数据库 — 同步状态 / 一键 Rebuild / Export/Import overrides */}
        <section>
          <h2>
            <Database size={16} /> 数据库 (observer.db)
          </h2>
          <DatabasePanel />
        </section>
      </div>
    </div>
  );
}

/** v0.11 (B3): 一条体检规则的「启用开关 + 数值阈值」输入行 */
interface HealthRuleFieldProps {
  label: string;
  hint: string;
  valueLabel: string;
  enabled: boolean;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  testId: string;
  onToggle: (v: boolean) => void;
  onValue: (v: number) => void;
}

function HealthRuleField({
  label,
  hint,
  valueLabel,
  enabled,
  value,
  step = 1,
  min = 0,
  max = 1_000_000,
  testId,
  onToggle,
  onValue,
}: HealthRuleFieldProps) {
  return (
    <div className="field">
      <label className="checkbox-row">
        <input
          type="checkbox"
          data-testid={`${testId}-enabled`}
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      <label className="health-rule-threshold">
        {valueLabel}
        <input
          type="number"
          data-testid={`${testId}-value`}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onValue(Number(e.target.value))}
        />
      </label>
      <p className="hint">{hint}</p>
    </div>
  );
}
