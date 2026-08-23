import type { ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';
import { summarize } from './compressor.js';

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

/** 上下文 token 超过该阈值时，TTL 清理后仍超则触发 LLM 摘要压缩（约窗口 75%）。 */
export const COMPACT_TOKEN_THRESHOLD = Math.floor(CONTEXT_WINDOW * 0.75);

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

// ── Layer 2: TTL Pruning ─────────────────────────────

/** 默认保留最近 5 个工具结果不被 TTL 清理。 */
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;

/**
 * 找出最近 keepRecent 个工具结果消息的索引（从末尾往前数）。
 *
 * @param messages 当前会话消息列表。
 * @param keepRecent 需要保留的最近工具结果数量。
 * @returns 受保护的工具结果消息索引集合。
 */
function recentToolResultIndices(messages: ModelMessage[], keepRecent: number): Set<number> {
    const protectedIndices = new Set<number>();
    let count = 0;
    for (let i = messages.length - 1; i >= 0 && count < keepRecent; i--) {
        if (messages[i].role === 'tool') {
            protectedIndices.add(i);
            count++;
        }
    }
    return protectedIndices;
}

interface TTLConfig {
    /** 触发软清理的结果存活时间（毫秒）。 */
    softTTLMs: number;
    /** 触发硬清理的结果存活时间（毫秒）。 */
    hardTTLMs: number;
    /** 软清理时保留的头尾字符数。 */
    keepHeadTail: number;
    /** 保留最近几个工具结果、绝不修剪的数量。 */
    keepRecentToolResults?: number;
}

const DEFAULT_TTL: TTLConfig = {
    softTTLMs: 5 * 60 * 1000, // 5 minutes
    hardTTLMs: 10 * 60 * 1000, // 10 minutes
    keepHeadTail: 1500, // chars to keep in soft prune
    keepRecentToolResults: DEFAULT_KEEP_RECENT_TOOL_RESULTS,
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
 * 按消息时间戳清理过期工具结果，同时保留错误结果、最近工具结果和用户/助手消息。
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
    const keepRecent = config.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
    const protectedIndices = recentToolResultIndices(messages, keepRecent);

    const result = messages.map((msg, idx) => {
        // Only prune tool results, never user/assistant messages
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        // 最近几个工具结果属于活跃推理链，绝不修剪。
        if (protectedIndices.has(idx)) return msg;

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
    /** 被软清理的工具结果数量。 */
    softPruned: number;
    /** 被硬清理的工具结果数量。 */
    hardPruned: number;
}

/**
 * 执行 TTL 清理并估算最终 token 数。
 *
 * @param messages 当前会话消息列表。
 * @param timestamps 消息索引到写入时间的映射。
 * @returns 防御处理后的消息和统计结果。
 */
export function applyDefense(
    messages: ModelMessage[],
    timestamps: Map<number, number>,
): DefenseResult {
    // Layer 2: TTL prune old tool results
    const prune = ttlPrune(messages, timestamps);
    const result = prune.messages;

    // Layer 1: estimate final token count
    const tokenEstimate = estimateMessageTokens(result);

    return {
        messages: result,
        tokenEstimate,
        softPruned: prune.softPruned,
        hardPruned: prune.hardPruned,
    };
}

// ── Layer 3: LLM Compression Fallback ────────────────

/** 包含 LLM 摘要压缩结果的防御统计。 */
export interface CompactResult extends DefenseResult {
    /** 本次生成的对话压缩摘要。 */
    summary: string;
    /** 被摘要压缩移除的原始消息数量。 */
    compressedCount: number;
}

/**
 * TTL 清理后若上下文仍超过预算，则调用模型把旧对话摘要压缩。
 *
 * @param model 用于生成摘要的 AI SDK 模型实例。
 * @param messages 当前会话消息列表。
 * @param timestamps 消息索引到写入时间的映射。
 * @returns 压缩后的消息及各项统计。
 */
export async function compactContext(
    model: any,
    messages: ModelMessage[],
    timestamps: Map<number, number>,
): Promise<CompactResult> {
    // 第一步：TTL 清理过期工具结果
    const defended = applyDefense(messages, timestamps);
    let result = defended.messages;
    let summary = '';
    let compressedCount = 0;

    // 第二步：仍超预算则走 LLM 摘要压缩
    if (defended.tokenEstimate > COMPACT_TOKEN_THRESHOLD) {
        const compacted = await summarize(model, result);
        result = compacted.messages;
        summary = compacted.summary;
        compressedCount = compacted.compressedCount;
    }

    return {
        ...defended,
        messages: result,
        tokenEstimate: estimateMessageTokens(result),
        summary,
        compressedCount,
    };
}
