import type { ToolRegistry, ToolDefinition } from './registry.js';

/**
 * 创建按服务名、工具名或关键词发现工具的入口。
 * @param registry 当前会话的工具注册表。
 * @returns
 */
export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
    return {
        name: 'tool_search',
        description:
            '按服务名、工具名或关键词搜索工具并获取完整定义；例如 context7、resolve-library-id，支持空格或逗号分隔。发现后可在下一步调用返回的工具。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '服务名、完整或部分工具名、用途关键词' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async ({ query }: { query: string }) => {
            const results = registry.searchTools(query);
            if (results.length === 0) return `没有找到工具: ${query}`;
            return results.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            }));
        },
    };
}
