import { cosineSimilarity } from './embedder.js';
import type { StoredChunk } from './store.js';
import type { VectorStore } from './store.js';
import type { EmbeddingFn } from './embedder.js';
import { embed } from './embedder.js';

/** 表示混合检索返回的知识片段及各路径评分。 */
export interface SearchResult {
    /** 命中的知识片段及其向量信息。 */
    chunk: StoredChunk;

    /** 向量与关键词评分加权后的综合相关性分数。 */
    score: number;

    /** 归一化后的向量检索相关性分数。 */
    vectorScore: number;

    /** 归一化后的关键词检索相关性分数。 */
    keywordScore: number;
}

const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const CANDIDATE_MULTIPLIER = 4;
const MMR_LAMBDA = 0.7;

/**
 * 合并向量相似度与 BM25-like 关键词评分，并通过 MMR 降低结果重复度。
 *
 * @param store 提供完整候选片段的内存向量存储。
 * @param embedFn 用于生成查询向量的 embedding 函数。
 * @param query 用户输入的自然语言查询。
 * @param topK 返回结果数量上限。
 * @returns 按综合相关性与多样性筛选后的搜索结果。
 */
export async function hybridSearch(
    store: VectorStore,
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
): Promise<SearchResult[]> {
    const all = store.getAll();
    if (all.length === 0) return [];

    const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

    // Path 1: Vector search
    const [queryVec] = await embed(embedFn, [query]);
    const vectorResults = all
        .map((chunk) => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateCount);

    // Path 2: Keyword search (BM25-like TF-IDF scoring)
    const queryTerms = tokenize(query);
    const docCount = all.length;
    const keywordResults = all
        .map((chunk) => ({ chunk, score: bm25Score(queryTerms, chunk.text, docCount, all) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateCount);

    // Normalize scores to [0, 1]
    const vecNorm = normalizeMinMax(vectorResults.map((r) => r.score));
    const kwNorm = normalizeViaSigmoid(keywordResults.map((r) => r.score));

    // Merge into unified candidate set
    const candidates = new Map<string, SearchResult>();

    for (let i = 0; i < vectorResults.length; i++) {
        const id = vectorResults[i].chunk.id;
        candidates.set(id, {
            chunk: vectorResults[i].chunk,
            score: vecNorm[i] * VECTOR_WEIGHT,
            vectorScore: vecNorm[i],
            keywordScore: 0,
        });
    }

    for (let i = 0; i < keywordResults.length; i++) {
        const id = keywordResults[i].chunk.id;
        const existing = candidates.get(id);
        if (existing) {
            existing.keywordScore = kwNorm[i];
            existing.score += kwNorm[i] * KEYWORD_WEIGHT;
        } else {
            candidates.set(id, {
                chunk: keywordResults[i].chunk,
                score: kwNorm[i] * KEYWORD_WEIGHT,
                vectorScore: 0,
                keywordScore: kwNorm[i],
            });
        }
    }

    // Sort by combined score
    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

    // MMR deduplication
    return mmrSelect(sorted, topK);
}

// ── BM25 scoring ──────────────────────────

/**
 * 将中英文文本归一化为用于关键词统计的有效词项。
 *
 * @param text 待分词的查询或文档文本。
 * @returns 统一为小写且长度大于一的词项列表。
 */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\w一-鿿]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);
}

/**
 * 计算查询词项与单个文档之间的 BM25-like 相关性分数。
 *
 * @param queryTerms 已归一化的查询词项。
 * @param docText 待评分文档的正文。
 * @param N 候选文档总数，用于计算逆文档频率。
 * @param allDocs 完整候选文档集合，用于统计平均长度与词项文档频率。
 * @returns 文档的关键词相关性分数。
 */
function bm25Score(
    queryTerms: string[],
    docText: string,
    N: number,
    allDocs: StoredChunk[],
): number {
    const k1 = 1.2;
    const b = 0.75;
    const docTokens = tokenize(docText);
    const avgDl = allDocs.reduce((s, d) => s + tokenize(d.text).length, 0) / (N || 1);
    const dl = docTokens.length;
    let score = 0;

    for (const term of queryTerms) {
        const tf = docTokens.filter((t) => t === term).length;
        const df = allDocs.filter((d) => tokenize(d.text).includes(term)).length;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)));
        score += idf * tfNorm;
    }

    return score;
}

// ── Normalization ──────────────────────────

/**
 * 使用 min-max 将一组分数缩放到零至一的区间。
 *
 * @param scores 待归一化的原始分数。
 * @returns 与输入顺序一致的归一化分数。
 */
function normalizeMinMax(scores: number[]): number[] {
    if (scores.length === 0) return [];
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    return scores.map((s) => (s - min) / range);
}

/**
 * 使用 sigmoid 将非负关键词分数平滑映射到零至一的区间。
 *
 * @param scores 待归一化的关键词分数。
 * @returns 与输入顺序一致的平滑分数。
 */
function normalizeViaSigmoid(scores: number[]): number[] {
    return scores.map((s) => 1 / (1 + Math.exp(-s)));
}

// ── MMR deduplication ──────────────────────

/**
 * 使用最大边际相关性在相关度与文本多样性之间筛选结果。
 *
 * @param results 已按综合相关性降序排列的候选结果。
 * @param topK 最多保留的结果数量。
 * @returns 保持首个高相关结果并降低内容重复度的结果列表。
 */
export function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
    if (results.length <= topK) return results;

    const selected: SearchResult[] = [results[0]];
    const remaining = results.slice(1);

    while (selected.length < topK && remaining.length > 0) {
        let bestIdx = 0;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].score;
            const maxSim = Math.max(
                ...selected.map((s) => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)),
            );
            const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        selected.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }

    return selected;
}

/**
 * 根据分词集合计算两段文本的 Jaccard 相似度。
 *
 * @param a 第一段待比较文本。
 * @param b 第二段待比较文本。
 * @returns 零至一之间的词项集合相似度。
 */
function jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));
    const intersection = [...setA].filter((t) => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}
