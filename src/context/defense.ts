import type { ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

// ── Layer 1: Token Estimation ────────────────────────

/** 结合 API 精确基准和消息增量估算上下文 token 使用量。 */
export class TokenTracker {
    /** 最近一次由模型 API 返回的精确 prompt token 数。 */
    private lastPreciseCount = 0;
    /** 自上次精确统计后新增消息的字符数。 */
    private pendingChars = 0;

    /**
     * 更新 token 估算的 API 基准，并清空待累加字符数。
     *
     * @param promptTokens API 返回的 prompt token 数。
     */
    updateFromAPI(promptTokens: number): void {
        this.lastPreciseCount = promptTokens;
        this.pendingChars = 0;
    }

    /**
     * 将一条新消息的字符量加入待估算增量。
     *
     * @param message 待计入的模型消息。
     */
    addMessage(message: ModelMessage): void {
        this.pendingChars += countMessageChars(message);
    }

    /**
     * 批量将消息加入待估算增量。
     *
     * @param messages 待计入的模型消息列表。
     */
    addMessages(messages: ModelMessage[]): void {
        for (const message of messages) {
            this.addMessage(message);
        }
    }

    /**
     * 根据消息替换前后的字符差更新待估算增量。
     *
     * @param before 替换前的消息列表。
     * @param after 替换后的消息列表。
     */
    replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
        this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
    }

    /** 当前基于精确基准和新增字符量估算的 token 数。 */
    get estimatedTokens(): number {
        return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4));
    }

    /** 当前 token 使用量、占比及是否需要采取压缩措施。 */
    get status(): { tokens: number; percent: number; needsAction: boolean } {
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
 * 统计单条消息中的文本、工具输入和工具输出字符数。
 *
 * @param message 待统计的模型消息。
 * @returns 消息内容的近似字符数。
 */
function countMessageChars(message: ModelMessage): number {
    let chars = 0;
    if (typeof message.content === 'string') {
        return message.content.length;
    }
    if (!Array.isArray(message.content)) return chars;

    for (const part of message.content) {
        if ('text' in part && typeof part.text === 'string') {
            chars += part.text.length;
        } else if ('output' in part) {
            chars += toolResultOutputToText(part.output).length;
        } else if ('input' in part) {
            chars += JSON.stringify(part.input)?.length ?? 0;
        }
    }
    return chars;
}

/**
 * 汇总多条消息的近似字符数。
 *
 * @param messages 待统计的模型消息列表。
 * @returns 消息列表的近似字符总数。
 */
function countMessagesChars(messages: ModelMessage[]): number {
    let chars = 0;
    for (const message of messages) {
        chars += countMessageChars(message);
    }
    return chars;
}

/**
 * 按字符数和中文安全系数估算消息列表的 token 占用。
 *
 * @param messages 待估算的模型消息列表。
 * @returns 估算得到的 token 数。
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
    const chars = countMessagesChars(messages);
    // 4 chars per token, with 1.2x safety factor for Chinese
    return Math.ceil((chars / 4) * 1.2);
}

// ── Layer 2: Dynamic Tool Result Truncation ──────────

interface TruncationConfig {
    /** 单个工具结果允许保留的最大字符数。 */
    maxSingleResult: number;
    /** 所有上下文允许使用的工具结果字符预算。 */
    contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
    maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2), // 50% of window, 2 chars/token
    contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4), // 75% of window, 4 chars/token
};

/**
 * 先截断超大的单个工具结果，再压缩总量超预算的旧结果。
 *
 * @param messages 当前会话消息列表。
 * @param config 工具结果截断和总预算配置。
 * @returns 处理后的消息列表及各类处理数量。
 */
export function truncateToolResults(
    messages: ModelMessage[],
    config: TruncationConfig = DEFAULT_TRUNCATION,
): { messages: ModelMessage[]; truncated: number; compacted: number } {
    let truncated = 0;
    let compacted = 0;

    // Pass 1: single-result truncation (Head/Tail 60/40)
    let result = messages.map((msg) => {
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        const newContent = msg.content.map((part: any) => {
            if (!part.output) return part;
            const outputText = toolResultOutputToText(part.output);
            if (outputText.length <= config.maxSingleResult) return part;

            truncated++;
            const maxChars = config.maxSingleResult;
            const headSize = Math.floor(maxChars * 0.6);
            const tailSize = Math.floor(maxChars * 0.4);
            const head = outputText.slice(0, headSize);
            const tail = outputText.slice(-tailSize);

            return {
                ...part,
                output: textToolResultOutput(
                    `${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`,
                ),
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
                    (s, p) =>
                        s +
                        (p.output
                            ? toolResultOutputToText(p.output).length
                            : (p.text as string)?.length || 0),
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
                (s: number, p: any) => s + (p.output ? toolResultOutputToText(p.output).length : 0),
                0,
            );
            result[i] = {
                ...msg,
                content: (msg.content as any[]).map((p: any) => ({
                    ...p,
                    output: textToolResultOutput(
                        `[compacted: ${toolName} output removed to free context]`,
                    ),
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
    /** 触发软清理的结果存活时间（毫秒）。 */
    softTTLMs: number;
    /** 触发硬清理的结果存活时间（毫秒）。 */
    hardTTLMs: number;
    /** 软清理时保留的头尾字符数。 */
    keepHeadTail: number;
}

const DEFAULT_TTL: TTLConfig = {
    softTTLMs: 5 * 60 * 1000, // 5 minutes
    hardTTLMs: 10 * 60 * 1000, // 10 minutes
    keepHeadTail: 1500, // chars to keep in soft prune
};

export interface PruneResult {
    /** 清理后的消息列表。 */
    messages: ModelMessage[];
    /** 被软清理的工具结果数量。 */
    softPruned: number;
    /** 被硬清理的工具结果数量。 */
    hardPruned: number;
}

/**
 * 按消息时间戳清理过期工具结果，同时保留错误结果和用户/助手消息。
 *
 * @param messages 当前会话消息列表。
 * @param timestamps 消息索引到写入时间的映射。
 * @param config 软清理、硬清理和保留长度配置。
 * @returns 清理后的消息列表及各类清理数量。
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
            .map((p: any) => (p.output ? toolResultOutputToText(p.output) : ''))
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
                    output: textToolResultOutput(`[tool result expired: ${toolName}]`),
                })),
            };
        }

        // Soft prune: keep head + tail, replace middle
        if (age >= config.softTTLMs) {
            const newContent = msg.content.map((part: any) => {
                if (!part.output) return part;
                const outputText = toolResultOutputToText(part.output);
                if (outputText.length <= config.keepHeadTail * 2) return part;

                softPruned++;
                const head = outputText.slice(0, config.keepHeadTail);
                const tail = outputText.slice(-config.keepHeadTail);
                const removed = outputText.length - config.keepHeadTail * 2;

                return {
                    ...part,
                    output: textToolResultOutput(
                        `${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`,
                    ),
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
    /** 完成防御处理后的消息列表。 */
    messages: ModelMessage[];
    /** 防御处理后的 token 估算值。 */
    tokenEstimate: number;
    /** 被单条结果截断的数量。 */
    truncated: number;
    /** 因总预算超限而被压缩的数量。 */
    compacted: number;
    /** 被软清理的工具结果数量。 */
    softPruned: number;
    /** 被硬清理的工具结果数量。 */
    hardPruned: number;
}

/**
 * 依次执行工具结果截断、TTL 清理和最终 token 估算。
 *
 * @param messages 当前会话消息列表。
 * @param timestamps 消息索引到写入时间的映射。
 * @returns 防御处理后的消息和统计结果。
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
