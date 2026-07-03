/**
 * GraphExplorerRoute — /graph 顶 tab 入口
 *
 * - 内部 3 个子 view:G1 Graph / G2 Analytics / G3 RAG (M2 + M3 完整, M1 只 G1)
 * - 子 tab 用 ?view=graph|analytics|rag query string (主项目 react-router-dom v6 深链)
 * - G1/G2/G3 共享 graphStore / titleStore
 * - titleStore 跨 tab 同步挂在 mount 时
 */

import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { GraphView } from "../views/graph/GraphView";
import { useTitleStoreStorageBridge } from "../views/graph/titleStore";
import "./GraphExplorerRoute.css";

type View = "graph" | "analytics" | "rag";

export default function GraphExplorerRoute() {
  useTitleStoreStorageBridge(); // 挂全局 storage 事件桥
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) || "graph";

  // 兜底:view 非法时纠正到 graph
  useEffect(() => {
    if (view !== "graph" && view !== "analytics" && view !== "rag") {
      setParams({ view: "graph" }, { replace: true });
    }
  }, [view, setParams]);

  const switchView = (v: View) => {
    setParams({ view: v }, { replace: true });
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
          className={`tab ${view === "analytics" ? "active" : ""} ${view !== "analytics" ? "disabled" : ""}`}
          disabled
          title="G2 Analytics — M2 milestone"
        >
          G2 Analytics <span className="badge-soon">M2</span>
        </button>
        <button
          className={`tab ${view === "rag" ? "active" : ""} ${view !== "rag" ? "disabled" : ""}`}
          disabled
          title="G3 RAG — M2 milestone"
        >
          G3 RAG <span className="badge-soon">M2</span>
        </button>
      </nav>

      <div className="explorer-content">
        {view === "graph" && <GraphView />}
        {view === "analytics" && <div className="coming-soon">G2 Analytics (M2)</div>}
        {view === "rag" && <div className="coming-soon">G3 RAG (M2)</div>}
      </div>
    </div>
  );
}
