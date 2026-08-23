import { LanguageModelUsage, streamText, type ModelMessage } from 'ai';
import { ToolRegistry } from '../tools/registry';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection';
import { isRetryable, calculateDelay, sleep } from './retry';
import { type UsageTracker, normalizeUsage } from '../usage/tracker';
import {
    compactContext,
    estimateMessageTokens,
    COMPACT_TOKEN_THRESHOLD,
} from '../context/defense.js';

const MAX_STEPS = 15;
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 150_000;

/**
 * 驱动模型按“生成响应、调用工具、记录结果”的节奏循环执行，直到任务完成或触发保护边界。
 *
 * @param model AI SDK 兼容的语言模型实例。
 * @param registry 当前会话可用的工具注册表。
 * @param messages 会话消息列表，循环过程中会追加模型与工具消息。
 * @param system 系统提示词，用于约束本轮 Agent 行为。
 * @param tracker 可选的用量追踪器，用于累计 token 与成本。
 */
export async function agentLoop(
    model: any,
    registry: ToolRegistry,
    messages: ModelMessage[],
    system: string,
    tracker?: UsageTracker,
) {
    let step = 0;
    resetHistory();

    // 消息索引 → 写入时间戳，供 TTL 清理使用
    const timestamps = new Map<number, number>();
    for (let i = 0; i < messages.length; i++) timestamps.set(i, Date.now());
    const pushMessage = (msg: ModelMessage) => {
        messages.push(msg);
        timestamps.set(messages.length - 1, Date.now());
    };

    while (step < MAX_STEPS) {
        step++;
        console.log(`\n--- Step ${step} ---`);

        let hasToolCall = false;
        let fullText = '';
        let shouldBreak = false;
        let lastToolCall: { name: string; input: unknown } | null = null;
        let stepResponse: any;
        let stepUsage: LanguageModelUsage;

        for (let attempt = 1; ; attempt++) {
            try {
                const result = streamText({
                    model,
                    system,
                    tools: registry.toAISDKFormat(),
                    messages,
                    maxRetries: 0,
                    providerOptions: { openai: { parallelToolCalls: true } },
                    onError: () => {},
                });

                for await (const part of result.fullStream) {
                    switch (part.type) {
                        case 'text-delta':
                            process.stdout.write(part.text);
                            fullText += part.text;
                            break;

                        case 'tool-call': {
                            hasToolCall = true;
                            lastToolCall = { name: part.toolName, input: part.input };
                            console.log(
                                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
                            );

                            const detection = detect(part.toolName, part.input);
                            if (detection.stuck) {
                                console.log(`  ${detection.message}`);
                                if (detection.level === 'critical') {
                                    shouldBreak = true;
                                } else {
                                    pushMessage({
                                        role: 'user' as const,
                                        content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                                    });
                                }
                            }
                            recordCall(part.toolName, part.input);
                            break;
                        }

                        case 'tool-result': {
                            const output =
                                typeof part.output === 'string'
                                    ? part.output
                                    : JSON.stringify(part.output);
                            const preview =
                                output.length > 120 ? output.slice(0, 120) + '...' : output;
                            console.log(`  [结果: ${part.toolName}] ${preview}`);
                            if (lastToolCall) {
                                recordResult(lastToolCall.name, lastToolCall.input, part.output);
                            }
                            break;
                        }
                    }
                }

                stepResponse = await result.response;
                stepUsage = await result.usage;
                break;
            } catch (error) {
                if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
                const delay = calculateDelay(attempt);
                console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`);
                await sleep(delay);
                hasToolCall = false;
                fullText = '';
                shouldBreak = false;
                lastToolCall = null;
            }
        }

        if (shouldBreak) {
            console.log('\n[循环检测触发，Agent 已停止]');
            break;
        }

        for (const msg of stepResponse!.messages) pushMessage(msg);

        // 把 usage 喂给 tracker；tracker 内部按四类 token 分别累加并算 cost
        const norm = normalizeUsage(stepUsage);
        const stepRecord = tracker?.record(model?.modelId || 'mock-model', norm);

        // cache 命中时才打印一行简洁状态，让 cache hit 立刻可见
        if (stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
            const tag =
                norm.cacheReadTokens > 0
                    ? `\x1b[38;5;36m✓ cache hit\x1b[0m`
                    : `\x1b[38;5;220m✎ cache write\x1b[0m`;
            const detail =
                norm.cacheReadTokens > 0
                    ? `read ${norm.cacheReadTokens}`
                    : `write ${norm.cacheWriteTokens}`;
            console.log(`  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`);
        }

        // 上下文超过窗口预算时：TTL 清理后仍超则 LLM 摘要压缩
        if (estimateMessageTokens(messages) > COMPACT_TOKEN_THRESHOLD) {
            console.log(`  [Token] ~${estimateMessageTokens(messages)} 超预算，触发压缩...`);
            const compacted = await compactContext(model, messages, timestamps);
            messages.splice(0, messages.length, ...compacted.messages);
            timestamps.clear();
            for (let i = 0; i < messages.length; i++) timestamps.set(i, Date.now());
            console.log(
                `  [压缩] TTL 软剪 ${compacted.softPruned}/硬清 ${compacted.hardPruned}，摘要移除 ${compacted.compressedCount} 条 → ~${compacted.tokenEstimate} tokens`,
            );
        }

        if (!hasToolCall) {
            if (fullText) console.log();
            break;
        }

        console.log('  → 继续下一步...');
    }

    if (step >= MAX_STEPS) {
        console.log('\n[达到最大步数]');
    }
}
