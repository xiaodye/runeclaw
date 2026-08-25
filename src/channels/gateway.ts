import type { ModelMessage } from 'ai';
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types';
import type { ToolRegistry } from '../tools/registry';
import { agentLoop } from '../agent/loop';

interface GatewayOptions {
    /** 传递给 agent loop 的模型实例。 */
    model: any;
    /** 提供给 agent loop 的工具注册表。 */
    registry: ToolRegistry;
    /** 为每次入站消息构建最新 system prompt 的工厂函数。 */
    buildSystem: () => string;
}

/**
 * 协调多个消息通道与 agent loop，并为每个发送者维护独立会话历史。
 */
export class ChannelGateway {
    /** 已注册通道表，按通道名称索引。 */
    private channels = new Map<string, ChannelDefinition>();
    /** 发送者级别的对话历史，避免不同通道或用户互相串话。 */
    private sessions = new Map<string, ModelMessage[]>();
    /** 网关运行所需的模型、工具与 system prompt 构造器。 */
    private options: GatewayOptions;

    /**
     * 创建通道网关并保存 agent loop 运行依赖。
     *
     * @param options 网关运行选项。
     */
    constructor(options: GatewayOptions) {
        this.options = options;
    }

    /**
     * 注册一个消息通道，并把通道入站消息接入统一处理流程。
     *
     * @param channel 待注册的消息通道定义。
     */
    register(channel: ChannelDefinition): void {
        this.channels.set(channel.name, channel);

        channel.onMessage?.((msg: IncomingMessage) => {
            this.handleIncoming(channel.name, msg);
        });
    }

    /**
     * 逐个启动所有已注册通道，并将失败记录到日志。
     */
    async startAll(): Promise<void> {
        for (const [name, ch] of this.channels) {
            try {
                await ch.start();
                console.log(`  [gateway] ✓ ${name} 已启动`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
            }
        }
    }

    /**
     * 停止所有已注册通道，释放各通道持有的连接资源。
     */
    async stopAll(): Promise<void> {
        for (const [, ch] of this.channels) {
            await ch.stop();
        }
    }

    /**
     * 将入站消息追加到对应会话，运行 agent loop 后把最新回复发回原通道。
     *
     * @param channelName 产生消息的通道名称。
     * @param msg 已由通道归一化的入站消息。
     */
    private async handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
        const sessionKey = `${channelName}:${msg.senderId}`;
        console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

        if (!this.sessions.has(sessionKey)) {
            this.sessions.set(sessionKey, []);
        }
        const messages = this.sessions.get(sessionKey)!;

        const userMsg: ModelMessage = { role: 'user', content: msg.text };
        messages.push(userMsg);

        const system = this.options.buildSystem();
        const beforeLen = messages.length;

        await agentLoop(this.options.model, this.options.registry, messages, system);

        const lastMsg = messages[messages.length - 1];
        let replyText = '';
        if (lastMsg && lastMsg.role === 'assistant') {
            const content = lastMsg.content;
            if (typeof content === 'string') {
                replyText = content;
            } else if (Array.isArray(content)) {
                replyText = content
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => c.text)
                    .join('');
            }
        }

        if (replyText) {
            const channel = this.channels.get(channelName);
            if (channel) {
                const outgoing: OutgoingMessage = {
                    channelId: msg.channelId,
                    recipientId: msg.senderId,
                    text: replyText,
                    messageId: msg.messageId,
                };
                await channel.send(outgoing);
                console.log(
                    `  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`,
                );
            }
        }
    }

    /**
     * 返回当前已注册通道的展示信息。
     *
     * @returns
     */
    list(): Array<{ name: string; description: string }> {
        return Array.from(this.channels.values()).map((ch) => ({
            name: ch.name,
            description: ch.description,
        }));
    }
}
