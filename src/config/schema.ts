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

export const SuperAgentConfigSchema = z.object({
    version: z.string().default('1.0'),
    model: ModelConfigSchema.default({}),
    plugins: z.array(PluginConfigSchema).default([]),
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
