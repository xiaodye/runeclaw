import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

/** 收到用户消息时先添加的表情回应（飞书 emoji_type 代码，用作「稍等」提示）。 常见：Typing，Get */
const WAIT_REACTION_EMOJI = 'Typing';

interface FeishuConfig {
    /** 飞书应用的 App ID，缺失时仅启动本地 Dashboard。 */
    appId: string;
    /** 飞书应用的 App Secret，用于初始化 SDK 客户端。 */
    appSecret: string;
    /** 本地 Dashboard 与测试 webhook 监听端口。 */
    port: number;
}

/**
 * 通过飞书长连接接收入站消息，并提供本地 Dashboard 便于无配置调试。
 */
export class FeishuChannel implements ChannelDefinition {
    /** 通道注册名，用于网关识别和日志输出。 */
    name = 'feishu';
    /** 通道说明，会展示在 Dashboard 或通道列表中。 */
    description = '飞书 Bot 消息通道（长连接模式）';

    /** 飞书 SDK 与本地 Dashboard 的运行配置。 */
    private config: FeishuConfig;
    /** 网关注册的入站消息处理器。 */
    private messageHandler?: (msg: IncomingMessage) => void;
    /** 本地 Dashboard 的 HTTP server 句柄。 */
    private httpServer?: any;
    /** 飞书长连接客户端实例。 */
    private wsClient?: any;
    /** 飞书开放平台 API 客户端实例，用于发送回复。 */
    private larkClient?: any;
    /** 消息 ID → 已添加的「稍等」表情回应 ID，完成回复后据此清除。 */
    private reactions = new Map<string, string>();

    /**
     * 创建飞书通道实例并保存运行配置。
     *
     * @param config 飞书通道配置。
     */
    constructor(config: FeishuConfig) {
        this.config = config;
    }

    /**
     * 注册网关侧入站消息处理器。
     *
     * @param handler 接收入站消息的回调。
     */
    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    /**
     * 启动本地 Dashboard，并在飞书配置完整时建立长连接。
     */
    async start(): Promise<void> {
        // 启动状态面板（不管有没有配飞书都起）
        await this.startDashboard();

        if (!this.config.appId || !this.config.appSecret) {
            console.log('    飞书未配置 APP_ID / APP_SECRET，仅启动 Dashboard');
            console.log('    用页面上的「发送测试消息」或 curl 测试 Channel 流程');
            return;
        }

        // 用飞书 SDK 的长连接模式
        const lark = await import('@larksuiteoapi/node-sdk');

        this.larkClient = new lark.Client({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
        });

        const dispatcher = new lark.EventDispatcher({});

        dispatcher.register({
            'im.message.receive_v1': (data) => {
                if (data.message.message_type !== 'text') return;

                const content = JSON.parse(data.message.content);
                let text = content.text || '';
                // 去掉 @Bot 的 mention 标记
                if (data.message.mentions) {
                    for (const m of data.message.mentions) {
                        text = text.replace(m.key, '').trim();
                    }
                }

                if (text && this.messageHandler) {
                    const messageId = data.message.message_id;
                    // 先给用户消息添加「稍等」表情回应，处理完成后再清除
                    if (messageId) this.addWaitingReaction(messageId);
                    this.messageHandler({
                        channelId: data.message.chat_id,
                        senderId: data.sender.sender_id?.open_id || 'unknown',
                        senderName: data.sender.sender_id?.open_id || 'unknown',
                        text,
                        messageId,
                        raw: data,
                    });
                }
            },
        });

        this.wsClient = new lark.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            loggerLevel: lark.LoggerLevel.warn,
        });

        await this.wsClient.start({ eventDispatcher: dispatcher });
        console.log('    飞书长连接已建立（无需 ngrok）');
    }

    /**
     * 关闭本地 Dashboard 服务。
     */
    async stop(): Promise<void> {
        if (this.httpServer) this.httpServer.close();
    }

    /**
     * 将网关回复发送到飞书会话；未配置飞书时仅记录日志。
     *
     * @param message 待发送的出站消息。
     */
    async send(message: OutgoingMessage): Promise<void> {
        if (!this.larkClient) {
            console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`);
            return;
        }

        try {
            if (message.messageId) {
                // 用 lark_md 卡片回复特定消息：内联 markdown（加粗/斜体/行内代码）可正常渲染，并引用原消息
                const card = {
                    config: { wide_screen_mode: true },
                    elements: [
                        {
                            tag: 'div',
                            text: { tag: 'lark_md', content: message.text },
                        },
                    ],
                };
                await this.larkClient.im.message.reply({
                    path: { message_id: message.messageId },
                    data: {
                        content: JSON.stringify(card),
                        msg_type: 'interactive',
                        reply_in_thread: false,
                    },
                });
            } else {
                // 无 messageId（如测试 webhook）时退回发新消息到会话
                await this.larkClient.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: {
                        receive_id: message.channelId,
                        msg_type: 'text',
                        content: JSON.stringify({ text: message.text }),
                    },
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    [feishu] 发送失败: ${msg}`);
        }

        // 回复已发出，清除之前添加的「稍等」表情回应
        if (message.messageId) await this.removeWaitingReaction(message.messageId);
    }

    /**
     * 给指定消息添加「稍等」表情回应，并记录返回的回应 ID 以便后续清除。
     *
     * @param messageId 目标消息 ID。
     */
    private async addWaitingReaction(messageId: string): Promise<void> {
        if (!this.larkClient) return;
        try {
            const res = await this.larkClient.im.messageReaction.create({
                path: { message_id: messageId },
                data: { reaction_type: { emoji_type: WAIT_REACTION_EMOJI } },
            });
            const reactionId = res.data?.reaction_id;
            if (reactionId) this.reactions.set(messageId, reactionId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`    [feishu] 添加「稍等」表情失败: ${msg}`);
        }
    }

    /**
     * 删除指定消息上的「稍等」表情回应（回复发送完成时调用）。
     *
     * @param messageId 目标消息 ID。
     */
    private async removeWaitingReaction(messageId: string): Promise<void> {
        const reactionId = this.reactions.get(messageId);
        if (!this.larkClient || !reactionId) return;
        try {
            await this.larkClient.im.messageReaction.delete({
                path: { message_id: messageId, reaction_id: reactionId },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`    [feishu] 清除「稍等」表情失败: ${msg}`);
        } finally {
            this.reactions.delete(messageId);
        }
    }

    /**
     * 启动本地调试 Dashboard，并暴露模拟飞书 webhook 的测试入口。
     */
    private async startDashboard(): Promise<void> {
        const { Hono } = await import('hono');
        const { serve } = await import('@hono/node-server');

        const app = new Hono();

        // 模拟 webhook（Dashboard 测试用）
        app.post('/webhook/feishu', async (c) => {
            const body = await c.req.json();

            if (body.header?.event_type === 'im.message.receive_v1') {
                const event = body.event;
                if (event.message?.message_type === 'text') {
                    const content = JSON.parse(event.message.content);
                    const text = content.text?.replace(/@_user_\d+/g, '').trim();
                    if (text && this.messageHandler) {
                        this.messageHandler({
                            channelId: event.message.chat_id || 'web-test',
                            senderId: event.sender?.sender_id?.open_id || 'web-dashboard',
                            senderName: event.sender?.sender_id?.open_id || 'web-dashboard',
                            text,
                            raw: body,
                        });
                    }
                }
            }

            return c.json({ code: 0 });
        });

        // 状态面板
        app.get('/', (c) => {
            const feishuStatus = this.config.appId ? '已连接（长连接模式）' : '未配置';
            const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>RuneClaw — Channel Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #78350f; color: #fcd34d; }
    .endpoint { font-family: monospace; background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; }
    ul { list-style: none; }
    li { margin-bottom: 0.5rem; }
    textarea { width: 100%; background: #334155; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; resize: vertical; min-height: 60px; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 0.75rem; padding: 0.75rem; background: #334155; border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>RuneClaw v1.0</h1>
  <p class="subtitle">Channel Dashboard</p>

  <div class="card">
    <h2>Channel 状态</h2>
    <ul>
      <li><span class="badge ${this.config.appId ? 'badge-ok' : 'badge-off'}">${feishuStatus}</span> feishu — 飞书 Bot 消息通道</li>
    </ul>
  </div>

  <div class="card">
    <h2>发送测试消息</h2>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">通过模拟 webhook 发消息给 Agent，回复在终端查看</p>
    <textarea id="msg" placeholder="输入要发给 Agent 的消息...">你好</textarea>
    <button onclick="sendTest()">发送</button>
    <div id="result"></div>
  </div>

  <script>
    async function sendTest() {
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.textContent = '发送中...';
      try {
        const body = {
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'web-test' },
            sender: { sender_id: { open_id: 'web-dashboard' } }
          }
        };
        const res = await fetch('/webhook/feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        result.textContent = 'OK — 查看终端输出';
      } catch (e) {
        result.textContent = e.message;
      }
    }
  </script>
</body>
</html>`;
            return c.html(html);
        });

        app.get('/health', (c) => c.text('OK'));

        this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
        console.log(`    Dashboard: http://localhost:${this.config.port}`);
    }
}
