/**
 * 实时 PID 轮询 hook
 */

import { useEffect, useState } from "react";
import { apiListLivePids } from "../lib/api";

interface LivePid {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  startedAt: number;
  version?: string;
  waitingFor?: string;
}

export function useLivePids(pollMs = 5000) {
  const [livePids, setLivePids] = useState<LivePid[]>([]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const list = await apiListLivePids();
        if (!stopped) setLivePids(list);
      } catch (e) {
        console.warn("list_live_pids 失败:", e);
      }
    };
    void tick();
    const timer = setInterval(tick, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return { livePids };
}
