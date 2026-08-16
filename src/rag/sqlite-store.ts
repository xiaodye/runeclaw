import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Chunk } from './chunker.js';
import type { StoredChunk } from './store.js';
import { embed, EmbeddingFn } from './embedder.js';
import { mmrSelect, type SearchResult } from './search.js';

/** 使用 SQLite、sqlite-vec 与 FTS5 持久化知识片段并提供混合检索。 */
export class SqliteVectorStore {
    /** 承载片段元数据、向量索引与全文索引的数据库连接。 */
    private db: Database.Database;

    /**
     * 打开知识库数据库并初始化检索所需的数据表与扩展。
     *
     * @param dbPath SQLite 数据库文件路径；默认写入当前工作目录。
     */
    constructor(dbPath: string = 'knowledge.db') {
        this.db = new Database(dbPath);
        sqliteVec.load(this.db); // 加载向量搜索扩展
        this.createTables();
    }

    /** 创建片段表、向量索引和全文索引，已存在时保持原结构。 */
    private createTables() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[128]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, source UNINDEXED
      );
    `);
    }

    /**
     * 将单个知识片段同步写入元数据表、向量索引和全文索引。
     *
     * @param chunk 待持久化的知识片段。
     * @param embedding 与片段正文对应的向量表示。
     */
    add(chunk: Chunk, embedding: number[]): void {
        const now = Date.now();
        // 三表联动写入
        this.db
            .prepare(
                `INSERT OR REPLACE INTO chunks
      (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(chunk.id, chunk.text, chunk.source, chunk.index, JSON.stringify(embedding), now);

        this.db
            .prepare(
                `INSERT OR REPLACE INTO chunks_vec (id, embedding)
      VALUES (?, ?)`,
            )
            .run(chunk.id, Buffer.from(new Float32Array(embedding).buffer));

        this.db
            .prepare(
                `INSERT OR REPLACE INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`,
            )
            .run(chunk.id, chunk.text, chunk.source);
    }

    /**
     * 在同一事务中批量写入知识片段与对应向量。
     *
     * @param items 待写入的片段与向量配对列表。
     */
    addBatch(
        items: Array<{
            /** 待持久化的知识片段。 */
            chunk: Chunk;
            /** 与片段正文对应的向量表示。 */
            embedding: number[];
        }>,
    ): void {
        const tx = this.db.transaction(() => {
            for (const { chunk, embedding } of items) this.add(chunk, embedding);
        });
        tx(); // 事务批量写入，比逐条快很多
    }

    /**
     * 使用 sqlite-vec 的 KNN 约束检索最相近的 chunk。
     *
     * @param queryEmbedding 查询文本对应的向量。
     * @param topK 返回结果数量上限。
     * @returns 按向量距离升序排列的 chunk 及相似度。
     */
    vectorSearch(
        queryEmbedding: number[],
        topK: number,
    ): Array<{
        /** 命中的知识片段及其向量信息。 */
        chunk: StoredChunk;
        /** 由向量距离转换得到的相似度分数。 */
        score: number;
    }> {
        const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
        const rows = this.db
            .prepare(
                `
      SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `,
            )
            .all(buf, topK) as any[];

        return rows.map((r) => ({
            chunk: {
                id: r.id,
                text: r.text,
                source: r.source,
                index: r.chunk_index,
                tokenEstimate: Math.ceil(r.text.length / 4),
                embedding: JSON.parse(r.embedding),
                addedAt: 0,
            },
            score: 1 - r.distance, // cosine distance → similarity
        }));
    }

    /**
     * 使用经过清洗的 FTS5 查询执行关键词检索，避免用户输入破坏查询语法。
     *
     * @param query 用户输入的自然语言查询。
     * @param topK 返回结果数量上限。
     * @returns 按关键词相关性排序的 chunk 及分数。
     */
    keywordSearch(
        query: string,
        topK: number,
    ): Array<{
        /** 命中的知识片段及其向量信息。 */
        chunk: StoredChunk;
        /** 由 FTS5 BM25 rank 转换得到的相关性分数。 */
        score: number;
    }> {
        const ftsQuery = sanitizeFtsQuery(query);
        if (!ftsQuery) return [];

        const rows = this.db
            .prepare(
                `
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
            )
            .all(ftsQuery, topK) as any[];

        return rows.map((r) => ({
            chunk: {
                id: r.id,
                text: r.text,
                source: r.source,
                index: r.chunk_index,
                tokenEstimate: Math.ceil(r.text.length / 4),
                embedding: JSON.parse(r.embedding),
                addedAt: 0,
            },
            score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
        }));
    }

    /**
     * 统计当前持久化的知识片段数量。
     *
     * @returns 元数据表中的片段总数。
     */
    size(): number {
        return (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
    }

    /** 清空元数据表、向量索引与全文索引中的全部知识片段。 */
    clear(): void {
        this.db.exec('DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;');
    }

    /**
     * 汇总当前知识库中的去重来源标识。
     *
     * @returns 数据库中出现过的 source 列表。
     */
    sources(): string[] {
        return (this.db.prepare('SELECT DISTINCT source FROM chunks').all() as any[]).map(
            (r) => r.source,
        );
    }

    /**
     * 在 SQLite 层合并向量 KNN 与 FTS5 关键词检索结果。
     *
     * @param embedFn 用于生成查询向量的 embedding 函数。
     * @param query 用户输入的自然语言查询。
     * @param topK 返回结果数量上限。
     * @returns 按综合分数和 MMR 去重后的搜索结果。
     */
    async hybridSearch(
        embedFn: EmbeddingFn,
        query: string,
        topK: number = 5,
    ): Promise<SearchResult[]> {
        const candidateCount = Math.min(topK * 4, this.size());
        if (candidateCount === 0) return [];

        const [queryVec] = await embed(embedFn, [query]);

        // 路径 1: sqlite-vec 向量搜索
        const vectorResults = this.vectorSearch(queryVec, candidateCount);

        // 路径 2: FTS5 关键词搜索
        const keywordResults = this.keywordSearch(query, candidateCount);

        // 归一化 + 加权合并
        const vecScores = normalizeMinMax(vectorResults.map((r) => r.score));
        const kwScores = normalizeMinMax(keywordResults.map((r) => r.score));

        const candidates = new Map<string, SearchResult>();
        for (let i = 0; i < vectorResults.length; i++) {
            const id = vectorResults[i].chunk.id;
            candidates.set(id, {
                chunk: vectorResults[i].chunk,
                score: vecScores[i] * 0.7,
                vectorScore: vecScores[i],
                keywordScore: 0,
            });
        }
        for (let i = 0; i < keywordResults.length; i++) {
            const id = keywordResults[i].chunk.id;
            const existing = candidates.get(id);
            if (existing) {
                existing.keywordScore = kwScores[i];
                existing.score += kwScores[i] * 0.3;
            } else {
                candidates.set(id, {
                    chunk: keywordResults[i].chunk,
                    score: kwScores[i] * 0.3,
                    vectorScore: 0,
                    keywordScore: kwScores[i],
                });
            }
        }

        const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

        // MMR deduplication
        return mmrSelect(sorted, topK);
    }
}

/**
 * 将自然语言查询转换为仅包含字面词的安全 FTS5 表达式。
 *
 * @param query 原始自然语言查询。
 * @returns 转义后的 FTS5 查询；没有有效词时返回空字符串。
 */
function sanitizeFtsQuery(query: string): string {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

/**
 * 使用 min-max 将一组候选分数缩放到零至一的区间。
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
