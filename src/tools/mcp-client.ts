import {
    Client,
    StdioClientTransport,
    StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { MCPServerConfig } from '../config/schema.js';

/** 官方 SDK 返回的远端工具定义。 */
type MCPTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

/** 使用官方 SDK 管理 MCP 连接，供本地工具注册层调用。 */
export class MCPClient {
    /** 负责协议协商、请求匹配和响应校验的官方客户端。 */
    private client = new Client({ name: 'runeclaw', version: '1.0.9' });
    /** 当前连接使用的服务配置。 */
    private config: MCPServerConfig;

    /**
     * 保存连接参数，不在构造阶段启动进程或访问网络。
     * @param config 已通过配置校验的 MCP 服务参数。
     */
    constructor(config: MCPServerConfig) {
        this.config = config;
    }

    /** 通过配置指定的传输连接服务，失败时释放已创建的资源。 */
    async connect(): Promise<void> {
        const config = this.config;
        const transport =
            config.transport === 'stdio'
                ? new StdioClientTransport({
                      command: config.command,
                      args: config.args,
                      env: config.env,
                      stderr: 'inherit',
                  })
                : new StreamableHTTPClientTransport(new URL(config.url), {
                      requestInit: { headers: config.headers },
                  });
        try {
            await this.client.connect(transport, { timeout: config.timeout });
        } catch (error) {
            await this.client.close().catch(() => {});
            await transport.close().catch(() => {});
            throw error;
        }
    }

    /**
     * 读取全部工具分页，避免只注册服务的第一页工具。
     * @returns
     */
    async listTools(): Promise<MCPTool[]> {
        const tools: MCPTool[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
            const page = await this.client.listTools(cursor ? { cursor } : {}, {
                timeout: this.config.timeout,
            });
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor) {
                if (cursors.has(cursor)) throw new Error('MCP 工具分页游标重复');
                cursors.add(cursor);
            }
        } while (cursor);
        return tools;
    }

    /**
     * 调用远端工具，保留错误标志、结构化数据和非文本内容。
     * @param name 远端原始工具名称。
     * @param args 工具输入参数。
     * @returns MCP 原始结果，交由注册表序列化和截断。
     */
    async callTool(name: string, args: Record<string, unknown>) {
        return this.client.callTool({ name, arguments: args }, { timeout: this.config.timeout });
    }

    /** 关闭官方客户端及其传输，释放子进程或网络连接。 */
    async close(): Promise<void> {
        await this.client.close();
    }
}
