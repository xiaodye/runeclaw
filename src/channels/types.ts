export interface IncomingMessage {
    /** 通道内的会话或房间标识，用于将回复发回原始上下文。 */
    channelId: string;
    /** 发送者在对应通道中的稳定标识，用于区分会话历史。 */
    senderId: string;
    /** 展示在日志或调试界面的发送者名称。 */
    senderName: string;
    /** 已归一化为纯文本的用户输入内容。 */
    text: string;
    /** 平台原始消息 ID，用于消息级操作（如表情回应）。 */
    messageId?: string;
    /** 通道原始事件数据，便于排查平台侧字段差异。 */
    raw?: unknown;
}

export interface OutgoingMessage {
    /** 目标通道内的会话或房间标识。 */
    channelId: string;
    /** 接收者在通道中的标识，供支持私聊或定向回复的平台使用。 */
    recipientId: string;
    /** 待发送到通道的纯文本回复。 */
    text: string;
    /** 平台原始消息 ID，用于关联回复与表情回应清理。 */
    messageId?: string;
}

export interface ChannelDefinition {
    /** 通道唯一名称，用于注册、日志和会话 key 拼接。 */
    name: string;
    /** 面向运维或 Dashboard 展示的通道说明。 */
    description: string;

    /**
     * 启动通道所需的监听、连接或本地服务。
     */
    start(): Promise<void> | void;

    /**
     * 停止通道持有的连接或服务资源。
     */
    stop(): Promise<void> | void;

    /**
     * 将网关生成的回复发送到具体通道。
     *
     * @param message 已归一化的出站消息。
     */
    send(message: OutgoingMessage): Promise<void>;

    /**
     * 注册入站消息回调，使通道可以把平台事件交给网关处理。
     *
     * @param handler 接收入站消息的回调。
     */
    onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}
