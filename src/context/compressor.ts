import { generateText, type ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

/**
 * 按中英文混合文本的经验比例估算消息 token 数。
 *
 * @param messages 待估算的模型消息列表。
 * @returns 估算得到的 token 数，向上取整。
 */
function estimateTokens(messages: ModelMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            chars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if ('text' in part && typeof part.text === 'string') {
                    chars += part.text.length;
                } else if ('output' in part) {
                    chars += toolResultOutputToText(part.output).length;
                }
            }
        }
    }
    return Math.ceil(chars / 4);
}

// ── Layer 1: Microcompact ────────────────────────────

const CLEARABLE_TOOLS = new Set([
    'read_file',
    'bash',
    'grep',
    'glob',
    'list_directory',
    'edit_file',
    'write_file',
]);
const KEEP_RECENT_TOOL_RESULTS = 3;

/**
 * 清理较早且可安全丢弃的工具结果，保留最近几次结果以维持上下文连续性。
 *
 * @param messages 当前会话消息列表。
 * @returns 清理后的消息列表及被清理的结果数量。
 */
export function microcompact(messages: ModelMessage[]): {
    messages: ModelMessage[];
    cleared: number;
} {
    let cleared = 0;
    const toolResultIndices: number[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'tool' && Array.isArray(msg.content)) {
            toolResultIndices.push(i);
        }
    }

    const toClear = toolResultIndices.slice(
        0,
        Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
    );

    const result = messages.map((msg, idx) => {
        if (!toClear.includes(idx)) return msg;
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        const toolName = (msg.content[0] as any)?.toolName || 'unknown';
        if (!CLEARABLE_TOOLS.has(toolName)) return msg;

        cleared++;
        return {
            ...msg,
            content: msg.content.map((part: any) => ({
                ...part,
                output: textToolResultOutput('[tool result cleared]'),
            })),
        };
    });

    return { messages: result, cleared };
}

// ── Layer 2: LLM Summarization ───────────────────────

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

const CONTEXT_TOKEN_THRESHOLD = 300;
const KEEP_RECENT_MESSAGES = 6;

export interface CompactionResult {
    /** 压缩后继续交给模型使用的消息列表。 */
    messages: ModelMessage[];
    /** 对被移出历史的内容生成的结构化摘要。 */
    summary: string;
    /** 本次压缩移除的原始消息数量。 */
    compressedCount: number;
}

/**
 * 在上下文超过阈值时调用模型摘要旧消息，并保留最近对话继续执行。
 *
 * @param model 用于生成摘要的 AI SDK 模型实例。
 * @param messages 当前完整会话消息列表。
 * @param existingSummary 上一次压缩产生的摘要，可选。
 * @returns 压缩后的消息、最新摘要和压缩数量。
 */
export async function summarize(
    model: any,
    messages: ModelMessage[],
    existingSummary?: string,
): Promise<CompactionResult> {
    const tokenEstimate = estimateTokens(messages);
    if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD || messages.length <= KEEP_RECENT_MESSAGES) {
        return { messages, summary: existingSummary || '', compressedCount: 0 };
    }

    const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

    // Align to user message boundary
    let alignedIdx = splitIdx;
    while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {
        alignedIdx--;
    }
    if (alignedIdx === 0) {
        return { messages, summary: existingSummary || '', compressedCount: 0 };
    }

    const toCompress = messages.slice(0, alignedIdx);
    const toKeep = messages.slice(alignedIdx);

    const conversationText = toCompress
        .map((msg) => {
            const content =
                typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content
                            .map((part) =>
                                'text' in part
                                    ? part.text
                                    : 'output' in part
                                      ? toolResultOutputToText(part.output)
                                      : '',
                            )
                            .join('')
                      : '';
            return content ? `**${msg.role}**: ${content}` : '';
        })
        .filter(Boolean)
        .join('\n\n');

    if (!conversationText.trim()) {
        return { messages, summary: existingSummary || '', compressedCount: 0 };
    }

    const userPrompt = existingSummary
        ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
        : conversationText;

    try {
        const { text: summary } = await generateText({
            model,
            system: COMPRESS_PROMPT,
            prompt: userPrompt,
        });

        const summaryMessage: ModelMessage = {
            role: 'user',
            content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
        };

        const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];

        return {
            messages: newMessages,
            summary,
            compressedCount: toCompress.length,
        };
    } catch (err) {
        console.error('[Compaction] LLM 摘要失败:', err);
        return { messages, summary: existingSummary || '', compressedCount: 0 };
    }
}

export { estimateTokens };
