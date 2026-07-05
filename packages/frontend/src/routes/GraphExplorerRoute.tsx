/**
 * GraphExplorerRoute — /graph 顶 tab 入口
 *
 * - 内部 3 个子 view:G1 Graph / G2 Analytics / G3 RAG
 * - 子 tab 用 ?view=graph|analytics|rag query string (主项目 react-router-dom v6 深链)
 * - 跨 tab prefill:?q= 直接传给 RagChat (G1 详情面板 "G3 RAG" 按钮跳过来)
 * - G1/G2/G3 共享 graphStore / titleStore
 * - titleStore 跨 tab 同步挂在 mount 时
 */

import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { GraphView } from "../views/graph/GraphView";
import { AnalyticsView } from "../views/graph/AnalyticsView";
import { RagChat } from "../views/graph/RagChat";
import { useTitleStoreStorageBridge } from "../views/graph/titleStore";
import "./GraphExplorerRoute.css";

type View = "graph" | "analytics" | "rag";

export default function GraphExplorerRoute() {
  useTitleStoreStorageBridge(); // 挂全局 storage 事件桥
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) || "graph";
  const initialRagQuery = params.get("q");

  // 兜底:view 非法时纠正到 graph
  useEffect(() => {
    if (view !== "graph" && view !== "analytics" && view !== "rag") {
      setParams({ view: "graph" }, { replace: true });
    }
  }, [view, setParams]);

  const switchView = (v: View) => {
    // 切 view 时清掉 ?q= 避免下一次进 G3 还残留
    setParams(v === "rag" ? { view: v } : { view: v }, { replace: true });
  };

  // 消费:onConsumed 清除 ?q= (RagChat 用完即清)
  const consumeRagQuery = () => {
    if (initialRagQuery) {
      const next = new URLSearchParams(params);
      next.delete("q");
      setParams(next, { replace: true });
    }
  };

  return (
    <div className="graph-explorer">
      <nav className="explorer-tabs" role="tablist">
        <button
          className={`tab ${view === "graph" ? "active" : ""}`}
          onClick={() => switchView("graph")}
          role="tab"
        >
          G1 Graph
        </button>
        <button
          className={`tab ${view === "analytics" ? "active" : ""}`}
          onClick={() => switchView("analytics")}
          role="tab"
        >
          G2 Analytics
        </button>
        <button
          className={`tab ${view === "rag" ? "active" : ""}`}
          onClick={() => switchView("rag")}
          role="tab"
        >
          G3 RAG
        </button>
      </nav>

      <div className="explorer-content">
        {view === "graph" && <GraphView />}
        {view === "analytics" && <AnalyticsView />}
        {view === "rag" && (
          <RagChat
            key={initialRagQuery ?? "_default"} // 同一 query 不重 mount,F5 同一 URL 不重 mount
            initialQuery={initialRagQuery}
            onConsumed={consumeRagQuery}
          />
        )}
      </div>
    </div>
  );
}
