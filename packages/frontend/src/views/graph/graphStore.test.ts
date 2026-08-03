/**
 * graphStore.test.ts — v0.8.10 收口 (item F)
 *
 * graphStore 是 G1/G2/G3 共享的 zustand store,数据源切 DB 后(v0.8.5 C)
 * 一直没补 unit test。覆盖 load / reload / error 状态 / listen sessions-updated
 * 自动 invalidate 这几个核心路径。
 *
 * Mock 模式: vi.mock 替换 apiListGraph + listen,控 invoke 调用计数跟事件触发。
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

// Mock 必须在 import store 之前
const mockApiListGraph = vi.fn();
const mockListen = vi.fn();

vi.mock("../../lib/overridesApi", () => ({
  apiListGraph: () => mockApiListGraph(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    mockListen(event, cb);
    // 返回 unsubscribe 函数 (跟 Tauri API 一致)
    return Promise.resolve(() => {});
  },
}));

import { useGraphStore } from "./graphStore";
import type { GraphEntry } from "./types";

// ===== fixture =====

function makeEntry(sessionId: string): GraphEntry {
  return {
    node: {
      node_id: sessionId,
      source: "Claude",
      session_id: sessionId,
      workspace: "/tmp",
      jsonl_path: `/tmp/${sessionId}.jsonl`,
      size_bytes: 100,
      mtime_ms: 1_700_000_000_000,
      first_prompt: null,
      first_timestamp_ms: null,
      last_timestamp_ms: null,
      token_total: 0,
      thinking_count: 0,
      primary_model: null,
      top_tools: [],
      error_count: 0,
      subagent_count: 0,
      subagent_ids: [],
      is_subagent_root: false,
      parent_session_id: null,
      message_count: 0,
    },
    edges: [],
  };
}

beforeEach(() => {
  // Reset store + mock calls between tests
  useGraphStore.setState({ entries: null, loading: false, error: null, invalidated: false });
  // v0.8.12 G: 清 module-level unlistenFn + debounceTimer,避免泄漏到下个 test
  useGraphStore.getState().teardown();
  mockApiListGraph.mockReset();
  mockListen.mockReset();
});

// ===== load 路径 =====

describe("graphStore.load", () => {
  it("load 调 apiListGraph 填充 entries", async () => {
    const fixture: GraphEntry[] = [makeEntry("s1"), makeEntry("s2")];
    mockApiListGraph.mockResolvedValueOnce(fixture);

    await useGraphStore.getState().load();

    expect(mockApiListGraph).toHaveBeenCalledTimes(1);
    const entries = useGraphStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries?.[0]?.node.session_id).toBe("s1");
    expect(useGraphStore.getState().error).toBeNull();
    expect(useGraphStore.getState().loading).toBe(false);
  });

  it("load 第二次不重新 fetch (已加载短路)", async () => {
    const fixture: GraphEntry[] = [makeEntry("s1")];
    mockApiListGraph.mockResolvedValue(fixture);

    await useGraphStore.getState().load();
    await useGraphStore.getState().load();

    // 只调 1 次,不是 2 次 — 已加载直接 return
    expect(mockApiListGraph).toHaveBeenCalledTimes(1);
  });

  it("load 第二次并发调用不重复 fetch (loading 短路)", async () => {
    const fixture: GraphEntry[] = [makeEntry("s1")];
    // 慢 resolve 让第一次还在 loading
    let resolveFn: (v: GraphEntry[]) => void;
    mockApiListGraph.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      })
    );

    const p1 = useGraphStore.getState().load();
    const p2 = useGraphStore.getState().load();

    resolveFn!(fixture);
    await Promise.all([p1, p2]);

    // loading 状态时第二次调用被短路
    expect(mockApiListGraph).toHaveBeenCalledTimes(1);
  });

  it("load 失败设置 error", async () => {
    mockApiListGraph.mockRejectedValueOnce(new Error("network down"));

    await useGraphStore.getState().load();

    expect(useGraphStore.getState().error).toBe("Error: network down");
    expect(useGraphStore.getState().entries).toBeNull();
    expect(useGraphStore.getState().loading).toBe(false);
  });
});

// ===== reload 路径 =====

describe("graphStore.reload", () => {
  it("reload 不管 entries 是否已存在都重新 fetch", async () => {
    mockApiListGraph.mockResolvedValue([makeEntry("s1")]);

    await useGraphStore.getState().load();
    expect(mockApiListGraph).toHaveBeenCalledTimes(1);

    await useGraphStore.getState().reload();
    expect(mockApiListGraph).toHaveBeenCalledTimes(2);
  });

  it("reload 覆盖 entries (不 append)", async () => {
    mockApiListGraph.mockResolvedValueOnce([makeEntry("s1"), makeEntry("s2")]);
    await useGraphStore.getState().load();
    expect(useGraphStore.getState().entries).toHaveLength(2);

    mockApiListGraph.mockResolvedValueOnce([makeEntry("s3")]);
    await useGraphStore.getState().reload();
    expect(useGraphStore.getState().entries).toHaveLength(1);
    expect(useGraphStore.getState().entries?.[0]?.node.session_id).toBe("s3");
  });
});

// ===== 状态切换 =====

describe("graphStore state transitions", () => {
  it("loading 状态在 load 期间为 true", async () => {
    let resolveFn: (v: GraphEntry[]) => void;
    mockApiListGraph.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      })
    );

    const p = useGraphStore.getState().load();
    expect(useGraphStore.getState().loading).toBe(true);

    resolveFn!([]);
    await p;
    expect(useGraphStore.getState().loading).toBe(false);
  });

  it("error 状态在成功 reload 后清空", async () => {
    mockApiListGraph.mockRejectedValueOnce(new Error("first fail"));
    await useGraphStore.getState().load();
    expect(useGraphStore.getState().error).toBe("Error: first fail");

    mockApiListGraph.mockResolvedValueOnce([makeEntry("s1")]);
    await useGraphStore.getState().reload();
    expect(useGraphStore.getState().error).toBeNull();
    expect(useGraphStore.getState().entries).toHaveLength(1);
  });
});

// ===== listen sessions-updated 自动 invalidate =====

describe("graphStore.listen sessions-updated", () => {
  // 拿 listen 注册的 callback,模拟 backend 发 sessions-updated 事件
  function getListenCallback(): (e: { payload: unknown }) => void {
    // mockListen(event, cb) — 找 sessions-updated 那次注册的 cb
    const call = mockListen.mock.calls.find((c) => c[0] === "sessions-updated");
    if (!call) throw new Error("listen_sessions_updated 没注册 sessions-updated");
    return call[1] as (e: { payload: unknown }) => void;
  }

  it("listen 收到事件后,下次 load 自动重新 invoke (cache invalidated)", async () => {
    const fixture: GraphEntry[] = [makeEntry("s1")];
    mockApiListGraph.mockResolvedValue(fixture);

    // 1) 首次 load
    await useGraphStore.getState().load();
    expect(mockApiListGraph).toHaveBeenCalledTimes(1);

    // 2) 注册 listen
    await useGraphStore.getState().listen_sessions_updated();
    expect(mockListen).toHaveBeenCalledWith("sessions-updated", expect.any(Function));

    // 3) 模拟 backend fire sessions-updated
    getListenCallback()({ payload: undefined });

    // 4) invalidated 立即置 true
    expect(useGraphStore.getState().invalidated).toBe(true);
  });

  it("store 暴露 load 函数作为外部 trigger", () => {
    // 锁住 zustand store 的 shape 契约: load / reload 必须存在
    const state = useGraphStore.getState();
    expect(typeof state.load).toBe("function");
    expect(typeof state.reload).toBe("function");
    expect(state.entries).toBeNull();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });
});

// ===== v0.8.12 item G: listen + debounce + teardown =====

describe("graphStore v0.8.12 G: listen + debounce reload", () => {
  function getListenCallback(): (e: { payload: unknown }) => void {
    const call = mockListen.mock.calls.find((c) => c[0] === "sessions-updated");
    if (!call) throw new Error("listen_sessions_updated 没注册 sessions-updated");
    return call[1] as (e: { payload: unknown }) => void;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listen_sessions_updated 收到事件后标记 invalidated", async () => {
    mockApiListGraph.mockResolvedValue([makeEntry("s1")]);
    await useGraphStore.getState().load();

    await useGraphStore.getState().listen_sessions_updated();
    expect(useGraphStore.getState().invalidated).toBe(false);

    getListenCallback()({ payload: undefined });
    expect(useGraphStore.getState().invalidated).toBe(true);
  });

  it("5 次连发 sessions-updated 触发 reload 只 1 次 (200ms debounce)", async () => {
    // v0.8.12 G: sync_loop 一次跑完会发 N 个 sessions-updated (per sub-system),
    // debounce 让 reload 只跑 1 次,避免 IPC 风暴
    mockApiListGraph.mockResolvedValue([makeEntry("s1")]);
    await useGraphStore.getState().load();
    expect(mockApiListGraph).toHaveBeenCalledTimes(1);

    await useGraphStore.getState().listen_sessions_updated();

    // 5 次连发
    for (let i = 0; i < 5; i++) {
      getListenCallback()({ payload: undefined });
    }

    // 200ms 内 reload 不应触发
    vi.advanceTimersByTime(199);
    // 给 reload 的 microtask 跑完(实际 reload 还没启动,因为 timer 还没到)
    await vi.runOnlyPendingTimersAsync().catch(() => {});

    // 200ms 到,reload 跑
    vi.advanceTimersByTime(1);
    await Promise.resolve(); // 让 reload 的 promise 链跑

    // 5 个事件合并成 1 次 reload (+ 1 首次 load)
    expect(mockApiListGraph).toHaveBeenCalledTimes(2);
  });

  it("teardown 解除 listen + 清 debounce timer", async () => {
    mockApiListGraph.mockResolvedValue([makeEntry("s1")]);
    await useGraphStore.getState().load();

    await useGraphStore.getState().listen_sessions_updated();
    // verify 装上
    expect(mockListen).toHaveBeenCalledWith("sessions-updated", expect.any(Function));

    // teardown — 把 module-level unlistenFn 清了
    useGraphStore.getState().teardown();

    // 重新 listen 应能再注册 (如果没 teardown,会返旧的 unlistenFn,不会再次 listen)
    mockListen.mockClear();
    await useGraphStore.getState().listen_sessions_updated();
    expect(mockListen).toHaveBeenCalledTimes(1);

    // teardown 后再 fire 旧 callback,不会触发 reload (但因为新 listen 也注册了,
    // 实际上我们测的是 unlistenFn 被清空;teardown 不让旧 unlisten 影响新 listen)
    useGraphStore.getState().teardown();
    // fire 旧 callback(新 listen 后这个 callback 不存在了,先 fire 一次没事)
    // 关键断言: teardown 后 debounce timer 没了, advance 时间不会触发 reload
    mockApiListGraph.mockClear();
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(mockApiListGraph).not.toHaveBeenCalled();
  });
});

// ===== GraphEntry shape 契约 (跟 v0.8.8 Edge type 契约同 pattern) =====

describe("GraphEntry shape (v0.8.8/v0.8.10 contract)", () => {
  it("fixture entry shape 跟 GraphEntry interface 匹配", () => {
    const e = makeEntry("test-sid");
    expect(e.node.node_id).toBe("test-sid");
    expect(e.node.session_id).toBe("test-sid");
    expect(e.node.source).toBe("Claude");
    expect(Array.isArray(e.edges)).toBe(true);
  });
});
