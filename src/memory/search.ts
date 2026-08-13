import type { MemoryEntry } from './store';

/**
 * BM25 检索命中的单条结果。
 */
export interface SearchHit {
    /** 命中的记忆条目。 */
    entry: MemoryEntry;

    /** BM25 相关性分数，越高表示越相关。 */
    score: number;
}

/**
 * 简单切分中英文查询文本，英文和数字按词聚合，中文按字切分。
 *
 * @param text 待分词的原始文本。
 * @returns 可用于 BM25 统计的 token 列表。
 */
function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();
    let buf = '';
    for (const ch of lower) {
        if (/[a-z0-9_]/.test(ch)) {
            buf += ch;
        } else if (/[一-龥]/.test(ch)) {
            if (buf) {
                tokens.push(buf);
                buf = '';
            }
            tokens.push(ch);
        } else {
            if (buf) {
                tokens.push(buf);
                buf = '';
            }
        }
    }
    if (buf) tokens.push(buf);
    return tokens;
}

const K1 = 1.5;
const B = 0.75;

/**
 * 使用 BM25 对记忆条目排序，名称和摘要会被重复拼接以提升权重。
 *
 * @param entries 候选记忆条目列表。
 * @param query 检索关键词或自然语言查询。
 * @param topK 返回结果数量上限。
 * @returns 按相关性降序排列的命中结果。
 */
export function bm25Search(entries: MemoryEntry[], query: string, topK = 5): SearchHit[] {
    if (entries.length === 0 || !query.trim()) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // 把每条记忆拼成单一文档——name/description 适当加权（重复几遍）
    const docs = entries.map((e) => {
        const weighted = `${e.name} ${e.name} ${e.name} ${e.description} ${e.description} ${e.content}`;
        return tokenize(weighted);
    });

    const N = docs.length;
    const avgdl = docs.reduce((s, d) => s + d.length, 0) / N;

    // df：包含每个词的文档数
    const df = new Map<string, number>();
    for (const doc of docs) {
        const seen = new Set(doc);
        for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }

    const hits: SearchHit[] = entries.map((entry, i) => {
        const doc = docs[i];
        const dl = doc.length;
        let score = 0;
        for (const qt of queryTokens) {
            const dfQ = df.get(qt) || 0;
            if (dfQ === 0) continue;
            const tf = doc.filter((t) => t === qt).length;
            if (tf === 0) continue;
            const idf = Math.log((N - dfQ + 0.5) / (dfQ + 0.5) + 1);
            const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl));
            score += idf * norm;
        }
        return { entry, score };
    });

    return hits
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}
