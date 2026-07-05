/**
 * RAG lite — M1 PoC (hash embedding + cosine topK)
 *
 * 不用真 embedding 模型 (OpenAI / fastembed) — 改用 hashing trick
 * 32-dim word bag + IDF-weighting,在 35 sessions 规模下表现 OK。
 *
 * 设计:
 * - embed(text) -> Float32Array(32)  (deterministic)
 * - cosine(a, b)  → -1..1
 * - topK(query, items, k)          → 分数最高的 k 个
 * - indexCorpus(items, getTextFn)   → {embeds, texts, items} ready to query
 *
 * 中文友好: 不分词,把 1-2 字 substring 当 token (32-dim 足够抓局部)
 */

const DIM = 32;

/** 单 token → 一个 dim index (deterministic hash) */
function tokenDim(token: string): number {
  let h = 5381;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) + h + token.charCodeAt(i)) >>> 0;
  }
  return h % DIM;
}

/** 简单 tokenizer: 拆 char + 2-char substrings (中文友好) + 大写转小写 */
export function tokenize(text: string): string[] {
  const norm = text.toLowerCase().normalize("NFKC");
  const out: string[] = [];
  // 单字符
  for (const ch of norm) {
    if (/\s/.test(ch)) continue;
    out.push(ch);
  }
  // 2-char substring(相邻 2 字)
  for (let i = 0; i < norm.length - 1; i++) {
    const a = norm[i],
      b = norm[i + 1];
    if (/\s/.test(a) || /\s/.test(b)) continue;
    out.push(a + b);
  }
  return out;
}

/** hash embedding: 32 维 bag + sign-coded (1/-1) — 一阶 HSH trick */
export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const toks = tokenize(text);
  // frequency → dim bucket, summed + sign
  const counts = new Map<number, number>();
  for (const t of toks) {
    const d = tokenDim(t);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  for (const [d, c] of counts) {
    // sign trick: token 字符数奇偶决定正负号 (deterministic + 区分多义)
    v[d] = (c % 2 === 0 ? 1 : -1) * Math.sqrt(c);
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) {
    dot += a[i] * b[i];
  }
  return dot; // both L2-normalized, so dot == cosine
}

/** IndexItem 是任意 record + 检索 key text */
export interface IndexedItem<T> {
  item: T;
  embed: Float32Array;
  text: string;
}

/** 索引一个 corpus, 返回 IndexedItem[] */
export function indexCorpus<T>(items: T[], getText: (t: T) => string): IndexedItem<T>[] {
  return items.map((it) => {
    const text = getText(it);
    return {
      item: it,
      embed: embed(text),
      text,
    };
  });
}

export interface RetrievalHit<T> {
  item: T;
  score: number;
  text: string;
  /** 命中的 token 子串 (前 30) */
  matched_tokens: string[];
}

/** query,topK from indexCorpus */
export function topK<T>(query: string, index: IndexedItem<T>[], k: number): RetrievalHit<T>[] {
  const qe = embed(query);
  const hits: RetrievalHit<T>[] = index.map((ix) => {
    const score = cosine(qe, ix.embed);
    // 找出 query 命中 text 的 token (粗匹配 — 跟 embedding 共享同一 hash 函数)
    const qToks = tokenize(query);
    const matched = qToks.filter((t) => ix.text.includes(t)).slice(0, 30);
    return {
      item: ix.item,
      score,
      text: ix.text,
      matched_tokens: matched,
    };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

/** 高亮 query 中 matched tokens 在 text 里的位置,返 [{ start, end }] */
export function highlightSpans(
  text: string,
  tokens: string[]
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    let from = 0;
    while (true) {
      const idx = text.indexOf(tok, from);
      if (idx === -1) break;
      spans.push({ start: idx, end: idx + tok.length });
      from = idx + tok.length;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/** 给 text 加 <mark> 标签围绕 matched spans */
export function highlightHtml(text: string, tokens: string[]): string {
  const spans = highlightSpans(text, tokens);
  if (spans.length === 0) return escapeHtml(text);
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start > cursor) out += escapeHtml(text.slice(cursor, sp.start));
    out += `<mark>${escapeHtml(text.slice(sp.start, sp.end))}</mark>`;
    cursor = sp.end;
  }
  if (cursor < text.length) out += escapeHtml(text.slice(cursor));
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
