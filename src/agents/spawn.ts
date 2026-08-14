import { type ModelMessage, streamText } from 'ai';
import type { ToolRegistry } from '../tools/registry.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnRequest } from './types.js';

export interface SpawnContext {
    /** 子 Agent 调用时使用的 AI SDK 模型实例。 */
    model: any;
    /** 提供给子 Agent 的工具注册表。 */
    registry: ToolRegistry;
    /** 负责运行限制与状态追踪的子 Agent 注册表。 */
    agentRegistry: SubAgentRegistry;
    /** 构建当前父 Agent 系统提示词的回调。 */
    buildSystem: () => string;
    /** 发起方当前所在的嵌套深度。 */
    currentDepth: number;
}

const SUB_AGENT_MAX_STEPS = 10;
const EXCLUDED_TOOLS = new Set(['spawn_agent']);

const AGENT_COLORS = [
    '\x1b[36m', // cyan
    '\x1b[33m', // yellow
    '\x1b[35m', // magenta
    '\x1b[32m', // green
    '\x1b[34m', // blue
];
const RESET = '\x1b[0m';

/**
 * 为子 Agent 生成带颜色的终端日志标签。
 *
 * @param index 子 Agent 在本批任务中的索引。
 * @param runId 本次执行的运行 ID。
 * @returns
 */
function agentTag(index: number, runId: string): string {
    const color = AGENT_COLORS[index % AGENT_COLORS.length];
    return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

/**
 * 启动单个子 Agent，驱动其工具调用循环并记录最终状态。
 *
 * @param request 待执行的子 Agent 请求。
 * @param ctx 运行所需的模型、工具与注册表上下文。
 * @param index 子 Agent 在当前批次中的索引，用于日志标识。
 * @returns 子 Agent 的最终文本结果或失败说明。
 */
export async function spawnAgent(
    request: SpawnRequest,
    ctx: SpawnContext,
    index = 0,
): Promise<string> {
    const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
    if (!ok) return `[spawn] 拒绝: ${reason}`;

    const runId = ctx.agentRegistry.generateId();
    const tag = agentTag(index, runId);
    const run = {
        id: runId,
        task: request.task,
        status: 'running' as const,
        depth: ctx.currentDepth + 1,
        startedAt: new Date().toISOString(),
    };
    ctx.agentRegistry.register(run);

    const timeout = request.timeout || 60000;
    const maxSteps = 30;
    const ac = new AbortController();
    console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

    const messages: ModelMessage[] = [{ role: 'user', content: request.task }];

    try {
        const system =
            ctx.buildSystem() +
            '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
            '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';

        const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);
        const timer = setTimeout(() => ac.abort(), timeout);

        try {
            let step = 0;
            while (step < maxSteps) {
                step++;
                const isLastStep = step === maxSteps;
                console.log(`  ${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`);
                if (isLastStep) {
                    messages.push({
                        role: 'user',
                        content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。',
                    });
                }
                const result = streamText({
                    model: ctx.model,
                    system,
                    tools,
                    toolChoice: isLastStep ? 'none' : 'auto',
                    messages,
                    maxRetries: 0,
                    abortSignal: ac.signal,
                    providerOptions: { openai: { parallelToolCalls: true } },
                    onError: () => {},
                });
                let hasToolCall = false;
                for await (const part of result.fullStream) {
                    if (part.type === 'tool-call') {
                        hasToolCall = true;
                        const argsPreview = JSON.stringify(part.input).slice(0, 80);
                        console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
                    }
                }
                const response = await result.response;
                messages.push(...response.messages);
                if (!hasToolCall) break;
            }
        } finally {
            clearTimeout(timer);
        }

        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        let result = '(无输出)';
        if (lastAssistant) {
            if (typeof lastAssistant.content === 'string') {
                result = lastAssistant.content;
            } else if (Array.isArray(lastAssistant.content)) {
                result =
                    lastAssistant.content
                        .filter((p: any) => p.type === 'text')
                        .map((p: any) => p.text)
                        .join('') || '(无输出)';
            }
        }

        ctx.agentRegistry.complete(runId, result);
        console.log(`  ${tag} 完成 ✓ (${result.length} 字符)`);
        return result;
    } catch (err: any) {
        const isAbort = err.name === 'AbortError' || ac.signal.aborted;
        const errorMsg = isAbort ? `执行超时 (${timeout / 1000}s)` : err.message || String(err);
        ctx.agentRegistry.fail(runId, errorMsg);
        console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);
        if (isAbort) {
            const partial = [...messages].reverse().find((m) => m.role === 'assistant');
            if (partial) {
                const text =
                    typeof partial.content === 'string'
                        ? partial.content
                        : Array.isArray(partial.content)
                          ? partial.content
                                .filter((p: any) => p.type === 'text')
                                .map((p: any) => p.text)
                                .join('')
                          : '';
                if (text) return `[部分结果] ${text}`;
            }
        }
        return `[sub-agent 执行失败] ${errorMsg}`;
    }
}

/**
 * 在剩余并发额度内批量执行子 Agent 请求，并为超额请求返回拒绝结果。
 *
 * @param requests 待并行执行的子 Agent 请求列表。
 * @param ctx 运行所需的模型、工具与注册表上下文。
 * @returns 与已处理请求对应的任务及结果列表。
 */
export async function spawnParallel(
    requests: SpawnRequest[],
    ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
    const maxConcurrent = ctx.agentRegistry.getConfig().maxConcurrent;
    const activeCount = ctx.agentRegistry.getActiveRuns().length;
    const available = maxConcurrent - activeCount;
    if (available <= 0) {
        return requests.map((r) => ({
            task: r.task,
            result: `[spawn] 拒绝: 已达最大并发数 ${maxConcurrent}`,
        }));
    }
    const toRun = requests.slice(0, available);
    const rejected = requests.slice(available);
    if (rejected.length > 0) {
        console.log(
            `  ⚠ 请求 ${requests.length} 个子 Agent，但最大并发为 ${maxConcurrent}，只执行前 ${toRun.length} 个`,
        );
    }
    console.log(`\n  ┌─ 派发 ${toRun.length} 个子 Agent 并行执行 ─┐`);
    const results = await Promise.all(
        toRun.map(async (req, i) => {
            const result = await spawnAgent(req, ctx, i);
            return { task: req.task, result };
        }),
    );
    for (const r of rejected) {
        results.push({
            task: r.task,
            result: `[spawn] 拒绝: 超出最大并发数 ${maxConcurrent}，本次未执行`,
        });
    }
    console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
    return results;
}
