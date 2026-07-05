/**
 * RevealErrorToast — 全局 reveal 错误 toast 容器 (v0.6.x)
 *
 * 接 REVEAL_ERROR_EVENT, 把 reveal 失败弹到屏幕角落(右上),
 * 用户能看到(即使 meta 块不在当前视野)。
 *
 * 持续 6s 自动消失, 鼠标 hover 暂停。点击 '去设置' 跳到 settings 页。
 *
 * 用法 (App.tsx):
 *   <RevealErrorToast />
 *
 * 设计选择:
 * - 不用第三方 toast 库 (sonner / react-toastify), 简化为自建 hook + 容器
 * - 多个错同时显示 (e.g. 用户连续点 plan_mode reveal 失败 3 次), 排成栈
 * - toast 按钮 [复制路径] / [去设置] 复用 useFileReveal 周边
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Copy, Check, X, Settings, FileWarning } from "lucide-react";
import { REVEAL_ERROR_EVENT } from "../hooks/useFileReveal";

interface RevealErrorToastItem {
  id: number;
  path: string;
  error: string;
}

const TOAST_LIFE_MS = 6000;

export function RevealErrorToast() {
  const [items, setItems] = useState<RevealErrorToastItem[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const { t } = useTranslation();
  const navigate = useNavigate();

  // 监听 REVEAL_ERROR_EVENT
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ path: string; error: string }>).detail;
      if (!detail) return;
      const item: RevealErrorToastItem = {
        id: Date.now() + Math.random(),
        path: detail.path,
        error: detail.error,
      };
      setItems((prev) => [...prev, item]);
      // 6s 自动消失
      setTimeout(() => {
        setItems((prev) => prev.filter((p) => p.id !== item.id));
      }, TOAST_LIFE_MS);
    };
    window.addEventListener(REVEAL_ERROR_EVENT, handler);
    return () => window.removeEventListener(REVEAL_ERROR_EVENT, handler);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const goSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  const copyPath = useCallback(async (id: number, path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      console.warn("toast copy 失败:", e);
    }
  }, []);

  // 简化 user-facing 错误文案 (去掉 'PathSecurity: ' 前缀, 让用户更容易看懂)
  const userError = (err: string): string => {
    if (err.startsWith("PathSecurity: 需提供 workspace_root")) {
      return "请在「设置 → 数据源」中配置默认导出目录,或开启「允许 reveal 越界」";
    }
    if (err.includes("不在 workspace") || err.includes("不在任一已知 root 下")) {
      return "路径不在允许范围内, 开启「允许 reveal 越界」或选择更宽的 root";
    }
    return err.replace(/^PathSecurity:\s*/, "");
  };

  if (items.length === 0) return null;

  return (
    <div
      className="reveal-error-toast-stack"
      data-testid="reveal-error-toast-stack"
      role="alert"
      aria-live="polite"
    >
      {items.map((item) => (
        <div key={item.id} className="reveal-error-toast" data-testid="reveal-error-toast">
          <div className="reveal-error-toast-icon">
            <FileWarning size={16} />
          </div>
          <div className="reveal-error-toast-body">
            <div className="reveal-error-toast-title">reveal 失败</div>
            <div className="reveal-error-toast-msg" title={item.error}>
              {userError(item.error)}
            </div>
            <code className="reveal-error-toast-path" title={item.path}>
              {item.path}
            </code>
          </div>
          <div className="reveal-error-toast-actions">
            <button
              type="button"
              className="reveal-error-toast-btn"
              data-testid="reveal-error-copy-path"
              onClick={() => copyPath(item.id, item.path)}
              title="复制路径到剪贴板"
            >
              {copiedId === item.id ? <Check size={12} /> : <Copy size={12} />}
              {copiedId === item.id ? "已复制" : "复制路径"}
            </button>
            <button
              type="button"
              className="reveal-error-toast-btn reveal-error-toast-btn-primary"
              data-testid="reveal-error-go-settings"
              onClick={goSettings}
              title="跳到设置页"
            >
              <Settings size={12} />
              去设置
            </button>
            <button
              type="button"
              className="reveal-error-toast-btn reveal-error-toast-btn-close"
              data-testid="reveal-error-dismiss"
              onClick={() => dismiss(item.id)}
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
