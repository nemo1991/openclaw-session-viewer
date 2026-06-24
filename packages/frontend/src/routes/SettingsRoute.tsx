import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
} from "lucide-react";

import { useSettingsStore } from "../state/settingsStore";
import { apiPickExportDir, apiRevealInFinder } from "../lib/api";
import type { CustomRootConfig, CustomRootKind } from "@ocsv/shared";
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

  const handleAddCustomRoot = async () => {
    const dir = await apiPickExportDir();
    if (!dir) return;
    // 自动探测 kind:从路径最后一段看是不是 .openclaw/.claude
    // (更精确的探测在后端 probe,这里只是 UI 初值)
    const lastSeg = dir.split(/[/\\]/).filter(Boolean).pop() ?? dir;
    const looksLikeOpenclaw = lastSeg.toLowerCase().includes("openclaw");
    const looksLikeClaude = lastSeg.toLowerCase().includes("claude");
    let kind: CustomRootKind;
    if (looksLikeOpenclaw && looksLikeClaude) kind = "Both";
    else if (looksLikeOpenclaw) kind = "OpenClaw";
    else if (looksLikeClaude) kind = "Claude";
    else kind = "OpenClaw"; // 默认猜 OpenClaw(用户最常见场景)

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
              onChange={(e) => update({ uiLanguage: e.target.value as any })}
            >
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
            </select>
          </div>
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
                onClick={() => apiRevealInFinder(root.path)}
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
                <button onClick={() => apiRevealInFinder(settings.defaultExportDir!)}>打开</button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
