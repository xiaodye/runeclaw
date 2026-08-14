import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 各家模型的 prompt cache 计费规则（单位：$ / 1M tokens，2026-05 数据）。
 *
 * 命中折扣不是行业默认 10x，每家差异不小：
 * - Claude：cache read = 10% input；write 5min = 125%、1h = 200%
 * - OpenAI：自动缓存，命中折扣按模型分档（4o 系列 50%，GPT-5 / 4.1 系列 25%）
 * - Gemini：cache read = 10% input（explicit 模式按存储时长另收费，这里没列）
 * - DeepSeek：cache hit = 10% miss，没有写入费、没有 TTL 概念
 * - Qwen：implicit 20%、explicit 10%（字段跟 Anthropic 一样是 `cache_control: ephemeral`）
 * - Kimi：自动模式 25%
 * - Doubao：显式 cache，命中价 = 40% miss
 *
 * 加新模型直接扩这张表就行。
 */
export interface ModelPricing {
    /** cache miss 时的输入价格，单位 $ / 1M tokens。 */
    input: number; // $ / 1M input tokens (cache miss)
    /** 输出 token 价格，单位 $ / 1M tokens。 */
    output: number; // $ / 1M output tokens
    /** 写入 prompt cache 的价格，单位 $ / 1M tokens。 */
    cacheWrite: number; // $ / 1M tokens written to cache
    /** 命中 prompt cache 的读取价格，单位 $ / 1M tokens。 */
    cacheRead: number; // $ / 1M tokens read from cache (hit)
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
    // Anthropic（最新主力，2026 上半年发布的 4.7 系列）
    'claude-opus-4-7': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
    'claude-sonnet-4-7': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
    // OpenAI（GPT-5 系列；GPT-5.5 默认 24h extended cache）
    'gpt-5-5': { input: 5.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.5 },
    'gpt-5': { input: 5.0, output: 15.0, cacheWrite: 5.0, cacheRead: 1.25 },
    // Google（Gemini 3 系列，最新 preview）
    'gemini-3-pro': { input: 2.5, output: 12.0, cacheWrite: 2.5, cacheRead: 0.625 },
    'gemini-3-flash': { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.075 },
    // 国产
    'deepseek-v3-2': { input: 0.27, output: 1.1, cacheWrite: 0.27, cacheRead: 0.027 },
    'qwen3-6-plus': { input: 0.4, output: 1.2, cacheWrite: 0.4, cacheRead: 0.04 },
    'kimi-k2-6': { input: 0.6, output: 2.5, cacheWrite: 0.6, cacheRead: 0.15 },
    'doubao-2-0-pro': { input: 0.3, output: 0.9, cacheWrite: 0.3, cacheRead: 0.12 },
    // 课程内 mock，用 Haiku 4.5 同档价格
    'mock-model': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
};

export interface StepUsage {
    /** 本次调用的非 cache 输入 token 数。 */
    inputTokens: number;
    /** 本次调用的输出 token 数。 */
    outputTokens: number;
    /** 本次调用命中 cache 的输入 token 数。 */
    cacheReadTokens: number;
    /** 本次调用写入 cache 的 token 数。 */
    cacheWriteTokens: number;
}

export interface StepRecord extends StepUsage {
    /** 记录创建时的 Unix 毫秒时间戳。 */
    ts: number;
    /** 本次调用使用的模型 id。 */
    model: string;
    /** 按当前价格表计算出的本次调用成本。 */
    cost: number;
}

export class UsageTracker {
    /** 当前进程内累计的调用记录。 */
    private steps: StepRecord[] = [];
    /** 可选 JSONL 日志路径，设置后每步记录会追加写入。 */
    private logPath?: string;

    /**
     * 创建用量追踪器，并在需要时初始化日志目录。
     *
     * @param logPath 可选 JSONL 日志文件路径。
     */
    constructor(logPath?: string) {
        this.logPath = logPath;
        if (logPath) mkdirSync(dirname(logPath), { recursive: true });
    }

    /**
     * 记录一次模型调用用量并计算成本。
     *
     * @param model 模型 id，用于查找计费表。
     * @param usage 规范化后的 token 用量。
     * @returns
     */
    record(model: string, usage: StepUsage): StepRecord {
        const cost = computeCost(model, usage);
        const record: StepRecord = { ts: Date.now(), model, cost, ...usage };
        this.steps.push(record);

        if (this.logPath) {
            appendFileSync(this.logPath, JSON.stringify(record) + '\n');
        }
        return record;
    }

    /**
     * 汇总当前进程内所有调用的 token、成本和 cache 收益。
     *
     * @returns
     */
    totals() {
        const t = this.steps.reduce(
            (a, s) => ({
                inputTokens: a.inputTokens + s.inputTokens,
                outputTokens: a.outputTokens + s.outputTokens,
                cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
                cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
                cost: a.cost + s.cost,
            }),
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
        );
        const totalInputLike = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
        const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0;
        // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
        const baselineCost = (() => {
            let c = 0;
            for (const s of this.steps) {
                const p = PRICE_TABLE[s.model] || PRICE_TABLE['mock-model'];
                const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
                c += (inputLike * p.input) / 1_000_000;
                c += (s.outputTokens * p.output) / 1_000_000;
            }
            return c;
        })();
        return {
            ...t,
            hitRate,
            baselineCost,
            savedCost: baselineCost - t.cost,
            steps: this.steps.length,
        };
    }

    /**
     * 返回最近 n 条调用记录。
     *
     * @param n 需要读取的记录数量。
     * @returns
     */
    recent(n: number): StepRecord[] {
        return this.steps.slice(-n);
    }
}

/**
 * 根据模型价格表计算单次调用成本，未知模型使用 mock-model 价格兜底。
 *
 * @param model 模型 id。
 * @param usage 规范化后的 token 用量。
 * @returns
 */
export function computeCost(model: string, usage: StepUsage): number {
    const p = PRICE_TABLE[model] || PRICE_TABLE['mock-model'];
    return (
        (usage.inputTokens * p.input +
            usage.outputTokens * p.output +
            usage.cacheReadTokens * p.cacheRead +
            usage.cacheWriteTokens * p.cacheWrite) /
        1_000_000
    );
}

/**
 * 把 AI SDK 返回的 usage 对象规范化成四类 token。
 *
 * AI SDK v5 把 cache read 标准化到顶层 `cachedInputTokens`（OpenAI、DashScope 都映射到这里）。
 * cache write 没有 AI SDK 标准字段，Anthropic provider 元数据用 `cacheCreationInputTokens`。
 * 这里把两个来源都兜一遍，以后接新 provider 就在对应位置补一行。
 *
 * @param usage AI SDK 或 provider 返回的原始 usage 对象。
 * @returns
 */
export function normalizeUsage(usage: any): StepUsage {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const cacheRead =
        usage.cachedInputTokens ?? // AI SDK 标准字段
        usage.providerMetadata?.openai?.cachedTokens ?? // OpenAI 原生
        0;

    const cacheWrite =
        usage.cacheCreationInputTokens ?? // Anthropic SDK 直接挂顶层
        usage.providerMetadata?.anthropic?.cacheCreationInputTokens ?? // AI SDK 走 provider 元数据
        0;

    // OpenAI 把 cached tokens 含在 inputTokens 总数里 → 减出来；Anthropic 单列 → 不用减
    let inputTokens = usage.inputTokens ?? 0;
    if (cacheRead && inputTokens >= cacheRead) inputTokens -= cacheRead;

    return {
        inputTokens: Math.max(0, inputTokens),
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
    };
}
