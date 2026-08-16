import fs from 'node:fs';
import type { ToolDefinition } from './registry';
import { chunkDocument } from '../rag/chunker';
import { embed, type EmbeddingFn } from '../rag/embedder';
import { SqliteVectorStore } from '../rag/sqlite-store.js';

/**
 * 创建文档导入与知识库搜索工具。
 *
 * @param vectorStore 持久化知识库的 SQLite 存储。
 * @param embedFn 用于生成文档和查询向量的 embedding 函数。
 * @returns 文档导入与知识库搜索工具定义。
 */
export function createRagTools(
    vectorStore: SqliteVectorStore,
    embedFn: EmbeddingFn,
): ToolDefinition[] {
    const ragIngestTool: ToolDefinition = {
        name: 'rag_ingest',
        description: '将文档导入知识库。path 为文件路径，内容会被分块、向量化后存储。',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '文档路径' } },
            required: ['path'],
            additionalProperties: false,
        },
        isConcurrencySafe: false,
        isReadOnly: false,
        execute: async ({ path }: { path: string }) => {
            try {
                const text = fs.readFileSync(path, 'utf-8');
                const chunks = chunkDocument(path, text);
                const embeddings = await embed(
                    embedFn,
                    chunks.map((c) => c.text),
                );
                vectorStore.addBatch(
                    chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })),
                );
                return `已导入 ${chunks.length} 个文档片段（来源: ${path}）。知识库共 ${vectorStore.size()} 个片段。`;
            } catch (e: any) {
                return `导入失败: ${e.message}`;
            }
        },
    };

    const ragSearchTool: ToolDefinition = {
        name: 'rag_search',
        description: '从知识库中搜索相关信息。返回最相关的文档片段。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索查询' },
                top_k: { type: 'number', description: '返回结果数量（默认 5）' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
            try {
                if (vectorStore.size() === 0) return '知识库为空，请先使用 rag_ingest 导入文档。';

                const results = await vectorStore.hybridSearch(embedFn, query, top_k || 5);

                if (results.length === 0) return `没有找到与 "${query}" 相关的内容。`;
                return results
                    .map(
                        (r, i) =>
                            `[${i + 1}] 来源: ${r.chunk.source} | 综合分: ${r.score.toFixed(3)} (向量: ${r.vectorScore.toFixed(2)}, 关键词: ${r.keywordScore.toFixed(2)})\n${r.chunk.text.slice(0, 500)}`,
                    )
                    .join('\n\n---\n\n');
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                return `搜索失败: ${message}`;
            }
        },
    };

    return [ragIngestTool, ragSearchTool];
}
