/**
 * v0.12 (A1 / FR-N1~N6): 全局左侧常驻侧边栏导航
 *
 * 设计约束:
 * - SideNav 挂在 <Routes> 外层,不随路由切换卸载(仅右侧内容区切换)。
 * - 当前项高亮以 useLocation(pathname + ?view=) 为**唯一真相源**,不引入独立
 *   选中 state —— GraphExplorerRoute 的 explorer-tabs 也读同一个 URL,天然双向同步。
 * - 强制保留 ?view=graph|analytics|rag|health 深链;本组件只做 navigate,不解析/改写参数。
 * - 一级项共 7 个,「体检」直接指向 /graph?view=health,把 v0.11 能力升为一等公民。
 * - 零网络请求、零新增权限,仅做本地路由跳转 (D-2)。
 */

import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MessageSquare,
  Network,
  BarChart3,
  Activity,
  Sparkles,
  Wrench,
  Settings,
  type LucideIcon,
} from "lucide-react";
import "./AppLayout.css";

interface NavItem {
  /** i18n key: nav.<key> */
  key: string;
  to: string;
  icon: LucideIcon;
  /** 以 location 为真相源判定是否高亮 */
  match: (pathname: string, view: string | null) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    key: "sessions",
    to: "/",
    icon: MessageSquare,
    // 会话详情页 / 分析页 / trajectory 属于会话域,归入「会话」高亮,
    // 避免用户在二级页面看到侧边栏零高亮。仍然完全由 URL 推导。
    match: (p) => p === "/" || p.startsWith("/session/") || p.startsWith("/analyze/"),
  },
  {
    key: "graph",
    to: "/graph?view=graph",
    icon: Network,
    match: (p, v) => p.startsWith("/graph") && (v ?? "graph") === "graph",
  },
  {
    key: "analytics",
    to: "/graph?view=analytics",
    icon: BarChart3,
    match: (p, v) => p.startsWith("/graph") && v === "analytics",
  },
  {
    key: "health",
    to: "/graph?view=health",
    icon: Activity,
    match: (p, v) => p.startsWith("/graph") && v === "health",
  },
  {
    key: "rag",
    to: "/graph?view=rag",
    icon: Sparkles,
    match: (p, v) => p.startsWith("/graph") && v === "rag",
  },
  {
    key: "tools",
    to: "/tools",
    icon: Wrench,
    match: (p) => p.startsWith("/tools"),
  },
  {
    key: "settings",
    to: "/settings",
    icon: Settings,
    match: (p) => p.startsWith("/settings"),
  },
];

function SideNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  // HashRouter 下 /#/graph?view=health 的 location.search 即 "?view=health"
  const view = new URLSearchParams(location.search).get("view");

  return (
    <nav className="side-nav" aria-label={t("nav.ariaLabel")}>
      <button
        type="button"
        className="side-nav-logo"
        onClick={() => navigate("/")}
        title={t("nav.home")}
        aria-label={t("nav.home")}
        data-testid="side-nav-logo"
      >
        <span className="side-nav-logo-mark" aria-hidden="true">
          ◈
        </span>
        <span className="side-nav-logo-text">{t("app.title")}</span>
      </button>

      <div className="side-nav-items">
        {NAV_ITEMS.map((item) => {
          const active = item.match(location.pathname, view);
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.key}
              className={`side-nav-item${active ? " active" : ""}`}
              onClick={() => navigate(item.to)}
              aria-current={active ? "page" : undefined}
              title={t(`nav.${item.key}`)}
              data-testid={`nav-${item.key}`}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(`nav.${item.key}`)}</span>
            </button>
          );
        })}
      </div>

      <div className="side-nav-footer" aria-hidden="true">
        <span>{t("nav.localOnly")}</span>
      </div>
    </nav>
  );
}

/** 全局布局:左侧 SideNav 常驻 + 右侧路由出口。children 即 <Routes>。 */
export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <SideNav />
      <main className="app-layout-content">{children}</main>
    </div>
  );
}
