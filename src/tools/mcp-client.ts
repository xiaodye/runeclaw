import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

interface MCPTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

interface MCPCallResult {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
}

export class MCPClient {
    private process: ChildProcess | null = null;
    private rl: Interface | null = null;
    private requestId = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private serverName: string;

    constructor(
        private command: string,
        private args: string[],
        private env?: Record<string, string>,
    ) {
        this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server';
    }

    async connect(): Promise<void> {
        this.process = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.env },
        });

        this.process.on('error', (err) => {
            console.error(`  [MCP] 进程启动失败: ${err.message}`);
        });

        this.process.stderr?.on('data', () => {});

        this.rl = createInterface({ input: this.process.stdout! });
        this.rl.on('line', (line) => {
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
                    } else {
                        p.resolve(msg.result);
                    }
                }
            } catch {
                /* ignore non-JSON lines */
            }
        });

        await this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'runeclaw', version: '1.0.0' },
        });

        this.process.stdin!.write(
            JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
            }) + '\n',
        );
    }

    private send(method: string, params?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timeout: ${method}`));
            }, 15000);

            this.pending.set(id, {
                resolve: (v: any) => {
                    clearTimeout(timeout);
                    resolve(v);
                },
                reject: (e: Error) => {
                    clearTimeout(timeout);
                    reject(e);
                },
            });

            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            this.process!.stdin!.write(msg + '\n');
        });
    }

    async listTools(): Promise<MCPTool[]> {
        const result = await this.send('tools/list', {});
        return result.tools || [];
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        const result: MCPCallResult = await this.send('tools/call', { name, arguments: args });
        const texts = (result.content || [])
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!);
        return texts.join('\n') || '(无返回内容)';
    }

    async close(): Promise<void> {
        if (this.rl) this.rl.close();
        if (this.process) this.process.kill();
    }
}
