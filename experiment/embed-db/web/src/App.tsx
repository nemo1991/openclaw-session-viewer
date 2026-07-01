/**
 * App — 实验 web 根入口
 *
 * 三个 PoC tab:
 * - G1 Graph: react-force-graph 展示
 * - G2 OLAP: recharts + react-table (TODO S2)
 * - G3 RAG: 聊天 UI (TODO S3)
 *
 * S1 阶段只实现 Graph tab。
 */

import { useState } from "react";
import { GraphView } from "./views/GraphView";
import { AnalyticsView } from "./views/AnalyticsView";
import { RagChat } from "./views/RagChat";
import "./App.css";
import "./views/RagChat.css";

type Tab = "graph" | "analytics" | "rag";

const TABS: { key: Tab; label: string; sprint: string }[] = [
  { key: "graph", label: "G1 Graph", sprint: "S1" },
  { key: "analytics", label: "G2 Analytics", sprint: "S2" },
  { key: "rag", label: "G3 RAG", sprint: "S3" },
];

function App() {
  const [tab, setTab] = useState<Tab>("graph");
  return (
    <div className="app">
      <header className="app-header">
        <h1>experimental embed-db · graph explorer</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab ${tab === t.key ? "active" : ""} ${t.sprint.includes("planned") ? "planned" : ""}`}
              onClick={() => !t.sprint.includes("planned") && setTab(t.key)}
              disabled={t.sprint.includes("planned")}
              title={t.sprint.includes("planned") ? `计划在 ${t.sprint}` : ""}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-body">
        {tab === "graph" && <GraphView />}
        {tab === "analytics" && <AnalyticsView />}
        {tab === "rag" && <RagChat />}
      </main>
    </div>
  );
}

export default App;
