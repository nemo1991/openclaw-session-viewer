/**
 * transcriptStore.test.ts — v0.8.14 item F
 *
 * transcriptStore.start 在 v0.8.14 之前是:
 *   1. reset
 *   2. await apiCountEntries(path)   ← 阻塞 await
 *   3. await listenTranscriptBatches(...)  ← listener 注册
 *   4. await invoke("stream_transcript", { path })  ← backend 开始发事件
 *
 * 第 2 步在 listen 和 invoke 之间插了一个 await — 慢机器上
 * backend 进入 stream_transcript 命令后,可能在 listener 完全
 * 注册完毕前就开始 emit "transcript-batch" 事件 → 前几批丢失。
 *
 * v0.8.14 修复:把 count_entries 移到 invoke 之后,listen → invoke 之间
 * 不插任何 await。本测试锁住这个顺序契约。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// 必须在 import store 之前 mock
const mockApiCount = vi.fn();
const mockListenTranscriptBatches = vi.fn();
const mockInvoke = vi.fn();

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    apiCountEntries: (...args: unknown[]) => mockApiCount(...(args as [string])),
    listenTranscriptBatches: (...args: unknown[]): Promise<Array<() => void>> =>
      mockListenTranscriptBatches(...(args as [unknown, unknown])) as Promise<Array<() => void>>,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useTranscriptStore } from "./transcriptStore";

beforeEach(() => {
  vi.clearAllMocks();
  useTranscriptStore.setState({
    path: null,
    entries: [],
    loading: false,
    totalCount: 0,
    loadedCount: 0,
    error: null,
    jumpTarget: null,
    lastJumpedId: null,
    lastJumpedAt: 0,
  });

  // 默认 stub: listen 返 [noop, noop]; invoke / count 返 Promise
  mockListenTranscriptBatches.mockImplementation(() => Promise.resolve([() => {}, () => {}]));
  mockInvoke.mockImplementation(() => Promise.resolve(undefined));
  mockApiCount.mockImplementation(() => Promise.resolve(0));
});

describe("transcriptStore.start — v0.8.14 item F listener ordering", () => {
  it("listenTranscriptBatches 必须在 invoke(stream_transcript) 之前 resolve", async () => {
    const events: string[] = [];
    mockListenTranscriptBatches.mockImplementationOnce(() => {
      events.push("listen-resolved");
      return Promise.resolve([() => {}, () => {}]);
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "stream_transcript") events.push("invoke-stream-transcript");
      return Promise.resolve(undefined);
    });
    mockApiCount.mockImplementationOnce(() => {
      events.push("count-entries-called");
      return Promise.resolve(100);
    });

    await useTranscriptStore.getState().start("/path/to/file.jsonl");

    const listenIdx = events.indexOf("listen-resolved");
    const invokeIdx = events.indexOf("invoke-stream-transcript");
    expect(listenIdx).toBeGreaterThanOrEqual(0);
    expect(invokeIdx).toBeGreaterThan(listenIdx);
  });

  it("count_entries 必须在 invoke 之后调用(只是 UI hint,不能在关键路径上)", async () => {
    const events: string[] = [];
    mockListenTranscriptBatches.mockResolvedValue([() => {}, () => {}]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "stream_transcript") events.push("invoke-stream-transcript");
      return Promise.resolve(undefined);
    });
    mockApiCount.mockImplementation(() => {
      events.push("count-entries-called");
      return Promise.resolve(100);
    });

    await useTranscriptStore.getState().start("/path/to/file.jsonl");

    const invokeIdx = events.indexOf("invoke-stream-transcript");
    const countIdx = events.indexOf("count-entries-called");
    expect(invokeIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeGreaterThan(invokeIdx);
  });

  it("start 后 path 立即被设上 (loading=true 状态正确)", async () => {
    mockListenTranscriptBatches.mockImplementationOnce(
      () => new Promise(() => {}) // 不 resolve,模拟 listen 耗时
    );

    const p = useTranscriptStore.getState().start("/path/to/file.jsonl");
    // 同步检查:reset + set loading 后 path 已经设上
    expect(useTranscriptStore.getState().path).toBe("/path/to/file.jsonl");
    expect(useTranscriptStore.getState().loading).toBe(true);

    // cleanup — 让 promise 解决
    mockListenTranscriptBatches.mockImplementation(() => Promise.resolve([() => {}, () => {}]));
    // 重新调一次让它完成
    void p;
  });

  it("same path 二次 start 立即返回 (no-op)", async () => {
    useTranscriptStore.setState({ path: "/already-loaded.jsonl" });
    const callsBefore = mockInvoke.mock.calls.length;
    await useTranscriptStore.getState().start("/already-loaded.jsonl");
    // same path → 不发 invoke
    const streamCalls = mockInvoke.mock.calls.filter((c) => c[0] === "stream_transcript").length;
    expect(streamCalls).toBe(0);
    expect(mockInvoke.mock.calls.length).toBe(callsBefore);
  });
});

// ===== v0.8.14 item D: stream_batches 失败时 done 事件带 error 信息 =====
describe("transcriptStore.start — v0.8.14 item D done 事件 error 透传", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTranscriptStore.setState({
      path: null,
      entries: [],
      loading: false,
      totalCount: 0,
      loadedCount: 0,
      error: null,
      jumpTarget: null,
      lastJumpedId: null,
      lastJumpedAt: 0,
    });
  });

  it("done 事件 error=null → loading=false,error 保持 null", async () => {
    let capturedOnDone: ((errMsg: string | null) => void) | null = null;
    mockListenTranscriptBatches.mockImplementationOnce((_onBatch: unknown, onDone: unknown) => {
      capturedOnDone = onDone as (errMsg: string | null) => void;
      return Promise.resolve([() => {}, () => {}]);
    });
    mockInvoke.mockResolvedValue(undefined);
    mockApiCount.mockResolvedValue(0);

    await useTranscriptStore.getState().start("/path/to/file.jsonl");

    // 触发 done 事件
    (capturedOnDone as ((m: string | null) => void) | null)?.(null);

    expect(useTranscriptStore.getState().loading).toBe(false);
    expect(useTranscriptStore.getState().error).toBeNull();
  });

  it("done 事件 error='I/O 错误' → loading=false,error=错误消息", async () => {
    let capturedOnDone: ((errMsg: string | null) => void) | null = null;
    mockListenTranscriptBatches.mockImplementationOnce((_onBatch: unknown, onDone: unknown) => {
      capturedOnDone = onDone as (errMsg: string | null) => void;
      return Promise.resolve([() => {}, () => {}]);
    });
    mockInvoke.mockResolvedValue(undefined);
    mockApiCount.mockResolvedValue(0);

    await useTranscriptStore.getState().start("/path/to/file.jsonl");

    // 模拟后端 stream_batches 失败 → done 事件带 error 信息
    (capturedOnDone as ((m: string | null) => void) | null)?.("I/O 错误: 文件被截断");

    expect(useTranscriptStore.getState().loading).toBe(false);
    expect(useTranscriptStore.getState().error).toBe("I/O 错误: 文件被截断");
  });
});
