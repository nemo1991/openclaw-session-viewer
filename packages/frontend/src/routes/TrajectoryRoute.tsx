import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";

import { TrajectoryView } from "../views/TrajectoryView";
import type { SessionMeta } from "@ocsv/shared";

export default function TrajectoryRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const meta = (location.state as { session?: SessionMeta } | null)?.session;

  useEffect(() => {
    if (!meta && sessionId) {
      // 没有 state(直接 URL 进入),提示回到详情页
    }
  }, [meta, sessionId]);

  if (!meta) {
    return (
      <div className="session-detail">
        <div className="empty">{t("detail.notFound")}</div>
        <button onClick={() => navigate("/")}>{t("detail.back")}</button>
      </div>
    );
  }

  return (
    <div className="session-detail">
      <header className="session-header">
        <button onClick={() => navigate(-1)} className="back-btn">
          <ArrowLeft size={16} /> {t("detail.back")}
        </button>
        <div className="session-header-info">
          <h1>{meta.title || meta.sessionId.slice(0, 8)}</h1>
          <div className="session-header-meta">
            <span>📊 {t("detail.trajectory")}</span>
          </div>
        </div>
      </header>

      <TrajectoryView sessionPath={meta.jsonlPath} />
    </div>
  );
}
