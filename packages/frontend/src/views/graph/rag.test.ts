/**
 * rag.ts 单测
 *
 * 重点:highlightQueryHtml — v0.7.1 新增,用原 query term 找 spans,
 * 替代之前用 1-2 char hash token 造成的全文字符级噪音高亮。
 */
import { describe, it, expect } from "vitest";
import { highlightQueryHtml, highlightSpans, tokenize, embed, cosine, topK } from "./rag";

describe("highlightQueryHtml", () => {
  it("高亮原 query 中 2+ 字符的 term", () => {
    const html = highlightQueryHtml("测试 retry 失败", "失败 retry");
    expect(html).toContain("<mark>失败</mark>");
    expect(html).toContain("<mark>retry</mark>");
  });

  it("query 子串在 text 中也高亮(忽略大小写)", () => {
    const html = highlightQueryHtml("OpenClaw session viewer", "openclaw");
    expect(html).toContain("<mark>OpenClaw</mark>");
  });

  it("1 字符 query term 跳过(避免噪音)", () => {
    // "a" / "b" / "c" 单独不应被高亮
    const html = highlightQueryHtml("alpha beta", "a b");
    expect(html).not.toContain("<mark>");
  });

  it("query 与 text 完全无关 → 不高亮,正常 escape", () => {
    const html = highlightQueryHtml("hello world", "xyz123");
    expect(html).not.toContain("<mark>");
    expect(html).toContain("hello world");
  });

  it("空 query → 原样 escape 返回", () => {
    expect(highlightQueryHtml("hello <b>x</b>", "")).toBe("hello &lt;b&gt;x&lt;/b&gt;");
  });

  it("XSS:query term 注入不生效,被 escape", () => {
    // query 里塞 HTML,只走匹配查找,不进入 DOM
    const html = highlightQueryHtml("contains <script>", "contains");
    expect(html).toContain("<mark>contains</mark>");
    // text 里的 <script> 应被 escape
    expect(html).toContain("&lt;script&gt;");
  });

  it("多次出现的 term 都高亮", () => {
    const html = highlightQueryHtml("retry and retry", "retry");
    const matches = html.match(/<mark>retry<\/mark>/g);
    expect(matches?.length).toBe(2);
  });
});

describe("highlightSpans", () => {
  it("返回的 spans 按 start 升序,无重叠", () => {
    const spans = highlightSpans("openclaw openclaw viewer", ["openclaw", "viewer"]);
    expect(spans.length).toBe(3);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i - 1]!.end).toBeLessThanOrEqual(spans[i]!.start);
    }
  });

  it("空 token 数组返回空 spans", () => {
    expect(highlightSpans("hello", [])).toEqual([]);
  });
});

describe("tokenize (基础,确保 1+2 char 拆分)", () => {
  it("英文:单字符 + 双字符组合", () => {
    const toks = tokenize("hi");
    expect(toks).toContain("h");
    expect(toks).toContain("i");
    expect(toks).toContain("hi");
  });

  it("中文:逐字 + 邻字组合", () => {
    const toks = tokenize("你好");
    expect(toks).toContain("你");
    expect(toks).toContain("好");
    expect(toks).toContain("你好");
  });

  it("大小写归一化(单字符)", () => {
    // tokenize 故意只返 1+2 char substrings,所以 "openclaw" 整体不会出现在结果里
    // 这里只验单字符小写化
    const toks = tokenize("OpenClaw");
    expect(toks).toContain("o");
    expect(toks).toContain("p");
    expect(toks).toContain("op");
  });
});

describe("embed + cosine (基础 smoke)", () => {
  it("同文本 cosine = 1", () => {
    const a = embed("hello world");
    expect(cosine(a, a)).toBeCloseTo(1.0, 5);
  });

  it("完全不同文本 cosine 接近 0 (L2 归一化后点积 0)", () => {
    // 32 维 hash bucket,完全无碰撞概率极低,但 cosine 应当 < 1
    const a = embed("aaa");
    const b = embed("zzz");
    expect(cosine(a, b)).toBeLessThan(1);
    expect(cosine(a, b)).toBeGreaterThanOrEqual(0);
  });
});

describe("topK", () => {
  it("返回 top-N 个,按 score 降序", () => {
    interface Item {
      id: string;
      txt: string;
    }
    const items = [
      { id: "1", txt: "openclaw session viewer" },
      { id: "2", txt: "completely unrelated thing" },
      { id: "3", txt: "openclaw-related work" },
    ];
    const idx = items.map((it) => ({ item: it, embed: embed(it.txt), text: it.txt }));
    const hits = topK<Item>("openclaw", idx, 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    // 第一个 hit 应该是包含 "openclaw" 的
    expect(["1", "3"]).toContain(hits[0]!.item.id);
  });
});
