import type { PluginDefinition, PluginApi } from './types';

/**
 * 提供 Supabase 查询、插入和表列表工具的示例插件。
 */
export const supabasePlugin: PluginDefinition = {
    name: 'supabase',
    version: '1.0.0',
    description: '提供 Supabase 数据库操作能力（query / insert / list_tables）',
    config: {
        supabaseUrl: '${SUPABASE_URL}',
        supabaseKey: '${SUPABASE_KEY}',
    },

    /**
     * 激活插件并根据配置注册 Supabase 工具，缺少配置时进入 Mock 模式。
     *
     * @param api 插件运行时提供的注册、配置和日志接口。
     */
    activate(api: PluginApi) {
        const config = api.getConfig();
        const url = config.supabaseUrl as string;
        const key = config.supabaseKey as string;

        if (!url || !key) {
            api.log('未配置 SUPABASE_URL / SUPABASE_KEY，使用 Mock 模式');
        }

        api.registerTools([
            {
                name: 'list_tables',
                description: '列出数据库中所有表',
                parameters: { type: 'object', properties: {}, required: [] },
                isConcurrencySafe: true,
                isReadOnly: true,
                /**
                 * 列出可访问的数据表；Mock 模式返回示例表名。
                 *
                 * @returns
                 */
                execute: async () => {
                    if (!url) {
                        return JSON.stringify({
                            tables: ['users', 'posts', 'comments', 'sessions'],
                            note: 'Mock 模式 — 配置 SUPABASE_URL 和 SUPABASE_KEY 连接真实数据库',
                        });
                    }
                    return `连接 ${url} 查询表列表...（真实实现会调用 Supabase API）`;
                },
            },
            {
                name: 'query',
                description: '查询指定表的数据，支持 select / where / limit',
                parameters: {
                    type: 'object',
                    properties: {
                        table: { type: 'string', description: '表名' },
                        select: { type: 'string', description: '查询字段，默认 *' },
                        where: { type: 'string', description: '过滤条件，如 status=active' },
                        limit: { type: 'number', description: '返回条数限制，默认 10' },
                    },
                    required: ['table'],
                },
                isConcurrencySafe: true,
                isReadOnly: true,
                /**
                 * 查询指定表数据；Mock 模式在内置示例数据上做简单过滤。
                 *
                 * @param input 查询参数，必须包含表名。
                 * @returns
                 */
                execute: async (input: {
                    /** 需要查询的表名。 */
                    table: string;
                    /** 查询字段表达式，缺省为 `*`。 */
                    select?: string;
                    /** 简单等值过滤条件，格式为 `field=value`。 */
                    where?: string;
                    /** 返回行数上限，缺省为 10。 */
                    limit?: number;
                }) => {
                    const { table, select = '*', where, limit = 10 } = input;
                    if (!url) {
                        const mockData: Record<string, any[]> = {
                            users: [
                                { id: 1, name: '张三', email: 'zhang@example.com', role: 'admin' },
                                { id: 2, name: '李四', email: 'li@example.com', role: 'user' },
                                { id: 3, name: '王五', email: 'wang@example.com', role: 'user' },
                            ],
                            posts: [
                                {
                                    id: 1,
                                    title: 'Agent 开发入门',
                                    author_id: 1,
                                    status: 'published',
                                },
                                { id: 2, title: 'Plugin 架构设计', author_id: 1, status: 'draft' },
                            ],
                            comments: [{ id: 1, post_id: 1, user_id: 2, content: '写得不错！' }],
                            sessions: [
                                { id: 'sess-001', user_id: 1, created_at: '2026-05-01T10:00:00Z' },
                            ],
                        };
                        const rows = mockData[table] || [];
                        let filtered = rows;
                        if (where) {
                            const [field, value] = where.split('=');
                            filtered = rows.filter((r) => String(r[field]) === value);
                        }
                        return JSON.stringify({
                            table,
                            rows: filtered.slice(0, limit),
                            total: filtered.length,
                        });
                    }
                    return `SELECT ${select} FROM ${table}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`;
                },
            },
            {
                name: 'insert',
                description: '向指定表插入一条记录',
                parameters: {
                    type: 'object',
                    properties: {
                        table: { type: 'string', description: '表名' },
                        data: { type: 'object', description: '要插入的数据' },
                    },
                    required: ['table', 'data'],
                },
                isConcurrencySafe: false,
                isReadOnly: false,
                /**
                 * 向指定表插入一条记录；Mock 模式返回模拟插入结果。
                 *
                 * @param input 插入参数，包含表名和记录数据。
                 * @returns
                 */
                execute: async (input: {
                    /** 需要插入的表名。 */
                    table: string;
                    /** 要插入的一条记录数据。 */
                    data: Record<string, unknown>;
                }) => {
                    const { table, data } = input;
                    if (!url) {
                        return JSON.stringify({
                            success: true,
                            table,
                            inserted: { id: Math.floor(Math.random() * 1000), ...data },
                            note: 'Mock 模式',
                        });
                    }
                    return `INSERT INTO ${table} — ${JSON.stringify(data)}`;
                },
            },
        ]);

        api.log(`已注册 3 个工具（list_tables / query / insert）`);
    },

    /**
     * 释放插件占用的外部连接或资源。
     */
    destroy() {
        console.log('  [plugin:supabase] 连接已释放');
    },
};
