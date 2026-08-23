import { jsonSchema } from 'ai';
import type { MCPClient, MockMCPClient } from './mcp-client.js';
import type { HookPipeline } from '../security/hooks.js';
import type { Role } from '../security/roles.js';
import { canUseTool } from '../security/roles.js';
import { classifyBashCommand } from '../security/bash-classifier.js';

export interface ToolDefinition {
    /** 工具注册表中使用的唯一名称。 */
    name: string;
    /** 展示给模型的工具用途说明。 */
    description: string;
    /** 传递给 AI SDK 的输入参数 JSON Schema。 */
    parameters: Record<string, unknown>;
    /** 是否允许与其他并发安全工具同时执行。 */
    isConcurrencySafe?: boolean;
    /** 是否仅执行读取操作，用于工具权限与调度判断。 */
    isReadOnly?: boolean;
    /** 结果允许返回的最大字符数。 */
    maxResultChars?: number;
    /** 执行工具并返回原始结果。 */
    execute: (input: any) => Promise<unknown>;
    /** 工具所属的 profile；未设置时对所有 profile 可用。 */
    profile?: string[];
    /** 是否延迟到通过工具搜索发现后才暴露。 */
    shouldDefer?: boolean;
    /** 用于工具搜索的补充关键词。 */
    searchHint?: string;
}

/** 通用工具结果默认截断上限（字符），约 2000 token。 */
const DEFAULT_MAX_RESULT_CHARS = 8000;

export class ToolRegistry {
    /** 当前注册的工具定义，按工具名索引。 */
    private tools = new Map<string, ToolDefinition>();
    /** 已连接的 MCP 客户端，用于统一关闭连接。 */
    private mcpClients: Array<MCPClient | MockMCPClient> = [];

    /** 是否有排他工具正在执行。 */
    private exclusiveLock = false;
    /** 当前并发执行中的并发安全工具数量。 */
    private concurrentCount = 0;
    /** 等待执行锁释放的任务唤醒队列。 */
    private waitQueue: Array<() => void> = [];

    /** 当前生效的工具 profile。 */
    private activeProfile: string = 'full';
    /** 已通过搜索显式发现的工具名称。 */
    private discoveredTools = new Set<string>();
    /** 当前执行工具所使用的角色。 */
    private currentRole: Role = 'owner';
    /** 可选的工具执行前后 Hook 流水线。 */
    private hookPipeline?: HookPipeline;

    /**
     * 批量注册工具；同名工具会覆盖已有定义。
     *
     * @param tools 待注册的工具定义。
     */
    register(...tools: ToolDefinition[]): void {
        for (const tool of tools) {
            this.tools.set(tool.name, tool);
        }
    }

    /**
     * 移除指定工具，并清理其已发现状态。
     *
     * @param name 待移除的工具名称。
     * @returns 是否成功移除了工具。
     */
    unregister(name: string): boolean {
        this.discoveredTools.delete(name);
        return this.tools.delete(name);
    }

    /**
     * 连接 MCP 服务并注册其尚未存在的工具。
     *
     * @param serverName MCP 服务名称，用于生成工具名前缀。
     * @param client MCP 客户端实例。
     * @returns 本次实际注册的工具名称列表。
     */
    async registerMCPServer(
        serverName: string,
        client: MCPClient | MockMCPClient,
    ): Promise<string[]> {
        await client.connect();
        this.mcpClients.push(client);

        const tools = await client.listTools();
        const registered: string[] = [];

        for (const tool of tools) {
            const prefixedName = `mcp__${serverName}__${tool.name}`;
            if (this.tools.has(prefixedName)) continue;

            const toolClient = client;
            const originalName = tool.name;

            this.register({
                name: prefixedName,
                description: `[MCP:${serverName}] ${tool.description}`,
                parameters: tool.inputSchema as Record<string, unknown>,
                isConcurrencySafe: true,
                isReadOnly: true,
                maxResultChars: 8000,
                profile: ['full'],
                shouldDefer: true,
                searchHint: `${serverName} ${tool.name} ${tool.description}`,
                execute: async (input: any) => {
                    return toolClient.callTool(originalName, input);
                },
            });

            registered.push(prefixedName);
        }

        return registered;
    }

    /** 关闭所有已连接的 MCP 客户端并清空客户端列表。 */
    async closeAllMCP(): Promise<void> {
        for (const client of this.mcpClients) {
            await client.close();
        }
        this.mcpClients = [];
    }

    /**
     * 设置当前生效的工具 profile。
     *
     * @param profile 要启用的 profile 名称。
     */
    setProfile(profile: string): void {
        this.activeProfile = profile;
    }

    /**
     * 返回当前生效的工具 profile。
     *
     * @returns 当前生效的 profile 名称。
     */
    getProfile(): string {
        return this.activeProfile;
    }

    /**
     * 设置当前执行工具所使用的角色。
     *
     * @param role 当前用户角色。
     */
    setRole(role: Role): void {
        this.currentRole = role;
    }

    /**
     * 返回当前执行工具所使用的角色。
     *
     * @returns 当前角色。
     */
    getRole(): Role {
        return this.currentRole;
    }

    /**
     * 设置工具执行前后的 Hook 流水线。
     *
     * @param pipeline 用于拦截或修改工具调用的 Hook 流水线。
     */
    setHookPipeline(pipeline: HookPipeline): void {
        this.hookPipeline = pipeline;
    }

    /**
     * 标记工具已被搜索发现，使其可以参与后续暴露。
     *
     * @param name 已发现的工具名称。
     */
    markDiscovered(name: string): void {
        this.discoveredTools.add(name);
    }

    /**
     * 按名称查找工具定义。
     *
     * @param name 要查找的工具名称。
     * @returns 找到的工具定义，不存在时返回 `undefined`。
     */
    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    /**
     * 返回注册表中的全部工具定义。
     *
     * @returns 按注册顺序排列的工具定义列表。
     */
    getAll(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    /**
     * 根据 profile、发现状态和角色权限筛选当前可用工具。
     *
     * @returns 当前可暴露给模型的工具定义列表。
     */
    getActiveTools(): ToolDefinition[] {
        return this.getAll().filter((tool) => {
            if (tool.profile && !tool.profile.includes(this.activeProfile)) {
                return false;
            }
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
                return false;
            }
            if (!canUseTool(this.currentRole, tool.name)) {
                return false;
            }
            return true;
        });
    }

    /**
     * 生成尚未发现的延迟工具摘要，供模型了解可搜索能力。
     *
     * @returns 延迟工具摘要；没有待发现工具时返回空字符串。
     */
    getDeferredToolSummary(): string {
        const deferred = this.getAll().filter((tool) => {
            return tool.shouldDefer && !this.discoveredTools.has(tool.name);
        });

        if (deferred.length === 0) return '';

        const lines = deferred.map((t) => {
            const hint = t.searchHint ? ` — ${t.searchHint}` : '';
            return `  - ${t.name}${hint}`;
        });

        return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
    }

    /**
     * 按一个或多个工具名称搜索，并记录命中的工具为已发现。
     *
     * @param query 工具名称；多个名称可用逗号分隔。
     * @returns 命中的工具定义列表。
     */
    searchTools(query: string): ToolDefinition[] {
        const q = query.trim();
        const results: ToolDefinition[] = [];

        // 支持逗号分隔的多个工具名，如 "mcp__github__list_issues,mcp__github__search_repositories"
        const names = q.includes(',')
            ? q
                  .split(',')
                  .map((n) => n.trim())
                  .filter(Boolean)
            : [q];

        for (const name of names) {
            const tool = this.tools.get(name);
            if (tool && tool.name !== 'tool_search') {
                results.push(tool);
                this.discoveredTools.add(tool.name);
            }
        }

        return results;
    }

    /**
     * 估算当前 profile 下活动与延迟工具的 token 占用。
     *
     * @returns 活动、延迟及合计 token 估算值。
     */
    countTokenEstimate(): { active: number; deferred: number; total: number } {
        let active = 0;
        let deferred = 0;

        for (const tool of this.tools.values()) {
            if (tool.profile && !tool.profile.includes(this.activeProfile)) continue;

            const schemaSize = JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }).length;
            const tokens = Math.ceil(schemaSize / 4);

            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
                deferred += tokens;
            } else {
                active += tokens;
            }
        }

        return { active, deferred, total: active + deferred };
    }

    /** 等待排他锁释放后获取并发执行名额。 */
    private async acquireConcurrent(): Promise<void> {
        while (this.exclusiveLock) {
            await new Promise<void>((r) => this.waitQueue.push(r));
        }
        this.concurrentCount++;
    }

    /** 释放并发执行名额，并在无并发任务时唤醒等待者。 */
    private releaseConcurrent(): void {
        this.concurrentCount--;
        if (this.concurrentCount === 0) this.drainQueue();
    }

    /** 等待所有任务结束后获取排他执行锁。 */
    private async acquireExclusive(): Promise<void> {
        while (this.exclusiveLock || this.concurrentCount > 0) {
            await new Promise<void>((r) => this.waitQueue.push(r));
        }
        this.exclusiveLock = true;
    }

    /** 释放排他执行锁并唤醒等待队列。 */
    private releaseExclusive(): void {
        this.exclusiveLock = false;
        this.drainQueue();
    }

    /** 唤醒当前排队等待锁的所有任务。 */
    private drainQueue(): void {
        const waiting = this.waitQueue.splice(0);
        for (const resolve of waiting) resolve();
    }

    /**
     * 在不加执行锁的情况下转换为 AI SDK 工具格式。
     *
     * @param excludeTools 要排除的工具名称集合。
     * @returns AI SDK 可消费的工具映射。
     */
    toAISDKFormatUnlocked(excludeTools?: Set<string>): Record<string, any> {
        const result: Record<string, any> = {};
        const activeTools = this.getActiveTools().filter(
            (t) => !excludeTools || !excludeTools.has(t.name),
        );

        for (const tool of activeTools) {
            const maxChars = tool.maxResultChars;
            const executeFn = tool.execute;
            result[tool.name] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: async (input: any) => {
                    const raw = await executeFn(input);
                    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                    return truncateResult(text, maxChars);
                },
            };
        }
        return result;
    }

    /**
     * 转换为带并发控制、风险检测和 Hook 的 AI SDK 工具格式。
     *
     * @returns AI SDK 可消费的工具映射。
     */
    toAISDKFormat(): Record<string, any> {
        const result: Record<string, any> = {};
        const activeTools = this.getActiveTools();

        for (const tool of activeTools) {
            const maxChars = tool.maxResultChars;
            const executeFn = tool.execute;
            const isSafe = tool.isConcurrencySafe === true;
            const registry = this;

            const hookPipeline = registry.hookPipeline;
            const toolName = tool.name;

            result[tool.name] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: async (input: any) => {
                    // Bash 风险检测
                    if (toolName === 'bash' && input?.command) {
                        const risk = classifyBashCommand(input.command);
                        if (risk.level === 'dangerous') {
                            return `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${input.command}`;
                        }
                        if (risk.level === 'moderate') {
                            console.log(`  [安全] ⚠ ${risk.reason}: ${input.command}`);
                        }
                    }

                    // Pre Hook
                    if (hookPipeline) {
                        const preResult = await hookPipeline.runPre(toolName, input);
                        if (preResult.action === 'block') {
                            return `[Hook 拦截] ${preResult.reason || '操作被阻止'}`;
                        }
                        if (
                            preResult.action === 'modify' &&
                            preResult.modifiedInput !== undefined
                        ) {
                            input = preResult.modifiedInput;
                        }
                    }

                    if (isSafe) {
                        await registry.acquireConcurrent();
                    } else {
                        await registry.acquireExclusive();
                    }
                    try {
                        const raw = await executeFn(input);
                        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                        let output = truncateResult(text, maxChars);

                        // Post Hook
                        if (hookPipeline) {
                            const postResult = await hookPipeline.runPost(toolName, input, output);
                            if (postResult.modifiedOutput !== undefined) {
                                output = String(postResult.modifiedOutput);
                            }
                        }

                        return output;
                    } finally {
                        if (isSafe) {
                            registry.releaseConcurrent();
                        } else {
                            registry.releaseExclusive();
                        }
                    }
                },
            };
        }
        return result;
    }
}

/**
 * 按上限保留结果首尾内容，并在中间标记被省略的字符数。
 *
 * @param text 待截断的完整结果文本。
 * @param maxChars 允许保留的最大字符数。
 * @returns 截断后的结果文本。
 */
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
    if (text.length <= maxChars) return text;

    const headSize = Math.floor(maxChars * 0.6);
    const tailSize = maxChars - headSize;
    const head = text.slice(0, headSize);
    const tail = text.slice(-tailSize);
    const dropped = text.length - headSize - tailSize;

    return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
