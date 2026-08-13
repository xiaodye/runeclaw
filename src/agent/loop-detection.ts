import { createHash } from 'node:crypto';

// --- 类型定义 ---

/**
 * 单次工具调用在滑动窗口中的指纹记录，用于识别重复调用与无进展循环。
 */
export interface ToolCallRecord {
    /** 被调用的工具名称，用于按工具维度聚合检测。 */
    toolName: string;

    /** 工具参数的稳定哈希，用于判断是否重复提交相同输入。 */
    argsHash: string;

    /** 工具结果的稳定哈希，缺省表示结果尚未回填。 */
    resultHash?: string;

    /** 记录写入时间戳，单位为毫秒。 */
    timestamp: number;
}

/** 循环检测器的命中类型，用于区分重复、乒乓和全局熔断场景。 */
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

/**
 * 循环检测结果；未卡住时只返回 false，命中时携带处置级别和提示文案。
 */
export type DetectionResult =
    | {
          /** 表示当前调用未触发循环保护。 */
          stuck: false;
      }
    | {
          /** 表示当前调用已触发某类循环保护。 */
          stuck: true;

          /** 提醒强度；critical 会终止 Agent 循环。 */
          level: 'warning' | 'critical';

          /** 实际命中的检测器类型。 */
          detector: DetectorKind;

          /** 命中计数，用于展示重复或交替发生的次数。 */
          count: number;

          /** 面向 Agent 或终端输出的中文提示。 */
          message: string;
      };

// --- 配置 ---

const HISTORY_SIZE = 30; // 滑动窗口大小
const WARNING_THRESHOLD = 5; // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8; // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10; // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---

/**
 * 将任意 JSON-like 值序列化为 key 顺序稳定的字符串，保证等价输入拥有一致指纹。
 *
 * @param value 待序列化的未知值。
 * @returns 稳定排序后的字符串表示。
 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

/**
 * 生成短 SHA-256 指纹，降低日志和历史窗口中的存储长度。
 *
 * @param input 待计算哈希的稳定字符串。
 * @returns 截断后的十六进制哈希。
 */
function hash(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 为工具名和参数组合生成调用指纹，用于比较同类调用是否重复。
 *
 * @param toolName 被调用的工具名称。
 * @param params 工具调用参数。
 * @returns 带工具名前缀的调用指纹。
 */
export function hashToolCall(toolName: string, params: unknown): string {
    return `${toolName}:${hash(stableStringify(params))}`;
}

/**
 * 为工具结果生成稳定指纹，用于判断重复调用是否仍然没有新进展。
 *
 * @param result 工具返回结果。
 * @returns 结果内容的短哈希。
 */
export function hashResult(result: unknown): string {
    return hash(stableStringify(result));
}

// --- 滑动窗口 ---

const history: ToolCallRecord[] = [];

/**
 * 记录一次工具调用，并维护固定长度的滑动历史窗口。
 *
 * @param toolName 被调用的工具名称。
 * @param params 工具调用参数。
 */
export function recordCall(toolName: string, params: unknown): void {
    history.push({
        toolName,
        argsHash: hashToolCall(toolName, params),
        timestamp: Date.now(),
    });
    if (history.length > HISTORY_SIZE) history.shift();
}

/**
 * 将工具执行结果回填到最近一次匹配的调用记录上。
 *
 * @param toolName 被调用的工具名称。
 * @param params 工具调用参数，用于匹配调用指纹。
 * @param result 工具返回结果。
 */
export function recordResult(toolName: string, params: unknown, result: unknown): void {
    const argsHash = hashToolCall(toolName, params);
    const resultH = hashResult(result);
    for (let i = history.length - 1; i >= 0; i--) {
        if (
            history[i].toolName === toolName &&
            history[i].argsHash === argsHash &&
            !history[i].resultHash
        ) {
            history[i].resultHash = resultH;
            break;
        }
    }
}

/**
 * 清空循环检测历史，通常在一次新的 Agent 会话开始前调用。
 */
export function resetHistory(): void {
    history.length = 0;
}

// --- 检测器 ---

/**
 * 统计同一工具调用在结果不变时连续无进展的次数。
 *
 * @param toolName 被检测的工具名称。
 * @param argsHash 当前工具参数指纹。
 * @returns 最近连续无进展次数。
 */
function getNoProgressStreak(toolName: string, argsHash: string): number {
    let streak = 0;
    let lastResultHash: string | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i];
        if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
        if (!r.resultHash) continue;
        if (!lastResultHash) {
            lastResultHash = r.resultHash;
            streak = 1;
            continue;
        }
        if (r.resultHash !== lastResultHash) break;
        streak++;
    }
    return streak;
}

/**
 * 检测最近调用是否在两个参数指纹之间交替震荡。
 *
 * @param currentHash 当前即将执行的参数指纹。
 * @returns 包含当前调用后的交替次数；未形成乒乓时返回 0。
 */
function getPingPongCount(currentHash: string): number {
    if (history.length < 3) return 0;
    const last = history[history.length - 1];
    let otherHash: string | undefined;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].argsHash !== last.argsHash) {
            otherHash = history[i].argsHash;
            break;
        }
    }
    if (!otherHash) return 0;
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const expected = count % 2 === 0 ? last.argsHash : otherHash;
        if (history[i].argsHash !== expected) break;
        count++;
    }
    if (currentHash === otherHash && count >= 2) return count + 1;
    return 0;
}

// --- 主检测函数 ---

/**
 * 基于历史窗口判断当前工具调用是否触发重复、乒乓或熔断保护。
 *
 * @param toolName 被检测的工具名称。
 * @param params 当前工具调用参数。
 * @returns 检测结果，命中时包含级别、次数和提示文案。
 */
export function detect(toolName: string, params: unknown): DetectionResult {
    const argsHash = hashToolCall(toolName, params);
    const noProgress = getNoProgressStreak(toolName, argsHash);

    if (noProgress >= BREAKER_THRESHOLD) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'global_circuit_breaker',
            count: noProgress,
            message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
        };
    }

    const pingPong = getPingPongCount(argsHash);
    if (pingPong >= CRITICAL_THRESHOLD) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'ping_pong',
            count: pingPong,
            message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
        };
    }
    if (pingPong >= WARNING_THRESHOLD) {
        return {
            stuck: true,
            level: 'warning',
            detector: 'ping_pong',
            count: pingPong,
            message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
        };
    }

    const recentCount = history.filter(
        (h) => h.toolName === toolName && h.argsHash === argsHash,
    ).length;
    if (recentCount >= CRITICAL_THRESHOLD) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'generic_repeat',
            count: recentCount,
            message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
        };
    }
    if (recentCount >= WARNING_THRESHOLD) {
        return {
            stuck: true,
            level: 'warning',
            detector: 'generic_repeat',
            count: recentCount,
            message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
        };
    }

    return { stuck: false };
}
