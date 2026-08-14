import type { MemoryStore } from '../memory/store';
import type { VectorStore } from '../rag/store';
import type { PromptContext } from './prompt-builder';

/**
 * 将长期记忆存储中的 prompt 片段接入 PromptBuilder 管道。
 *
 * @param memoryStore 提供记忆 prompt section 的存储实例。
 * @returns
 */
export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
    return () => memoryStore.buildPromptSection();
}

/**
 * 根据向量库状态生成知识库提示，空库时不注入内容。
 *
 * @param vectorStore 提供文档数量和来源信息的向量存储。
 * @returns
 */
export function ragContext(vectorStore: VectorStore): (ctx: PromptContext) => string | null {
    return () => {
        const size = vectorStore.size();
        if (size === 0) return null;
        const sources = vectorStore.sources();
        return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
    };
}
