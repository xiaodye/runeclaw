import type { ModelMessage } from 'ai';

// ── Layer 1: Token Estimation ────────────────────────

export class TokenTracker {
    /** 最近一次来自模型 API 的精确 prompt token 计数。 */
    private lastPreciseCount = 0;
    /** 精确计数之后新增但尚未被 API 校准的字符数。 */
    private pendingChars = 0;

    /**
     * 用模型 API 返回的精确计数重置本地估算基线。
     *
     * @param promptTokens API 报告的 prompt token 数。
     */
    updateFromAPI(promptTokens: number): void {
        this.lastPreciseCount = promptTokens;
        this.pendingChars = 0;
    }

    /**
     * 累计新增消息内容，供下一次精确计数前做近似估算。
     *
     * @param content 新增消息的文本内容。
     */
    addMessage(content: string): void {
        this.pendingChars += content.length;
    }

    /**
     * 返回精确基线加新增字符估算后的 token 数。
     *
     * @returns
     */
    get estimatedTokens(): number {
        return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
    }

    /**
     * 返回当前上下文窗口占用状态，并提示是否需要触发压缩动作。
     *
     * @returns
     */
    get status(): {
        /** 当前估算 token 数。 */
        tokens: number;
        /** 相对上下文窗口的占用百分比。 */
        percent: number;
        /** 是否达到建议触发压缩的阈值。 */
        needsAction: boolean;
    } {
        const tokens = this.estimatedTokens;
        const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);
        return {
            tokens,
            percent,
            needsAction: percent >= 75,
        };
    }
}

const CONTEXT_WINDOW = 200_000;

/**
 * 按消息内容粗略估算 token 数，并对中英文混合内容加安全系数。
 *
 * @param messages 待估算的模型消息列表。
 * @returns
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            chars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if ('text' in part && typeof part.text === 'string') {
                    chars += part.text.length;
                } else if ('output' in part) {
                    const out =
                        typeof part.output === 'string' ? part.output : JSON.stringify(part.output);
                    chars += out.length;
                }
            }
        }
    }
    // 4 chars per token, with 1.2x safety factor for Chinese
    return Math.ceil((chars / 4) * 1.2);
}

// ── Layer 2: Dynamic Tool Result Truncation ──────────

interface TruncationConfig {
    /** 单个工具结果允许保留的最大字符数。 */
    maxSingleResult: number;
    /** 整体上下文中工具结果可占用的字符预算。 */
    contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
    maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2), // 50% of window, 2 chars/token
    contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4), // 75% of window, 4 chars/token
};

/**
 * 截断过大的工具结果，并在总预算超限时清理最早的工具输出。
 *
 * @param messages 待处理的消息列表。
 * @param config 截断阈值与总字符预算。
 * @returns
 */
export function truncateToolResults(
    messages: ModelMessage[],
    config: TruncationConfig = DEFAULT_TRUNCATION,
): {
    /** 截断或清理后的消息列表。 */
    messages: ModelMessage[];
    /** 被单结果截断的输出数量。 */
    truncated: number;
    /** 因总预算超限被整体清理的工具消息数量。 */
    compacted: number;
} {
    let truncated = 0;
    let compacted = 0;

    // Pass 1: single-result truncation (Head/Tail 60/40)
    let result = messages.map((msg) => {
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        const newContent = msg.content.map((part: any) => {
            if (!part.output || typeof part.output !== 'string') return part;
            if (part.output.length <= config.maxSingleResult) return part;

            truncated++;
            const maxChars = config.maxSingleResult;
            const headSize = Math.floor(maxChars * 0.6);
            const tailSize = Math.floor(maxChars * 0.4);
            const head = part.output.slice(0, headSize);
            const tail = part.output.slice(-tailSize);

            return {
                ...part,
                output: `${head}\n\n[truncated: ${part.output.length} → ${maxChars} chars]\n\n${tail}`,
            };
        });

        return { ...msg, content: newContent };
    });

    // Pass 2: total budget enforcement — compact oldest tool results first
    let totalChars = result.reduce((sum, msg) => {
        if (typeof msg.content === 'string') return sum + msg.content.length;
        if (Array.isArray(msg.content)) {
            return (
                sum +
                (msg.content as any[]).reduce(
                    (s, p) => s + ((p.output as string)?.length || (p.text as string)?.length || 0),
                    0,
                )
            );
        }
        return sum;
    }, 0);

    if (totalChars > config.contextBudgetChars) {
        for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
            const msg = result[i];
            if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
            const toolName = (msg.content as any[])[0]?.toolName || 'unknown';
            const oldSize = (msg.content as any[]).reduce(
                (s: number, p: any) => s + ((p.output as string)?.length || 0),
                0,
            );
            result[i] = {
                ...msg,
                content: (msg.content as any[]).map((p: any) => ({
                    ...p,
                    output: `[compacted: ${toolName} output removed to free context]`,
                })),
            };
            totalChars -= oldSize;
            compacted++;
        }
    }

    return { messages: result, truncated, compacted };
}

// ── Layer 3: TTL Pruning ─────────────────────────────

interface TTLConfig {
    /** 超过该时间后对工具结果做保留头尾的软裁剪。 */
    softTTLMs: number;
    /** 超过该时间后把工具结果整体替换成占位文本。 */
    hardTTLMs: number;
    /** 软裁剪时头尾分别保留的字符数。 */
    keepHeadTail: number;
}

const DEFAULT_TTL: TTLConfig = {
    softTTLMs: 5 * 60 * 1000, // 5 minutes
    hardTTLMs: 10 * 60 * 1000, // 10 minutes
    keepHeadTail: 1500, // chars to keep in soft prune
};

export interface PruneResult {
    /** TTL 处理后的消息列表。 */
    messages: ModelMessage[];
    /** 被软裁剪的工具结果数量。 */
    softPruned: number;
    /** 被硬清理的工具结果数量。 */
    hardPruned: number;
}

/**
 * 根据工具结果年龄做 TTL 裁剪，同时保留包含错误信息的结果。
 *
 * @param messages 待裁剪的消息列表。
 * @param timestamps 消息索引到创建时间戳的映射。
 * @param config TTL 阈值与保留长度配置。
 * @returns
 */
export function ttlPrune(
    messages: ModelMessage[],
    timestamps: Map<number, number>,
    config: TTLConfig = DEFAULT_TTL,
): PruneResult {
    const now = Date.now();
    let softPruned = 0;
    let hardPruned = 0;

    const result = messages.map((msg, idx) => {
        // Only prune tool results, never user/assistant messages
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        const ts = timestamps.get(idx);
        if (!ts) return msg;

        const age = now - ts;

        // Preserve error experiences — never prune failed tool results
        const outputText = (msg.content as any[])
            .map((p: any) => (typeof p.output === 'string' ? p.output : ''))
            .join('');
        const isError = /error|失败|不存在|denied|refused|timeout/i.test(outputText);
        if (isError) return msg;

        // Hard clear: replace entire content with placeholder
        if (age >= config.hardTTLMs) {
            hardPruned++;
            const toolName = (msg.content[0] as any)?.toolName || 'unknown';
            return {
                ...msg,
                content: msg.content.map((part: any) => ({
                    ...part,
                    output: `[tool result expired: ${toolName}]`,
                })),
            };
        }

        // Soft prune: keep head + tail, replace middle
        if (age >= config.softTTLMs) {
            const newContent = msg.content.map((part: any) => {
                if (!part.output || typeof part.output !== 'string') return part;
                if (part.output.length <= config.keepHeadTail * 2) return part;

                softPruned++;
                const head = part.output.slice(0, config.keepHeadTail);
                const tail = part.output.slice(-config.keepHeadTail);
                const removed = part.output.length - config.keepHeadTail * 2;

                return {
                    ...part,
                    output: `${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`,
                };
            });
            return { ...msg, content: newContent };
        }

        return msg;
    });

    return { messages: result, softPruned, hardPruned };
}

// ── Combined Defense ─────────────────────────────────

export interface DefenseResult {
    /** 防御处理后的消息列表。 */
    messages: ModelMessage[];
    /** 处理后的最终 token 估算值。 */
    tokenEstimate: number;
    /** 被单结果截断的输出数量。 */
    truncated: number;
    /** 因总预算超限被整体清理的工具消息数量。 */
    compacted: number;
    /** TTL 软裁剪数量。 */
    softPruned: number;
    /** TTL 硬清理数量。 */
    hardPruned: number;
}

/**
 * 组合执行工具结果截断、TTL 裁剪和最终 token 估算。
 *
 * @param messages 原始消息列表。
 * @param timestamps 工具消息索引到创建时间戳的映射。
 * @returns
 */
export function applyDefense(
    messages: ModelMessage[],
    timestamps: Map<number, number>,
): DefenseResult {
    // Layer 2: truncate oversized tool results
    const trunc = truncateToolResults(messages);
    let result = trunc.messages;

    // Layer 3: TTL prune old tool results
    const prune = ttlPrune(result, timestamps);
    result = prune.messages;

    // Layer 1: estimate final token count
    const tokenEstimate = estimateMessageTokens(result);

    return {
        messages: result,
        tokenEstimate,
        truncated: trunc.truncated,
        compacted: trunc.compacted,
        softPruned: prune.softPruned,
        hardPruned: prune.hardPruned,
    };
}
