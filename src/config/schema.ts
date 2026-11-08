import { z } from 'zod';

export const ModelConfigSchema = z.object({
    provider: z.enum(['dashscope', 'openai', 'custom']).default('dashscope'),
    name: z.string().default('deepseek-v4-flash'),
    baseURL: z.string().default('https://api.deepseek.com'),
    apiKey: z.string().default(''),
});

export const PluginConfigSchema = z.object({
    name: z.string(),
    enabled: z.boolean().default(true),
    config: z.record(z.string()).default({}),
});

export const FeishuChannelConfigSchema = z.object({
    enabled: z.boolean().default(false),
    appId: z.string().default(''),
    appSecret: z.string().default(''),
    port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
    feishu: FeishuChannelConfigSchema.default({}),
});

export const AgentConfigSchema = z.object({
    maxSpawnDepth: z.number().min(0).max(5).default(1),
    maxConcurrent: z.number().min(1).max(10).default(3),
    defaultTimeout: z.number().default(60000),
});

export const SecurityConfigSchema = z.object({
    defaultRole: z.string().default('developer'),
    auditLog: z.boolean().default(true),
    bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
    dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
    enabled: z.boolean().default(true),
    docsDir: z.string().default('docs'),
    embeddingKey: z.string().default(''),
});

export const CronConfigSchema = z.object({
    enabled: z.boolean().default(true),
    dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
    id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
    trackingFile: z.string().default('.usage/today.jsonl'),
});

/** 本地进程与远程 HTTP 服务共用的连接开关和请求超时。 */
const mcpConnectionFields = {
    /** 是否在启动时连接此服务。 */
    enabled: z.boolean().default(true),
    /** 初始化及单次请求超时，单位毫秒。 */
    timeout: z.number().int().positive().max(2147483647).default(15000),
};

/** MCP 服务连接参数，按传输类型校验必需字段。 */
export const MCPServerConfigSchema = z.discriminatedUnion('transport', [
    z.object({
        ...mcpConnectionFields,
        /** 启动本地服务进程，通过标准输入输出通信。 */
        transport: z.literal('stdio'),
        /** 可执行程序名称或路径，不经 shell 解释。 */
        command: z.string().trim().min(1),
        /** 直接传给服务进程的参数。 */
        args: z.array(z.string()).default([]),
        /** 显式传给子进程的环境变量，支持配置占位符。 */
        env: z.record(z.string()).default({}),
    }),
    z.object({
        ...mcpConnectionFields,
        /** 使用官方 Streamable HTTP 传输。 */
        transport: z.literal('http'),
        /** MCP 服务的 HTTP 或 HTTPS 地址。 */
        url: z
            .string()
            .url()
            .refine((value) => /^https?:\/\//.test(value), '仅支持 HTTP(S) 地址'),
        /** 请求头，密钥通过环境变量占位符注入。 */
        headers: z.record(z.string()).default({}),
    }),
]);

/** 已解析并补齐默认值的 MCP 服务配置。 */
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/** 按名称管理 MCP 服务，默认不连接外部服务。 */
export const MCPConfigSchema = z.object({
    /** 名称用于工具前缀，仅允许字母、数字、下划线和连字符。 */
    servers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), MCPServerConfigSchema).default({}),
});

export const SuperAgentConfigSchema = z.object({
    version: z.string().default('1.0'),
    model: ModelConfigSchema.default({}),
    plugins: z.array(PluginConfigSchema).default([]),
    mcp: MCPConfigSchema.default({}),
    channels: ChannelConfigSchema.default({}),
    agents: AgentConfigSchema.default({}),
    security: SecurityConfigSchema.default({}),
    memory: MemoryConfigSchema.default({}),
    rag: RagConfigSchema.default({}),
    cron: CronConfigSchema.default({}),
    session: SessionConfigSchema.default({}),
    usage: UsageConfigSchema.default({}),
});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
